import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { contentPeople, contentPosts, contentTodos, type ContentPerson, type ContentPost, type ContentTodo } from './db/schema';
import { CONTENT_PLATFORMS, CONTENT_STATUSES, FORMATS, PLATFORM_LABEL, type ContentPlatform, type ContentStatus, type PersonView, type PostView, type TodoView } from './content-meta';

export * from './content-meta';
import { validDay } from './holidays';
import { istDay } from './tasks';

/**
 * Marketing's content calendar. A post has a date (scheduledOn, '' while it is only a draft with no date)
 * and a status, and they are kept apart: changing one never clears the other. The few rules that tie
 * them together are in checkPost, so the editor, the cards and dragging all follow the same ones.
 */
export type PostInput = { title: string; platform: ContentPlatform; format: string; caption: string; scheduledOn: string; status: ContentStatus; dependencyNote: string; assigneeId: number | null; driveLink: string };

export const toView = (p: ContentPost): PostView => ({
  id: p.id,
  title: p.title,
  platform: p.platform,
  format: p.format,
  caption: p.caption,
  scheduledOn: p.scheduledOn,
  status: p.status,
  dependencyNote: p.dependencyNote,
  postedAt: p.postedAt ? p.postedAt.toISOString() : null,
  assigneeId: p.assigneeId,
  driveLink: p.driveLink,
});

export const toPersonView = (p: ContentPerson): PersonView => ({ id: p.id, name: p.name });
export const toTodoView = (t: ContentTodo): TodoView => ({ id: t.id, text: t.text, scheduledOn: t.scheduledOn, done: t.done });

/** A Drive link: an https address on google.com (drive.google.com, docs.google.com...), or empty. */
export function checkDriveLink(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return { ok: true, value: '' };
  if (v.length > 500) return { ok: false, error: 'The Drive link is too long.' };
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && (u.hostname === 'google.com' || u.hostname.endsWith('.google.com'))) return { ok: true, value: u.toString() };
  } catch {
    // falls through to the message
  }
  return { ok: false, error: 'The Drive link must be a Google Drive address (https://drive.google.com/…).' };
}

export type Checked = { ok: true; value: PostInput } | { ok: false; error: string };

/**
 * Checks a post as it would be saved, against the one it replaces (if any):
 * - a title, a real platform, a format that platform has;
 * - a date is a real day or empty;
 * - Scheduled needs a date (choose one first); Posted without a date takes today's;
 * - a Posted post keeps its date: mark it not posted first to move it.
 * Nothing is dropped silently: a status change keeps the date, a date change keeps the status and the note.
 */
export function checkPost(raw: Partial<Record<keyof PostInput, unknown>>, existing?: Pick<ContentPost, 'status' | 'scheduledOn'> | null, today = istDay()): Checked {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const title = s(raw.title);
  if (!title) return { ok: false, error: 'Give it a title.' };
  if (title.length > 160) return { ok: false, error: 'The title is too long (160 characters at most).' };
  const platform = s(raw.platform) as ContentPlatform;
  if (!CONTENT_PLATFORMS.includes(platform)) return { ok: false, error: 'Choose Instagram or LinkedIn.' };
  const format = s(raw.format) || 'post';
  if (!FORMATS[platform].includes(format)) return { ok: false, error: `${PLATFORM_LABEL[platform]} has no "${format}" format.` };
  const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
  if (caption.length > 5000) return { ok: false, error: 'The caption is too long (5,000 characters at most).' };
  const status = s(raw.status) as ContentStatus;
  if (!CONTENT_STATUSES.includes(status)) return { ok: false, error: 'Choose one of the statuses.' };
  let scheduledOn = s(raw.scheduledOn);
  if (scheduledOn && !validDay(scheduledOn)) return { ok: false, error: 'That is not a date.' };
  const dependencyNote = s(raw.dependencyNote).slice(0, 300);
  const drive = checkDriveLink(raw.driveLink);
  if (!drive.ok) return drive;
  const assigneeId = raw.assigneeId === null || raw.assigneeId === undefined || raw.assigneeId === '' ? null : Number(raw.assigneeId);
  if (assigneeId !== null && !Number.isInteger(assigneeId)) return { ok: false, error: 'Choose someone from the People list.' };
  if (status === 'scheduled' && !scheduledOn) return { ok: false, error: 'Choose a date before setting it to Scheduled.' };
  if (existing?.status === 'posted' && status === 'posted' && scheduledOn !== existing.scheduledOn) return { ok: false, error: 'It is already posted: mark it as not posted first to change its date.' };
  if (status === 'posted' && !scheduledOn) scheduledOn = today;
  return { ok: true, value: { title, platform, format, caption, scheduledOn, status, dependencyNote, assigneeId, driveLink: drive.value } };
}

/**
 * "Both" platforms: the same piece made once for Instagram and once for LinkedIn (two posts, each then moved, edited and
 * posted on its own). Both are checked first, so either both are made or neither is.
 */
export async function createPostForBoth(db: Db, raw: Partial<Record<keyof PostInput, unknown>>, now = new Date()): Promise<{ ok: true; posts: ContentPost[] } | { ok: false; error: string }> {
  const checks = CONTENT_PLATFORMS.map((platform) => checkPost({ ...raw, platform }, null, istDay(now)));
  const bad = checks.find((c) => !c.ok);
  if (bad && !bad.ok) return bad;
  if (!(await assigneeExists(db, checks[0].ok ? checks[0].value.assigneeId : null))) return { ok: false, error: 'That person is no longer on the People list.' };
  const posts: ContentPost[] = [];
  for (const c of checks) {
    if (!c.ok) continue;
    const [post] = await db.insert(contentPosts).values({ ...c.value, postedAt: postedAtFor(c.value.status, null, now) }).returning();
    posts.push(post);
  }
  return { ok: true, posts };
}

/** Marking Posted records when; taking it back clears that (the post was not posted after all). */
const postedAtFor = (status: ContentStatus, existing: Pick<ContentPost, 'postedAt'> | null | undefined, now: Date) => (status === 'posted' ? (existing?.postedAt ?? now) : null);

export async function listPosts(db: Db): Promise<ContentPost[]> {
  return db.select().from(contentPosts).orderBy(asc(contentPosts.scheduledOn), asc(contentPosts.id));
}

/** An assignee must be someone on the People list. */
async function assigneeExists(db: Db, id: number | null): Promise<boolean> {
  if (id === null) return true;
  return (await db.select({ id: contentPeople.id }).from(contentPeople).where(eq(contentPeople.id, id))).length > 0;
}

export async function createPost(db: Db, raw: Partial<Record<keyof PostInput, unknown>>, now = new Date()): Promise<{ ok: true; post: ContentPost } | { ok: false; error: string }> {
  const c = checkPost(raw, null, istDay(now));
  if (!c.ok) return c;
  if (!(await assigneeExists(db, c.value.assigneeId))) return { ok: false, error: 'That person is no longer on the People list.' };
  const [post] = await db.insert(contentPosts).values({ ...c.value, postedAt: postedAtFor(c.value.status, null, now) }).returning();
  return { ok: true, post };
}

/** Saves what the editor sends (every field), or a change to one or two (a status, a date): the rest is kept as it is. */
export async function updatePost(db: Db, id: number, raw: Partial<Record<keyof PostInput, unknown>>, now = new Date()): Promise<{ ok: true; post: ContentPost } | { ok: false; error: string }> {
  const [existing] = await db.select().from(contentPosts).where(eq(contentPosts.id, id));
  if (!existing) return { ok: false, error: 'That post no longer exists. Reload the page.' };
  const merged = {
    title: existing.title,
    platform: existing.platform,
    format: existing.format,
    caption: existing.caption,
    scheduledOn: existing.scheduledOn,
    status: existing.status,
    dependencyNote: existing.dependencyNote,
    assigneeId: existing.assigneeId,
    driveLink: existing.driveLink,
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
  };
  const c = checkPost(merged, existing, istDay(now));
  if (!c.ok) return c;
  if (!(await assigneeExists(db, c.value.assigneeId))) return { ok: false, error: 'That person is no longer on the People list.' };
  const [post] = await db
    .update(contentPosts)
    .set({ ...c.value, postedAt: postedAtFor(c.value.status, existing, now), updatedAt: now })
    .where(eq(contentPosts.id, id))
    .returning();
  return { ok: true, post };
}

export async function deletePost(db: Db, id: number): Promise<void> {
  await db.delete(contentPosts).where(eq(contentPosts.id, id));
}

export type ContentCounts = { posted: number; instagramPosted: number; linkedinPosted: number; scheduled: number; draft: number; pendingApproval: number; waiting: number };

/** The Overview's numbers, counted from the posts' statuses (a post is counted once, by its status). */
export async function contentCounts(db: Db): Promise<ContentCounts> {
  const rows = await db.select({ status: contentPosts.status, platform: contentPosts.platform, n: sql<number>`count(*)::int` }).from(contentPosts).groupBy(contentPosts.status, contentPosts.platform);
  const n = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + Number(r.n), 0);
  return {
    posted: n((r) => r.status === 'posted'),
    instagramPosted: n((r) => r.status === 'posted' && r.platform === 'instagram'),
    linkedinPosted: n((r) => r.status === 'posted' && r.platform === 'linkedin'),
    scheduled: n((r) => r.status === 'scheduled'),
    draft: n((r) => r.status === 'draft'),
    pendingApproval: n((r) => r.status === 'pending_approval'),
    waiting: n((r) => r.status === 'waiting_dependency'),
  };
}

// ─── People ───

export async function listPeople(db: Db): Promise<ContentPerson[]> {
  return db.select().from(contentPeople).orderBy(asc(contentPeople.name), asc(contentPeople.id));
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

export async function addPerson(db: Db, name: unknown): Promise<{ ok: true; person: ContentPerson } | { ok: false; error: string }> {
  const n = cleanName(name);
  if (!n) return { ok: false, error: 'Enter a name.' };
  if (n.length > 80) return { ok: false, error: 'The name is too long (80 characters at most).' };
  if ((await listPeople(db)).some((p) => p.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: `${n} is already on the list.` };
  const [person] = await db.insert(contentPeople).values({ name: n }).returning();
  return { ok: true, person };
}

export async function renamePerson(db: Db, id: number, name: unknown): Promise<{ ok: true; person: ContentPerson } | { ok: false; error: string }> {
  const n = cleanName(name);
  if (!n) return { ok: false, error: 'Enter a name.' };
  if (n.length > 80) return { ok: false, error: 'The name is too long (80 characters at most).' };
  if ((await listPeople(db)).some((p) => p.id !== id && p.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: `${n} is already on the list.` };
  const [person] = await db.update(contentPeople).set({ name: n }).where(eq(contentPeople.id, id)).returning();
  return person ? { ok: true, person } : { ok: false, error: 'That person no longer exists. Reload the page.' };
}

/** Removes the person; content assigned to them stays, unassigned. */
export async function removePerson(db: Db, id: number): Promise<void> {
  await db.update(contentPosts).set({ assigneeId: null }).where(eq(contentPosts.assigneeId, id));
  await db.delete(contentPeople).where(eq(contentPeople.id, id));
}

// ─── To-dos ───

/** The to-dos for the calendar. Completed ones are deleted for good here too, so none is left behind by a closed tab. */
export async function listTodos(db: Db): Promise<ContentTodo[]> {
  await db.delete(contentTodos).where(eq(contentTodos.done, true));
  return db.select().from(contentTodos).orderBy(asc(contentTodos.scheduledOn), asc(contentTodos.id));
}

export async function addTodo(db: Db, text: unknown): Promise<{ ok: true; todo: ContentTodo } | { ok: false; error: string }> {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!t) return { ok: false, error: 'Write the to-do first.' };
  if (t.length > 120) return { ok: false, error: 'Keep a to-do to one short line (120 characters at most).' };
  const [todo] = await db.insert(contentTodos).values({ text: t }).returning();
  return { ok: true, todo };
}

/** A to-do dragged to a date, or back to the side list with ''. */
export async function moveTodo(db: Db, id: number, date: unknown): Promise<{ ok: true; todo: ContentTodo } | { ok: false; error: string }> {
  const d = typeof date === 'string' ? date.trim() : '';
  if (d && !validDay(d)) return { ok: false, error: 'That is not a date.' };
  const [todo] = await db.update(contentTodos).set({ scheduledOn: d }).where(eq(contentTodos.id, id)).returning();
  return todo ? { ok: true, todo } : { ok: false, error: 'That to-do no longer exists. Reload the page.' };
}

/** Ticks it off (it stays on screen a moment, then the page deletes it for good). */
export async function completeTodo(db: Db, id: number): Promise<boolean> {
  const rows = await db.update(contentTodos).set({ done: true }).where(eq(contentTodos.id, id)).returning({ id: contentTodos.id });
  return rows.length > 0;
}

export async function deleteTodo(db: Db, id: number): Promise<void> {
  await db.delete(contentTodos).where(eq(contentTodos.id, id));
}

/** What is to be posted on a day: its content that isn't posted yet. */
export async function dueOn(db: Db, days: string[]): Promise<ContentPost[]> {
  const rows = await db.select().from(contentPosts).orderBy(asc(contentPosts.scheduledOn), asc(contentPosts.id));
  return rows.filter((p) => days.includes(p.scheduledOn) && p.status !== 'posted');
}
