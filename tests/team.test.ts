import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests } from '@/lib/db';
import { leads, tasks, users, attendance, activities } from '@/lib/db/schema';
import { checkPassword, hashPassword, normaliseUsername } from '@/lib/passwords';
import { verifyLogin } from '@/lib/users';
import { createSession, readSession } from '@/lib/auth';
import { assignUnowned, canReassign } from '@/lib/assign';
import { addWorkingDays, dayCounts, ensureSequences, firstWorkingDay, istDay, loadTodayTasks, planSequence, unattendedInbound } from '@/lib/tasks';
import { clockIn, clockOut, getAttendance, recordPresence } from '@/lib/attendance';
import { callOpener, linkedinNote, whatsappLink } from '@/lib/talk';

beforeEach(() => {
  resetDbForTests();
  process.env.DATABASE_URL = 'memory://';
  process.env.APP_PASSWORD = 'test-secret';
});

const lead = (company: string, extra: Partial<typeof leads.$inferInsert> = {}) => ({ company, status: 'Awaiting Approval' as const, contactName: 'Ravi Shah', contactTitle: 'Plant Head', contactEmail: 'ravi@x.com', ...extra });

describe('logins', () => {
  it('creates the four team members with the starting password, case-insensitively', async () => {
    const db = await getDb();
    const rows = await db.select().from(users).orderBy(users.id);
    expect(rows.map((u) => u.username)).toEqual(['parimal@inveck', 'anuradha@inveck', 'anchal@inveck', 'puja@inveck']);
    expect(rows.every((u) => u.mustChangePassword && u.role === 'bda')).toBe(true);
    expect((await verifyLogin(db, 'Parimal@inveck', 'inveck123'))?.name).toBe('Parimal');
    expect((await verifyLogin(db, ' PUJA ', 'inveck123'))?.name).toBe('Puja');
    expect(await verifyLogin(db, 'parimal@inveck', 'wrong')).toBeNull();
    expect(await verifyLogin(db, 'nobody@inveck', 'inveck123')).toBeNull();
  });

  it('hashes passwords with a salt and checks them', async () => {
    const a = await hashPassword('hunter2hunter2');
    const b = await hashPassword('hunter2hunter2');
    expect(a).not.toBe(b);
    expect(await checkPassword('hunter2hunter2', a)).toBe(true);
    expect(await checkPassword('hunter2hunter3', a)).toBe(false);
    expect(normaliseUsername('Anchal')).toBe('anchal@inveck');
  });

  it('signs sessions and rejects forged, expired or foreign ones', async () => {
    const token = await createSession('u3');
    expect(await readSession(token)).toBe('u3');
    expect(await readSession(token.replace('u3', 'u1'))).toBeNull();
    expect(await readSession(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'))).toBeNull();
    expect(await readSession(undefined)).toBeNull();
    expect(await readSession('admin.1.abc')).toBeNull();
    process.env.APP_PASSWORD = 'other';
    expect(await readSession(token)).toBeNull();
  });
});

describe('round-robin', () => {
  it('gives leads to the team in turn and carries on where it stopped', async () => {
    const db = await getDb();
    await db.insert(leads).values([lead('A'), lead('B'), lead('C'), lead('D'), lead('E')]);
    expect(await assignUnowned(db)).toBe(5);
    const owners = async () => (await db.select().from(leads).orderBy(leads.id)).map((l) => l.ownerId);
    const ids = (await db.select().from(users).orderBy(users.id)).map((u) => u.id);
    expect(await owners()).toEqual([ids[0], ids[1], ids[2], ids[3], ids[0]]);
    await db.insert(leads).values([lead('F'), lead('G')]);
    await assignUnowned(db);
    expect((await owners()).slice(5)).toEqual([ids[1], ids[2]]);
    expect(await assignUnowned(db)).toBe(0);
  });
});

describe('one owner per lead', () => {
  it('never gives a lead to two people, even when two assignments run at once', async () => {
    const db = await getDb();
    await db.insert(leads).values(Array.from({ length: 40 }, (_, i) => lead(`Company ${i}`)));
    const [a, b] = await Promise.all([assignUnowned(db), assignUnowned(db)]);
    expect(a + b).toBeGreaterThanOrEqual(40);
    const rows = await db.select().from(leads);
    const team = new Set((await db.select().from(users)).map((u) => u.id));
    expect(rows.every((l) => l.ownerId !== null && team.has(l.ownerId))).toBe(true);
    // A second pass finds nothing left to give out.
    expect(await assignUnowned(db)).toBe(0);
  });

  it('lets a team member hand over only their own leads; an administrator can move any', () => {
    const bda = { id: 2, role: 'bda' as const };
    expect(canReassign(bda, { ownerId: 2 })).toBe(true);
    expect(canReassign(bda, { ownerId: null })).toBe(true);
    expect(canReassign(bda, { ownerId: 3 })).toBe(false);
    expect(canReassign({ id: 0, role: 'admin' }, { ownerId: 3 })).toBe(true);
  });
});

describe('the P1 sequence', () => {
  it('plans day 1 morning, then call + WhatsApp + email each round, skipping weekends', () => {
    // 2026-09-25 is a Friday.
    expect(firstWorkingDay('2026-09-26')).toBe('2026-09-28');
    expect(addWorkingDays('2026-09-25', 1)).toBe('2026-09-28');
    const plan = planSequence('2026-09-25', true);
    expect(plan.map((t) => `${t.kind}:${t.step}:${t.dueDate}:${t.slot}`)).toEqual([
      'linkedin:Day 1:2026-09-25:morning',
      'whatsapp:Day 1:2026-09-25:morning',
      'call:Day 1 morning:2026-09-25:morning',
      'call:Follow-up 1:2026-09-25:evening',
      'whatsapp:Follow-up 1:2026-09-25:evening',
      'email:Follow-up 1:2026-09-25:evening',
      'call:Follow-up 2:2026-09-28:day',
      'whatsapp:Follow-up 2:2026-09-28:day',
      'email:Follow-up 2:2026-09-28:day',
      'call:Follow-up 3:2026-09-29:day',
      'whatsapp:Follow-up 3:2026-09-29:day',
      'email:Follow-up 3:2026-09-29:day',
    ]);
    expect(planSequence('2026-09-25', false).some((t) => t.kind === 'email')).toBe(false);
  });

  it('plans once per lead with a decision-maker, for its owner only', async () => {
    const db = await getDb();
    await db.insert(leads).values([lead('Has contact'), lead('No contact', { contactName: '' }), lead('Disqualified', { status: 'Disqualified' })]);
    await assignUnowned(db);
    expect(await ensureSequences(db, '2026-09-28')).toBe(1);
    expect(await ensureSequences(db, '2026-09-28')).toBe(0);
    const made = await db.select().from(tasks);
    expect(made).toHaveLength(12);
    expect(new Set(made.map((t) => t.leadId)).size).toBe(1);
  });

  it('lists what is due for one person, priority callbacks first, and stops when the lead moves on', async () => {
    const db = await getDb();
    await db.insert(leads).values(lead('Acme'));
    await assignUnowned(db);
    await ensureSequences(db, '2026-09-28');
    const [l] = await db.select().from(leads);
    const today = await loadTodayTasks(db, l.ownerId!, '2026-09-28');
    expect(today.map((t) => t.task.step)).toEqual(['Day 1', 'Day 1', 'Day 1 morning', 'Follow-up 1', 'Follow-up 1', 'Follow-up 1']);
    await db.insert(tasks).values({ leadId: l.id, ownerId: l.ownerId!, kind: 'call', title: 'Promised callback', step: 'Promised callback', dueDate: '2026-09-28', priority: true });
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-28'))[0].task.step).toBe('Promised callback');
    // Next day the unfinished ones are overdue.
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-29')).some((t) => t.overdue)).toBe(true);
    await db.update(leads).set({ status: 'Replied' }).where(eq(leads.id, l.id));
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-28')).map((t) => t.task.step)).toEqual(['Promised callback']);
  });

  it('counts connected calls as conversations, not attempts', async () => {
    const db = await getDb();
    await db.insert(leads).values([lead('Acme'), lead('Kirtane & Pandit', { segment: 'CA Firms' })]);
    await assignUnowned(db);
    const ls = await db.select().from(leads).orderBy(leads.id);
    const now = new Date();
    const call = (leadId: number, ownerId: number, outcome: string) => ({ leadId, ownerId, kind: 'call' as const, title: 'c', dueDate: istDay(), doneAt: now, outcome });
    await db.insert(tasks).values([call(ls[0].id, 1, 'connected'), call(ls[0].id, 1, 'no_answer'), call(ls[0].id, 1, 'skipped'), call(ls[1].id, 1, 'connected'), { ...call(ls[1].id, 1, 'sent'), kind: 'linkedin' as const }]);
    expect(await dayCounts(db, 1)).toMatchObject({ connectedCalls: 2, caConnectedCalls: 1, callAttempts: 3, linkedinSent: 1 });
  });
});

describe('inbound leads', () => {
  it('flags inbound leads nobody touched after two hours', async () => {
    const db = await getDb();
    const old = new Date(Date.now() - 3 * 3_600_000);
    const [a, b, c] = await db
      .insert(leads)
      .values([lead('Untouched', { inbound: true, createdAt: old }), lead('Touched', { inbound: true, createdAt: old }), lead('Fresh', { inbound: true })])
      .returning({ id: leads.id });
    await db.insert(activities).values({ leadId: b.id, kind: 'call', text: 'Spoke' });
    expect((await unattendedInbound(db, null)).map((l) => l.id)).toEqual([a.id]);
    expect(c.id).toBeGreaterThan(0);
  });
});

describe('attendance', () => {
  it('records first and last seen, and clock in and out, once a day', async () => {
    const db = await getDb();
    const day = istDay();
    await recordPresence(db, 1, new Date('2026-09-28T03:30:00Z'));
    await recordPresence(db, 1, new Date('2026-09-28T03:32:00Z'));
    await recordPresence(db, 1, new Date('2026-09-28T04:30:00Z'));
    const rows = await db.select().from(attendance);
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeenAt.toISOString()).toBe('2026-09-28T03:30:00.000Z');
    expect(rows[0].lastSeenAt.toISOString()).toBe('2026-09-28T04:30:00.000Z');
    const at = new Date('2026-09-28T03:45:00Z');
    await clockIn(db, 1, at);
    await clockIn(db, 1, new Date('2026-09-28T05:00:00Z'));
    await clockOut(db, 1, new Date('2026-09-28T12:00:00Z'));
    const row = await getAttendance(db, 1, '2026-09-28');
    expect(row?.clockInAt?.toISOString()).toBe(at.toISOString());
    expect(row?.clockOutAt?.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('talk tracks', () => {
  const l = { contactName: 'Dr. Anil Kumar', company: 'Acme', segment: 'Manufacturing & 3PL', signals: [{ headline: 'Acme opens a new plant in Chakan.', date: '', url: '', source: '', kind: 'new_facility' }] };
  it('opens with the news, greets by first name and never uses emojis', () => {
    const opener = callOpener(l, 'Puja');
    expect(opener).toContain('Hi Anil, this is Puja from INVECK.');
    expect(opener).toContain('I saw that Acme opens a new plant in Chakan.');
    expect(/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(opener)).toBe(false);
  });
  it('keeps the LinkedIn note within 200 characters', () => {
    expect(linkedinNote({ contactName: 'Anil Kumar', segment: 'CA Firms' }, 'Anuradha').length).toBeLessThanOrEqual(200);
  });
  it('builds WhatsApp links for Indian numbers', () => {
    expect(whatsappLink('098765 43210', 'Hi there')).toBe('https://wa.me/919876543210?text=Hi%20there');
    expect(whatsappLink('+91 98765 43210', 'x')).toContain('wa.me/919876543210');
    expect(whatsappLink('12345', 'x')).toBe('');
  });
});
