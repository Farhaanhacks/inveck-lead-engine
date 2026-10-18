import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { contentPosts, type ContentPost } from './db/schema';
import { CONTENT_PLATFORMS, CONTENT_STATUSES, FORMATS, PLATFORM_LABEL, type ContentPlatform, type ContentStatus, type PostView } from './content-meta';

export * from './content-meta';
import { validDay } from './holidays';
import { istDay } from './tasks';

/**
 * Marketing's content calendar. A post has a date (scheduledOn, '' while it is only a draft with no date)
 * and a status, and they are kept apart: changing one never clears the other. The few rules that tie
 * them together are in checkPost, so the editor, the cards and dragging all follow the same ones.
 */
export type PostInput = { title: string; platform: ContentPlatform; format: string; caption: string; scheduledOn: string; status: ContentStatus; dependencyNote: string };

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
});

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
  if (status === 'scheduled' && !scheduledOn) return { ok: false, error: 'Choose a date before setting it to Scheduled.' };
  if (existing?.status === 'posted' && status === 'posted' && scheduledOn !== existing.scheduledOn) return { ok: false, error: 'It is already posted: mark it as not posted first to change its date.' };
  if (status === 'posted' && !scheduledOn) scheduledOn = today;
  return { ok: true, value: { title, platform, format, caption, scheduledOn, status, dependencyNote } };
}

/** Marking Posted records when; taking it back clears that (the post was not posted after all). */
const postedAtFor = (status: ContentStatus, existing: Pick<ContentPost, 'postedAt'> | null | undefined, now: Date) => (status === 'posted' ? (existing?.postedAt ?? now) : null);

export async function listPosts(db: Db): Promise<ContentPost[]> {
  return db.select().from(contentPosts).orderBy(asc(contentPosts.scheduledOn), asc(contentPosts.id));
}

export async function createPost(db: Db, raw: Partial<Record<keyof PostInput, unknown>>, now = new Date()): Promise<{ ok: true; post: ContentPost } | { ok: false; error: string }> {
  const c = checkPost(raw, null, istDay(now));
  if (!c.ok) return c;
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
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
  };
  const c = checkPost(merged, existing, istDay(now));
  if (!c.ok) return c;
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
