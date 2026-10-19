import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { contentPosts, users } from '@/lib/db/schema';
import { createSession } from '@/lib/auth';
import { addDays, checkPost, contentCounts, createPost, monthWeeks, updatePost, weekOf } from '@/lib/content-calendar';
import { ensureMarketingUser, hashPassword, MARKETING_PASSWORD, MARKETING_USERNAME } from '@/lib/passwords';
import { checkPassword, verifyLogin } from '@/lib/users';

// Who is calling, for the server actions; and the page/redirect hooks Next provides.
const who = { current: { id: 0, role: 'marketing' as 'marketing' | 'admin' | 'bda', name: 'Marketing', username: 'marketing@inveck', mustChangePassword: true } };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: (n: string, v: string) => void cookieJar.set(n, v), delete: (n: string) => void cookieJar.delete(n), get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/users', async (orig) => {
  const real = await orig<typeof import('@/lib/users')>();
  const crm = async () => (who.current.role === 'marketing' ? null : who.current);
  return {
    ...real,
    getSessionUser: async () => who.current,
    getCurrentUser: crm,
    requireSessionUser: async () => who.current,
    requireUser: async () => {
      const u = await crm();
      if (!u) throw new Error('Not logged in');
      return u;
    },
  };
});

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  process.env.APP_PASSWORD = 'admin-test-password';
  resetDbForTests();
  db = await getDb();
  cookieJar.clear();
  const [m] = await db.select().from(users).where(eq(users.username, MARKETING_USERNAME));
  who.current = { id: m.id, role: 'marketing', name: 'Marketing', username: m.username, mustChangePassword: true };
});

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, x);
  return f;
};

describe('the Marketing profile', () => {
  it('exists with its own role, the starting password (hashed) and must change it', async () => {
    const [m] = await db.select().from(users).where(eq(users.username, 'marketing@inveck'));
    expect(m).toMatchObject({ name: 'Marketing', role: 'marketing', mustChangePassword: true, active: true });
    expect(m.passwordHash).not.toContain(MARKETING_PASSWORD);
    expect(m.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(await checkPassword('marketinginveck', m.passwordHash)).toBe(true);
    expect((await verifyLogin(db, 'Marketing@Inveck', 'marketinginveck'))?.role).toBe('marketing');
    expect(await verifyLogin(db, 'marketing@inveck', 'wrong')).toBeNull();
  });

  it('is made once, and an existing profile (with a changed password) is never touched', async () => {
    await ensureMarketingUser(db);
    await ensureMarketingUser(db);
    expect((await db.select().from(users).where(eq(users.role, 'marketing')))).toHaveLength(1);
    const changed = await hashPassword('a-new-password-1');
    await db.update(users).set({ passwordHash: changed, mustChangePassword: false }).where(eq(users.username, MARKETING_USERNAME));
    await ensureMarketingUser(db);
    expect((await db.select().from(users).where(eq(users.username, MARKETING_USERNAME)))[0]).toMatchObject({ passwordHash: changed, mustChangePassword: false });
  });

  it('is not one of the sales team: never drawn leads, never listed as a BDA', async () => {
    const { listBdas } = await import('@/lib/users');
    expect((await listBdas(db)).map((b) => b.username)).not.toContain('marketing@inveck');
  });

  it('logs in to the content calendar, with a session the proxy knows as Marketing', async () => {
    const { login } = await import('@/app/actions');
    await expect(login(undefined, form({ username: 'marketing@inveck', password: 'marketinginveck' }))).rejects.toThrow('REDIRECT:/marketing/calendar');
    const { readSession } = await import('@/lib/auth');
    const subject = await readSession(cookieJar.get('inveck_session'));
    expect(subject).toBe(`m${who.current.id}`);
    // Not even a link to a Lead Engine page changes where it lands.
    cookieJar.clear();
    await expect(login(undefined, form({ username: 'marketing@inveck', password: 'marketinginveck', next: '/leads' }))).rejects.toThrow('REDIRECT:/marketing/calendar');
    // A wrong password is refused.
    expect(await login(undefined, form({ username: 'marketing@inveck', password: 'nope' }))).toEqual({ error: 'Wrong username or password.' });
  });

  it('changes its own password like everyone else, and cannot keep the starting one', async () => {
    const { changePasswordAction } = await import('@/app/team-actions');
    expect(await changePasswordAction(undefined, form({ current: 'marketinginveck', next: 'marketinginveck', confirm: 'marketinginveck' }))).toMatchObject({ ok: false });
    expect(await changePasswordAction(undefined, form({ current: 'wrong', next: 'a-fine-password', confirm: 'a-fine-password' }))).toMatchObject({ ok: false });
    expect(await changePasswordAction(undefined, form({ current: 'marketinginveck', next: 'a-fine-password', confirm: 'a-fine-password' }))).toMatchObject({ ok: true });
    expect((await verifyLogin(db, 'marketing@inveck', 'a-fine-password'))?.mustChangePassword).toBe(false);
  });
});

describe('server-side access', () => {
  const request = async (path: string, subject: string | null) =>
    new NextRequest(`http://localhost${path}`, { headers: subject ? { cookie: `inveck_session=${await createSession(subject)}` } : {} });
  const run = async (path: string, subject: string | null) => (await import('@/proxy')).proxy(await request(path, subject));

  it('keeps Marketing to /marketing: every other page and API is refused, even typed in directly', async () => {
    const id = who.current.id;
    for (const path of ['/leads', '/today', '/team', '/settings', '/tracker', '/pipeline', '/contacts', '/', '/account', '/leads/1']) {
      const r = await run(path, `m${id}`);
      expect(r.status, path).toBe(307);
      expect(new URL(r.headers.get('location')!).pathname, path).toBe('/marketing/calendar');
    }
    for (const path of ['/api/tracker/csv', '/api/clients/csv', '/api/attendance', '/api/runs/active']) expect((await run(path, `m${id}`)).status, path).toBe(403);
    // Its own pages go through.
    for (const path of ['/marketing', '/marketing/calendar', '/marketing/overview', '/marketing/account']) expect((await run(path, `m${id}`)).headers.get('x-middleware-next'), path).toBe('1');
  });

  it('keeps the sales team out of /marketing, lets the administrator see everything, and logged-out visitors go to the login', async () => {
    expect(new URL((await run('/marketing/calendar', 'u3')).headers.get('location')!).pathname).toBe('/today');
    expect((await run('/marketing/overview', 'admin')).headers.get('x-middleware-next')).toBe('1');
    expect((await run('/leads', 'admin')).headers.get('x-middleware-next')).toBe('1');
    expect((await run('/leads', 'u3')).headers.get('x-middleware-next')).toBe('1');
    expect(new URL((await run('/marketing/calendar', null)).headers.get('location')!).pathname).toBe('/login');
  });

  it('the Lead Engine treats Marketing as nobody: its actions refuse it', async () => {
    const { addLeadAction, deleteLeadAction } = await import('@/app/actions');
    await expect(addLeadAction(undefined, form({ company: 'Sneaky Co' }))).rejects.toThrow('Not logged in');
    await expect(deleteLeadAction(form({ id: '1' }))).rejects.toThrow('Not logged in');
    const { completeTaskAction, drawNowAction } = await import('@/app/team-actions');
    await expect(completeTaskAction(form({ id: '1', outcome: 'no_answer' }))).rejects.toThrow('Not logged in');
    await expect(drawNowAction()).rejects.toThrow('Not logged in');
  });

  it('only Marketing or an administrator can use the calendar actions; a BDA cannot', async () => {
    const { createPostAction } = await import('@/app/marketing-actions');
    expect((await createPostAction({ title: 'Hello', platform: 'linkedin', format: 'post', status: 'draft' })).ok).toBe(true);
    who.current = { ...who.current, role: 'admin', id: 0, username: 'admin' };
    expect((await createPostAction({ title: 'Admin post', platform: 'instagram', format: 'reel', status: 'draft' })).ok).toBe(true);
    who.current = { ...who.current, role: 'bda', id: 7 };
    await expect(createPostAction({ title: 'Nope', platform: 'instagram', format: 'post', status: 'draft' })).rejects.toThrow('Marketing only');
    const { marketingPage } = await import('@/lib/access');
    await expect(marketingPage()).rejects.toThrow('REDIRECT:/today');
    expect(await db.select().from(contentPosts)).toHaveLength(2);
  });
});

describe('the content rules', () => {
  const base = { title: 'Launch post', platform: 'instagram', format: 'carousel', caption: 'Caption', scheduledOn: '', status: 'draft', dependencyNote: '' } as const;

  it('needs a title, a real platform, a format that platform has and a real date', () => {
    expect(checkPost({ ...base, title: '  ' })).toMatchObject({ ok: false });
    expect(checkPost({ ...base, platform: 'tiktok' })).toMatchObject({ ok: false });
    expect(checkPost({ ...base, platform: 'linkedin', format: 'reel' })).toMatchObject({ ok: false, error: expect.stringContaining('LinkedIn has no "reel"') });
    expect(checkPost({ ...base, scheduledOn: '2026-13-40' })).toMatchObject({ ok: false });
    expect(checkPost({ ...base, status: 'finished' })).toMatchObject({ ok: false });
    expect(checkPost({ ...base, platform: 'linkedin', format: 'article' })).toMatchObject({ ok: true });
  });

  it('is saved to the database with its date and status kept apart', async () => {
    const made = await createPost(db, { ...base });
    if (!made.ok) throw new Error(made.error);
    expect(made.post).toMatchObject({ status: 'draft', scheduledOn: '', postedAt: null });
    // Moving it to a date keeps the status; changing the status keeps the date.
    const moved = await updatePost(db, made.post.id, { scheduledOn: '2026-11-03' });
    expect(moved.ok && moved.post).toMatchObject({ status: 'draft', scheduledOn: '2026-11-03' });
    const approved = await updatePost(db, made.post.id, { status: 'approved' });
    expect(approved.ok && approved.post).toMatchObject({ status: 'approved', scheduledOn: '2026-11-03' });
    // Back to no date (a draft in the side list) keeps the status too.
    const back = await updatePost(db, made.post.id, { scheduledOn: '' });
    expect(back.ok && back.post).toMatchObject({ status: 'approved', scheduledOn: '' });
    expect((await db.select().from(contentPosts))).toHaveLength(1);
  });

  it('Scheduled needs a date, and a post that is Scheduled cannot lose its date', async () => {
    const made = await createPost(db, { ...base });
    if (!made.ok) throw new Error(made.error);
    expect(await updatePost(db, made.post.id, { status: 'scheduled' })).toMatchObject({ ok: false, error: expect.stringContaining('Choose a date') });
    expect((await db.select().from(contentPosts))[0].status).toBe('draft');
    await updatePost(db, made.post.id, { scheduledOn: '2026-11-03', status: 'scheduled' });
    expect(await updatePost(db, made.post.id, { scheduledOn: '' })).toMatchObject({ ok: false });
    expect((await db.select().from(contentPosts))[0]).toMatchObject({ status: 'scheduled', scheduledOn: '2026-11-03' });
  });

  it('Waiting for dependency keeps its note, and the note stays when the status moves on', async () => {
    const made = await createPost(db, { ...base, status: 'waiting_dependency', dependencyNote: 'Waiting for the product photos' });
    if (!made.ok) throw new Error(made.error);
    expect(made.post.dependencyNote).toBe('Waiting for the product photos');
    const next = await updatePost(db, made.post.id, { status: 'pending_approval' });
    expect(next.ok && next.post).toMatchObject({ status: 'pending_approval', dependencyNote: 'Waiting for the product photos' });
  });

  it('marking Posted records when (and a date if it had none); taking it back clears that; a posted date is fixed', async () => {
    const made = await createPost(db, { ...base });
    if (!made.ok) throw new Error(made.error);
    const at = new Date('2026-11-03T05:00:00Z'); // 10:30 India time
    const posted = await updatePost(db, made.post.id, { status: 'posted' }, at);
    if (!posted.ok) throw new Error(posted.error);
    expect(posted.post.postedAt?.toISOString()).toBe(at.toISOString());
    expect(posted.post.scheduledOn).toBe('2026-11-03');
    // Saving again later keeps the first posting time.
    const again = await updatePost(db, made.post.id, { caption: 'Edited after posting' }, new Date('2026-11-04T05:00:00Z'));
    expect(again.ok && again.post.postedAt?.toISOString()).toBe(at.toISOString());
    expect(await updatePost(db, made.post.id, { scheduledOn: '2026-11-09' })).toMatchObject({ ok: false, error: expect.stringContaining('already posted') });
    const undone = await updatePost(db, made.post.id, { status: 'approved' });
    expect(undone.ok && undone.post).toMatchObject({ postedAt: null, status: 'approved', scheduledOn: '2026-11-03' });
  });

  it('counts for the overview by status and platform', async () => {
    const add = (o: Record<string, string>) => createPost(db, { ...base, scheduledOn: '2026-11-03', ...o });
    await add({ platform: 'instagram', status: 'posted' });
    await add({ platform: 'instagram', status: 'posted', format: 'reel' });
    await add({ platform: 'linkedin', status: 'posted', format: 'article' });
    await add({ platform: 'linkedin', status: 'scheduled', format: 'post' });
    await add({ status: 'draft', scheduledOn: '' });
    await add({ status: 'pending_approval' });
    await add({ status: 'waiting_dependency', dependencyNote: 'x' });
    await add({ status: 'approved' });
    expect(await contentCounts(db)).toEqual({ posted: 3, instagramPosted: 2, linkedinPosted: 1, scheduled: 1, draft: 1, pendingApproval: 1, waiting: 1 });
  });

  it('lays out months and weeks (Sunday first)', () => {
    // October 2026 starts on a Thursday and has 31 days: five weeks.
    const weeks = monthWeeks(2026, 9);
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toBe('2026-09-27');
    expect(weeks[0][4]).toBe('2026-10-01');
    expect(weeks.at(-1)!.at(-1)).toBe('2026-10-31');
    expect(weekOf('2026-10-18')).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('people, Drive links and to-dos', () => {
  it('keeps a People list; content is assigned from it, and removing someone leaves their content unassigned', async () => {
    const { addPerson, renamePerson, removePerson, listPeople } = await import('@/lib/content-calendar');
    expect((await addPerson(db, '  ')).ok).toBe(false);
    const a = await addPerson(db, '  Priya   Nair ');
    expect(a.ok && a.person.name).toBe('Priya Nair');
    expect((await addPerson(db, 'priya nair')).ok).toBe(false);
    const b = await addPerson(db, 'Arun');
    if (!a.ok || !b.ok) throw new Error('setup');
    expect((await renamePerson(db, b.person.id, 'Priya Nair')).ok).toBe(false);
    expect((await renamePerson(db, b.person.id, 'Arun K')).ok).toBe(true);

    const made = await createPost(db, { title: 'Reel', platform: 'instagram', format: 'reel', status: 'draft', assigneeId: a.person.id, driveLink: 'https://drive.google.com/file/d/abc/view' });
    if (!made.ok) throw new Error('create');
    expect(made.post).toMatchObject({ assigneeId: a.person.id, driveLink: 'https://drive.google.com/file/d/abc/view' });
    // Someone not on the list can't be assigned.
    expect((await createPost(db, { title: 'X', platform: 'linkedin', format: 'post', status: 'draft', assigneeId: 999 })).ok).toBe(false);
    // A later change of status keeps the assignee and the link.
    const moved = await updatePost(db, made.post.id, { status: 'approved' });
    expect(moved.ok && moved.post).toMatchObject({ assigneeId: a.person.id, driveLink: 'https://drive.google.com/file/d/abc/view' });
    await removePerson(db, a.person.id);
    expect((await db.select().from(contentPosts).where(eq(contentPosts.id, made.post.id)))[0].assigneeId).toBeNull();
    expect((await listPeople(db)).map((p) => p.name)).toEqual(['Arun K']);
  });

  it('accepts only a Google Drive address for the link (or none)', async () => {
    const { checkDriveLink } = await import('@/lib/content-calendar');
    expect(checkDriveLink('')).toEqual({ ok: true, value: '' });
    expect(checkDriveLink('https://drive.google.com/drive/folders/xyz')).toMatchObject({ ok: true });
    expect(checkDriveLink('https://docs.google.com/document/d/1/edit')).toMatchObject({ ok: true });
    for (const bad of ['http://drive.google.com/x', 'https://evil.com/drive.google.com', 'https://notgoogle.com/x', 'javascript:alert(1)', 'drive']) expect(checkDriveLink(bad).ok).toBe(false);
  });

  it('to-dos: added, dragged to a date, completed and then deleted for good', async () => {
    const { addTodo, moveTodo, completeTodo, deleteTodo, listTodos } = await import('@/lib/content-calendar');
    expect((await addTodo(db, '')).ok).toBe(false);
    expect((await addTodo(db, 'x'.repeat(121))).ok).toBe(false);
    const t = await addTodo(db, 'Book the studio\nfor Friday');
    if (!t.ok) throw new Error('todo');
    expect(t.todo).toMatchObject({ text: 'Book the studio for Friday', scheduledOn: '', done: false });
    expect((await moveTodo(db, t.todo.id, 'not-a-date')).ok).toBe(false);
    expect((await moveTodo(db, t.todo.id, '2026-10-23')).ok).toBe(true);
    expect((await listTodos(db))[0]).toMatchObject({ scheduledOn: '2026-10-23' });
    expect(await completeTodo(db, t.todo.id)).toBe(true);
    // A completed one is gone the next time the list is read, even if the page never deleted it.
    expect(await listTodos(db)).toEqual([]);
    const u = await addTodo(db, 'Another');
    if (!u.ok) throw new Error('todo');
    await deleteTodo(db, u.todo.id);
    expect(await listTodos(db)).toEqual([]);
  });

  it('what is due on a day is its content that is not posted yet', async () => {
    const { dueOn } = await import('@/lib/content-calendar');
    await createPost(db, { title: 'Today IG', platform: 'instagram', format: 'post', status: 'scheduled', scheduledOn: '2026-10-20' });
    await createPost(db, { title: 'Today done', platform: 'linkedin', format: 'post', status: 'posted', scheduledOn: '2026-10-20' });
    await createPost(db, { title: 'Tomorrow', platform: 'linkedin', format: 'post', status: 'scheduled', scheduledOn: '2026-10-21' });
    expect((await dueOn(db, ['2026-10-20'])).map((p) => p.title)).toEqual(['Today IG']);
  });

  it('the people and to-do actions are Marketing-only too', async () => {
    const { addPersonAction, addTodoAction, deleteTodoAction } = await import('@/app/marketing-actions');
    expect((await addPersonAction('Sam')).ok).toBe(true);
    expect((await addTodoAction('Check the banner')).ok).toBe(true);
    who.current = { ...who.current, role: 'bda', id: 7 };
    await expect(addPersonAction('Nope')).rejects.toThrow('Marketing only');
    await expect(addTodoAction('Nope')).rejects.toThrow('Marketing only');
    await expect(deleteTodoAction(1)).rejects.toThrow('Marketing only');
  });
});
