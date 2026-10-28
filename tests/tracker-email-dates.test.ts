import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, people, tasks, users } from '@/lib/db/schema';
import { cleanDay, inDayRange } from '@/lib/tracker';
import { cleanEmail } from '@/lib/contact-edit';
import { istDay } from '@/lib/tasks';

const me = { id: 0, role: 'bda' as const, name: 'Puja', username: 'puja@inveck', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

describe('the date filter on the tracker', () => {
  // 10 pm UTC on the 14th is already the 15th in India.
  const at = (iso: string) => new Date(iso);
  it('one date, a range, a start only, an end only; days are Indian days', () => {
    const d = at('2026-11-14T22:00:00Z');
    expect(inDayRange(d, '2026-11-15', '2026-11-15')).toBe(true);
    expect(inDayRange(d, '2026-11-14', '2026-11-14')).toBe(false);
    expect(inDayRange(d, '2026-11-10', '2026-11-16')).toBe(true);
    expect(inDayRange(d, '2026-11-16', '')).toBe(false);
    expect(inDayRange(d, '2026-11-15', '')).toBe(true);
    expect(inDayRange(d, '', '2026-11-14')).toBe(false);
    expect(inDayRange(d, '', '2026-11-15')).toBe(true);
    // Both ends are included.
    expect(inDayRange(at('2026-11-10T06:00:00Z'), '2026-11-10', '2026-11-14')).toBe(true);
    expect(inDayRange(at('2026-11-14T06:00:00Z'), '2026-11-10', '2026-11-14')).toBe(true);
  });
  it('no range means everything; a range leaves out what has no date (not called yet)', () => {
    expect(inDayRange(null, '', '')).toBe(true);
    expect(inDayRange(null, '2026-11-10', '')).toBe(false);
  });
  it('only a real day is taken', () => {
    expect(cleanDay('2026-11-15')).toBe('2026-11-15');
    for (const bad of ['', '15/11/2026', '2026-13-40', '2026-11-15; drop', undefined, 5]) expect(cleanDay(bad)).toBe('');
  });
});

describe('the Email cell on the tracker', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
    me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
  });
  const lead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
    (await db.insert(leads).values({ company: 'Hosur Gears', segment: 'Manufacturing', status: 'Approved', ownerId: me.id, contactName: 'Ravi Kumar', contactEmail: 'ravi@old.in', ...extra }).returning())[0];

  it('takes one address as people write it, and clears with an empty cell', () => {
    expect(cleanEmail('  Ravi@Hosur.IN ')).toBe('ravi@hosur.in');
    expect(cleanEmail('')).toBe('');
    for (const bad of ['ravi', 'ravi@', 'a@b', 'a@b.in, c@d.in', 'a b@c.in']) expect(cleanEmail(bad)).toBeNull();
  });

  it('saves the main contact\'s email, on the lead and the people list, with a timeline entry; nothing else changes', async () => {
    const { updateTrackerEmailAction } = await import('@/app/team-actions');
    const l = await lead({ contactPhone: '9876543210' });
    await db.insert(people).values({ leadId: l.id, name: 'Ravi Kumar', email: 'ravi@old.in', isPrimary: true, source: 'x' });
    expect(await updateTrackerEmailAction(l.id, ' Ravi@New.in ')).toEqual({ ok: true, value: 'ravi@new.in' });
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactEmail: 'ravi@new.in', contactName: 'Ravi Kumar', contactPhone: '9876543210', contactVerifiedAt: null });
    expect((await db.select().from(people).where(eq(people.leadId, l.id)))[0].email).toBe('ravi@new.in');
    expect((await db.select().from(activities).where(eq(activities.leadId, l.id))).some((a) => a.text.includes('ravi@new.in'))).toBe(true);
    // Cleared.
    expect(await updateTrackerEmailAction(l.id, '')).toEqual({ ok: true, value: '' });
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].contactEmail).toBe('');
  });

  it('refuses what is not an address, and a lead that is not yours', async () => {
    const { updateTrackerEmailAction } = await import('@/app/team-actions');
    const l = await lead();
    expect((await updateTrackerEmailAction(l.id, 'not an email')).ok).toBe(false);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].contactEmail).toBe('ravi@old.in');
    const theirs = await lead({ ownerId: me.id + 1 });
    expect((await updateTrackerEmailAction(theirs.id, 'x@y.in')).ok).toBe(false);
    expect((await db.select().from(leads).where(eq(leads.id, theirs.id)))[0].contactEmail).toBe('ravi@old.in');
  });

  it('a first address plans the email steps next to the open calls', async () => {
    const { updateTrackerEmailAction } = await import('@/app/team-actions');
    const l = await lead({ contactEmail: '' });
    await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'call', step: 'Day 1', title: 'Day 1: call', dueDate: istDay(), slot: 'day' });
    expect((await updateTrackerEmailAction(l.id, 'ravi@new.in')).ok).toBe(true);
    const open = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), isNull(tasks.doneAt)));
    expect(open.map((t) => t.kind).sort()).toEqual(['call', 'email']);
  });
});
