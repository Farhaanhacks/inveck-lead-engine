import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests } from '@/lib/db';
import { leads, tasks, users, attendance, activities } from '@/lib/db/schema';
import { checkPassword, hashPassword, normaliseUsername } from '@/lib/passwords';
import { verifyLogin } from '@/lib/users';
import { createSession, readSession } from '@/lib/auth';
import { assignUnowned, canReassign } from '@/lib/assign';
import { addWorkingDays, dayCounts, ensureSequences, firstWorkingDay, istDay, loadTodayTasks, planSequence, unattendedInbound } from '@/lib/tasks';
import { clockIn, clockOut, getAttendance, recordPresence } from '@/lib/attendance';
import { callOpener, linkedinNote, whatsappLink } from '@/lib/talk';

// "Today" is a working day mid-morning in India (Thursday 11:30 IST), whenever the tests run: steps
// due today don't exist at a weekend. Only the date is faked; timers run normally.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  resetDbForTests();
  process.env.DATABASE_URL = 'memory://';
  process.env.APP_PASSWORD = 'test-secret';
});

// A researched, qualified lead whose main contact has been confirmed; tests about unconfirmed contacts say so.
const lead = (company: string, extra: Partial<typeof leads.$inferInsert> = {}) => ({
  company, status: 'Awaiting Approval' as const, contactName: 'Ravi Shah', contactTitle: 'Plant Head', contactEmail: 'ravi@x.com',
  researchSummary: `${company} makes things.`, qualified: true, contactVerifiedAt: new Date(), ...extra,
});

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
    expect(await assignUnowned(db, { everything: true })).toBe(5);
    const owners = async () => (await db.select().from(leads).orderBy(leads.id)).map((l) => l.ownerId);
    const ids = (await db.select().from(users).orderBy(users.id)).map((u) => u.id);
    expect(await owners()).toEqual([ids[0], ids[1], ids[2], ids[3], ids[0]]);
    await db.insert(leads).values([lead('F'), lead('G')]);
    await assignUnowned(db, { everything: true });
    expect((await owners()).slice(5)).toEqual([ids[1], ids[2]]);
    expect(await assignUnowned(db, { everything: true })).toBe(0);
  });
});

describe('one owner per lead', () => {
  it('never gives a lead to two people, even when two assignments run at once', async () => {
    const db = await getDb();
    await db.insert(leads).values(Array.from({ length: 40 }, (_, i) => lead(`Company ${i}`)));
    const [a, b] = await Promise.all([assignUnowned(db, { everything: true }), assignUnowned(db, { everything: true })]);
    expect(a + b).toBeGreaterThanOrEqual(40);
    const rows = await db.select().from(leads);
    const team = new Set((await db.select().from(users)).map((u) => u.id));
    expect(rows.every((l) => l.ownerId !== null && team.has(l.ownerId))).toBe(true);
    // A second pass finds nothing left to give out.
    expect(await assignUnowned(db, { everything: true })).toBe(0);
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
  it('plans every channel at once on day 1, then call + WhatsApp + email each working day', () => {
    // 2026-09-25 is a Friday.
    expect(firstWorkingDay('2026-09-26')).toBe('2026-09-28');
    expect(addWorkingDays('2026-09-25', 1)).toBe('2026-09-28');
    const plan = planSequence('2026-09-25');
    expect(plan.map((t) => `${t.kind}:${t.step}:${t.dueDate}`)).toEqual([
      'call:Day 1:2026-09-25',
      'whatsapp:Day 1:2026-09-25',
      'email:Day 1:2026-09-25',
      'linkedin:Day 1:2026-09-25',
      'call:Follow-up 1:2026-09-28',
      'whatsapp:Follow-up 1:2026-09-28',
      'email:Follow-up 1:2026-09-28',
      'call:Follow-up 2:2026-09-29',
      'whatsapp:Follow-up 2:2026-09-29',
      'email:Follow-up 2:2026-09-29',
      'call:Follow-up 3:2026-09-30',
      'whatsapp:Follow-up 3:2026-09-30',
      'email:Follow-up 3:2026-09-30',
    ]);
  });

  it('plans once per lead with a decision-maker, for its owner only', async () => {
    const db = await getDb();
    await db.insert(leads).values([lead('Has contact'), lead('No contact', { contactName: '' }), lead('Disqualified', { status: 'Disqualified' })]);
    await assignUnowned(db, { everything: true });
    expect(await ensureSequences(db, '2026-09-28')).toBe(1);
    expect(await ensureSequences(db, '2026-09-28')).toBe(0);
    const made = await db.select().from(tasks);
    expect(made).toHaveLength(13);
    expect(new Set(made.map((t) => t.leadId)).size).toBe(1);
  });

  it('lists what is due for one person, priority callbacks first, and stops when the lead moves on', async () => {
    const db = await getDb();
    await db.insert(leads).values(lead('Acme'));
    await assignUnowned(db, { everything: true });
    await ensureSequences(db, '2026-09-28');
    const [l] = await db.select().from(leads);
    const today = await loadTodayTasks(db, l.ownerId!, '2026-09-28');
    expect(today.map((t) => t.task.step)).toEqual(['Day 1', 'Day 1', 'Day 1', 'Day 1']);
    await db.insert(tasks).values({ leadId: l.id, ownerId: l.ownerId!, kind: 'call', title: 'Promised callback', step: 'Promised callback', dueDate: '2026-09-28', priority: true });
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-28'))[0].task.step).toBe('Promised callback');
    // Next day the unfinished ones are overdue.
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-29')).some((t) => t.overdue)).toBe(true);
    // A conversation started: today's steps still get finished.
    await db.update(leads).set({ status: 'Replied' }).where(eq(leads.id, l.id));
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-28')).length).toBe(5);
    // Lost: only the promised callback is left.
    await db.update(leads).set({ status: 'Lost' }).where(eq(leads.id, l.id));
    expect((await loadTodayTasks(db, l.ownerId!, '2026-09-28')).map((t) => t.task.step)).toEqual(['Promised callback']);
  });

  it('counts connected calls as conversations, not attempts', async () => {
    const db = await getDb();
    await db.insert(leads).values([lead('Acme'), lead('Kirtane & Pandit', { segment: 'CA Firms' })]);
    await assignUnowned(db, { everything: true });
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

describe('contact priority (P1/P2/P3)', async () => {
  const { tierOf } = await import('@/lib/tiers');
  const { DEFAULT_ICPS } = await import('@/lib/db/seed');
  const [man, log] = DEFAULT_ICPS;
  it('ranks manufacturing titles however they are written', () => {
    expect(tierOf('Plant Head - Pune', man)).toBe('P1');
    expect(tierOf('Vice President - Operations', man)).toBe('P1');
    expect(tierOf('Assistant Vice President, Operations', man)).toBe('P1');
    expect(tierOf('Head of Supply Chain', man)).toBe('P1');
    expect(tierOf('Managing Director', man)).toBe('P1');
    expect(tierOf('Inventory Manager', man)).toBe('P2');
    expect(tierOf('Deputy General Manager - Purchase', man)).toBe('P2');
    expect(tierOf('Stores Manager', man)).toBe('P3');
    expect(tierOf('GM - HR', man)).toBe('Avoid');
    expect(tierOf('Quality Assurance Head', man)).toBe('Avoid');
    expect(tierOf('Software Engineer', man)).toBe('');
  });
  it('ranks 3PL titles', () => {
    expect(tierOf('National Head - Warehousing', log)).toBe('P1');
    expect(tierOf('Chief Operating Officer', log)).toBe('P1');
    expect(tierOf('Warehouse Manager', log)).toBe('P2');
    expect(tierOf('Store Head', log)).toBe('P3');
  });
  it('covers every industry on the team list', () => {
    for (const word of ['forging', 'cables', 'aerospace', 'pharmaceuticals', 'packaging', 'ceramics', 'medical devices', 'renewable', 'furniture', 'food processing', 'rubber', 'paints', 'petrochemicals'])
      expect(man.industries.toLowerCase()).toContain(word);
  });
});

describe('team report', () => {
  it('counts each person’s calls, connect rate, meetings and attendance in the period', async () => {
    const db = await getDb();
    const { teamReport, periodDays } = await import('@/lib/team-report');
    const [a] = await db.insert(leads).values(lead('Acme')).returning();
    await assignUnowned(db, { everything: true });
    const [l] = await db.select().from(leads).where(eq(leads.id, a.id));
    const owner = l.ownerId!;
    const now = new Date();
    const call = (outcome: string) => ({ leadId: l.id, ownerId: owner, kind: 'call' as const, title: 'c', dueDate: istDay(), doneAt: now, outcome });
    await db.insert(tasks).values([call('connected'), call('no_answer'), call('no_answer'), call('busy'), call('closed')]);
    await db.insert(activities).values({ leadId: l.id, kind: 'stage', stage: 'Meeting Booked', text: 'Meeting booked' });
    await clockIn(db, owner, new Date(Date.now() - 3 * 3_600_000));
    await clockOut(db, owner, now);
    const { from, to } = periodDays('today');
    const r = await teamReport(db, from, to);
    const me = r.people.find((p) => p.id === owner)!;
    expect(me).toMatchObject({ callAttempts: 4, connected: 1, connectRate: 25, meetings: 1, meetingRate: 100, daysPresent: 1, leadsOwned: 1 });
    expect(Math.round(me.minutesClocked)).toBe(180);
    expect(r.attendance[0]).toMatchObject({ name: me.name });
    expect(r.attendance[0].clockOutAt?.getTime()).toBe(now.getTime());
  });
});

describe('morning draw', () => {
  const nine = new Date('2026-09-28T03:30:00Z'); // Monday 09:00 India time

  it('keeps the list for the draw and hands out only inbound leads straight away', async () => {
    const db = await getDb();
    await db.insert(leads).values([lead('Pool'), lead('Inbound', { inbound: true })]);
    expect(await assignUnowned(db)).toBe(1);
    const rows = await db.select().from(leads).orderBy(leads.id);
    expect(rows.map((l) => l.ownerId === null)).toEqual([true, false]);
  });

  it('draws the day’s leads at random, splits them evenly, and never draws a lead twice', async () => {
    const db = await getDb();
    const { runDailyDraw, drawPool } = await import('@/lib/draw');
    await db.insert(leads).values(Array.from({ length: 130 }, (_, i) => lead(`Co ${i}`)));
    await db.insert(leads).values([lead('Not researched', { status: 'New' }), lead('Ruled out', { status: 'Disqualified' })]);
    expect(await runDailyDraw(db, { now: new Date('2026-09-28T02:00:00Z') })).toBeNull(); // 07:30, too early
    const first = await runDailyDraw(db, { now: nine });
    expect(first).toMatchObject({ day: '2026-09-28', wanted: 100, drawn: 100, short: false });
    expect(Object.values(first!.perOwner)).toEqual([25, 25, 25, 25]);
    expect(await runDailyDraw(db, { now: nine })).toBeNull(); // once a day
    expect((await drawPool(db)).total).toBe(30);

    const owned = await db.select().from(leads).where(eq(leads.drawnOn, '2026-09-28'));
    expect(owned).toHaveLength(100);
    // Shuffled: the first four companies by id don't simply go to the team in order.
    const ids = owned.map((l) => l.id).sort((a, b) => a - b);
    expect(ids).not.toEqual(Array.from({ length: 100 }, (_, i) => ids[0] + i));

    const next = await runDailyDraw(db, { now: new Date('2026-09-29T03:30:00Z') });
    expect(next).toMatchObject({ drawn: 30, short: true });
    const all = await db.select().from(leads);
    expect(all.filter((l) => l.drawnOn).length).toBe(130);
    expect(all.find((l) => l.company === 'Not researched')!.ownerId).toBeNull();
    expect(all.find((l) => l.company === 'Ruled out')!.ownerId).toBeNull();
  });

  it('leaves the day open when the list is empty, and tops up a short draw later', async () => {
    const db = await getDb();
    const { runDailyDraw, topUpDraw, getDraw } = await import('@/lib/draw');
    expect(await runDailyDraw(db, { now: nine })).toMatchObject({ drawn: 0 });
    expect(await getDraw(db, '2026-09-28')).toBeNull();
    await db.insert(leads).values(Array.from({ length: 10 }, (_, i) => lead(`Co ${i}`)));
    expect(await runDailyDraw(db, { now: nine })).toMatchObject({ drawn: 10, short: true });
    await db.insert(leads).values(Array.from({ length: 200 }, (_, i) => lead(`More ${i}`)));
    const topped = await topUpDraw(db, { now: nine });
    expect(topped).toMatchObject({ drawn: 100, short: false });
    expect(Object.values(topped!.perOwner).reduce((a, b) => a + b, 0)).toBe(100);
    expect(await topUpDraw(db, { now: nine })).toBeNull();
  });

  it('skips weekends, and two draws at once hand out each lead only once', async () => {
    const db = await getDb();
    const { runDailyDraw } = await import('@/lib/draw');
    await db.insert(leads).values(Array.from({ length: 20 }, (_, i) => lead(`Co ${i}`)));
    expect(await runDailyDraw(db, { now: new Date('2026-09-26T05:00:00Z') })).toBeNull(); // Saturday
    const [a, b] = await Promise.all([runDailyDraw(db, { now: nine }), runDailyDraw(db, { now: nine })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await db.select().from(leads)).every((l) => l.ownerId !== null)).toBe(true);
  });

  it('shuffles without losing anyone and deals the remainder from a random start', async () => {
    const { shuffle, deal } = await import('@/lib/draw');
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(shuffle(items).sort((a, b) => a - b)).toEqual(items);
    const hands = deal(items, [1, 2, 3], () => 0.5);
    expect([...hands.values()].map((h) => h.length)).toEqual([3, 4, 3]);
  });
});

describe('company done for the day', () => {
  it('counts a company once every step due for it is ticked, and takes it back when one reopens', async () => {
    const db = await getDb();
    const { markCompanyDay, companyProgress } = await import('@/lib/tasks');
    const { teamReport } = await import('@/lib/team-report');
    const day = istDay();
    await db.insert(leads).values([lead('Acme'), lead('Beta')]);
    await assignUnowned(db, { everything: true });
    await ensureSequences(db, day);
    const [a] = await db.select().from(leads).where(eq(leads.company, 'Acme'));
    const owner = a.ownerId!;
    const open = (await db.select().from(tasks).where(eq(tasks.leadId, a.id))).filter((t) => t.dueDate <= day);
    expect(open.map((t) => t.kind).sort()).toEqual(['call', 'email', 'linkedin', 'whatsapp']);
    for (const t of open.slice(0, 3)) await db.update(tasks).set({ doneAt: new Date(), outcome: 'sent' }).where(eq(tasks.id, t.id));
    expect(await markCompanyDay(db, a.id, owner, day)).toBe(false);
    await db.update(tasks).set({ doneAt: new Date(), outcome: 'sent' }).where(eq(tasks.id, open[3].id));
    expect(await markCompanyDay(db, a.id, owner, day)).toBe(true);
    expect((await companyProgress(db, owner, day)).done).toBe(1);
    const report = await teamReport(db, day, day);
    expect(report.people.find((p) => p.id === owner)!.companiesDone).toBe(1);
    await db.update(tasks).set({ doneAt: null, outcome: '' }).where(eq(tasks.id, open[3].id));
    expect(await markCompanyDay(db, a.id, owner, day)).toBe(false);
    expect((await companyProgress(db, owner, day)).done).toBe(0);
  });
});

describe('pipeline follows the calls', () => {
  it('moves a lead forward from what was logged, never back', async () => {
    const { stageAfterOutreach } = await import('@/lib/stages');
    expect(stageAfterOutreach('Awaiting Approval', 'call', 'no_answer')).toBe('Contacted');
    expect(stageAfterOutreach('Approved', 'whatsapp', 'sent')).toBe('Contacted');
    expect(stageAfterOutreach('Contacted', 'call', 'busy')).toBeNull();
    expect(stageAfterOutreach('Contacted', 'call', 'connected', 'Interested')).toBe('Replied');
    expect(stageAfterOutreach('Awaiting Approval', 'call', 'connected', 'Demo scheduled')).toBe('Meeting Booked');
    expect(stageAfterOutreach('Meeting Booked', 'call', 'connected', 'Interested')).toBeNull();
    expect(stageAfterOutreach('Replied', 'call', 'connected', 'Not interested')).toBe('Lost');
    expect(stageAfterOutreach('Lost', 'call', 'no_answer')).toBeNull();
    expect(stageAfterOutreach('Lost', 'call', 'connected', 'Demo scheduled')).toBe('Meeting Booked');
    expect(stageAfterOutreach('Won', 'call', 'connected', 'Not interested')).toBeNull();
    expect(stageAfterOutreach('Approved', 'email', 'skipped')).toBeNull();
  });

  it('records the move on the timeline and undoes it exactly', async () => {
    const db = await getDb();
    const { moveAfterOutreach, undoOutreachStage } = await import('@/lib/stages');
    const [l] = await db.insert(leads).values(lead('Acme')).returning();
    const at = new Date();
    expect(await moveAfterOutreach(db, l.id, 'Contacted', at)).toBe('Awaiting Approval');
    let [now] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(now.status).toBe('Contacted');
    expect(now.nextFollowUpAt).toBeNull();
    await undoOutreachStage(db, l.id, 'Awaiting Approval', 'Contacted', at);
    [now] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(now.status).toBe('Awaiting Approval');
    expect(now.sentAt).toBeNull();
    const at2 = new Date();
    await moveAfterOutreach(db, l.id, 'Meeting Booked', at2);
    const stages = await db.select().from(activities).where(eq(activities.leadId, l.id));
    expect(stages.some((a) => a.stage === 'Meeting Booked')).toBe(true);
  });
});

describe('meetings on the Team page', () => {
  it('counts a demo scheduled on a call as a meeting booked, and Undo takes it back', async () => {
    const db = await getDb();
    const { moveAfterOutreach, undoOutreachStage } = await import('@/lib/stages');
    const { teamReport } = await import('@/lib/team-report');
    await db.insert(leads).values(lead('Acme'));
    await assignUnowned(db, { everything: true });
    const [l] = await db.select().from(leads);
    const at = new Date();
    await moveAfterOutreach(db, l.id, 'Meeting Booked', at);
    const day = istDay();
    const meetings = async () => (await teamReport(db, day, day)).people.find((p) => p.id === l.ownerId)!.meetings;
    expect(await meetings()).toBe(1);
    await undoOutreachStage(db, l.id, 'Awaiting Approval', 'Meeting Booked', at);
    expect(await meetings()).toBe(0);
  });
});

describe('point of contact on the tracker', () => {
  it('shows the channel the conversation happened on until someone sets it by hand', async () => {
    const db = await getDb();
    const { loadTracker, validTrackerValue } = await import('@/lib/tracker');
    const [l] = await db.insert(leads).values(lead('Acme', { segment: 'Manufacturing', contactTitle: 'Plant Head' })).returning();
    let [row] = await loadTracker(db, null);
    expect(row.pointOfContact).toBe('');
    await db.insert(tasks).values({ leadId: l.id, ownerId: 1, kind: 'call', title: 'c', dueDate: istDay(), doneAt: new Date(), outcome: 'connected' });
    [row] = await loadTracker(db, null);
    expect(row).toMatchObject({ pointOfContact: 'Phone', autoChannel: 'Phone' });
    await db.update(leads).set({ contactChannel: 'WhatsApp' });
    [row] = await loadTracker(db, null);
    expect(row.pointOfContact).toBe('WhatsApp');
    expect(validTrackerValue('contactChannel', 'LinkedIn')).toBe(true);
    expect(validTrackerValue('contactChannel', 'P1')).toBe(false);
  });
});

describe('callback days get the full set', () => {
  it('adds a WhatsApp and an email beside callbacks planned without them, once', async () => {
    const db = await getDb();
    const { sql } = await import('drizzle-orm');
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const { settings } = await import('@/lib/db/schema');
    const [l] = await db.insert(leads).values(lead('MAS LLP')).returning();
    await db.insert(tasks).values({ leadId: l.id, ownerId: 1, kind: 'call', step: 'Promised callback', title: 'Promised callback', dueDate: '2026-10-05', priority: true });
    await db.delete(settings).where(eq(settings.key, 'callbackFullSetV1'));
    const repair = SCHEMA_STATEMENTS.filter((s) => s.includes('callbackFullSetV1'));
    for (const s of [...repair, ...repair]) await db.execute(sql.raw(s));
    const made = await db.select().from(tasks).where(eq(tasks.leadId, l.id));
    expect(made.map((t) => `${t.kind}:${t.dueDate}`).sort()).toEqual(['call:2026-10-05', 'email:2026-10-05', 'whatsapp:2026-10-05']);
  });
});

describe('P2 flow', () => {
  const icp = { targetTitles: 'Plant Head, Head of Supply Chain', p2Titles: 'Inventory Manager, Warehouse Head', p3Titles: 'Store Manager', avoidTitles: 'HR, Admin, Quality' };
  const person = (id: number, name: string, title: string, extra: Partial<import('@/lib/db/schema').Person> = {}) =>
    ({ id, leadId: 1, name, title, email: '', emailStatus: '', emailSource: '', emailVerification: '', emailProviderStatus: '', emailRetrievedAt: null as Date | null, phone: '', linkedin: '', source: '', isPrimary: false, passedAt: null as Date | null, passedReason: '', checkedAt: null as Date | null, location: '', createdAt: new Date(), ...extra });

  it('picks the next person by INVECK priority, never HR or someone already tried, preferring an email', async () => {
    const { nextContact } = await import('@/lib/escalate');
    const list = [person(1, 'Hr Head', 'Head HR'), person(2, 'Store', 'Store Manager'), person(3, 'Inv A', 'Inventory Manager'), person(4, 'Inv B', 'Inventory Manager', { email: 'invb@x.com' })];
    expect(nextContact(list, icp)?.person.name).toBe('Inv B');
    expect(nextContact(list.map((p) => (p.title === 'Inventory Manager' ? { ...p, passedAt: new Date() } : p)), icp)?.person.name).toBe('Store');
    expect(nextContact([person(1, 'Hr', 'HR Manager')], icp)).toBeNull();
    // Someone at the lead's branch comes first among equals.
    const branches = [person(5, 'Pune Plant', 'Plant Head', { linkedin: 'x' }), person(6, 'Moga Plant', 'Plant Head, Moga')];
    expect(nextContact(branches, icp, 'Moga')?.person.name).toBe('Moga Plant');
  });

  it('switches to the P2 after five unanswered calls with a fresh plan, or asks for one', async () => {
    const db = await getDb();
    const { escalate, unansweredCalls, newContactNamed, FIND_NEXT_STEP } = await import('@/lib/escalate');
    const { people: peopleTable } = await import('@/lib/db/schema');
    const [l] = await db.insert(leads).values(lead('Acme', { segment: 'Manufacturing' })).returning();
    await assignUnowned(db, { everything: true });
    await ensureSequences(db);
    await db.insert(peopleTable).values([
      { leadId: l.id, name: 'Ravi Shah', title: 'Plant Head', isPrimary: true },
      { leadId: l.id, name: 'Asha Rao', title: 'Inventory Manager', phone: '+91 98200 00001' },
    ]);
    const [owned] = await db.select().from(leads).where(eq(leads.id, l.id));
    const done = new Date(Date.now() - 1000);
    await db.insert(tasks).values(Array.from({ length: 5 }, () => ({ leadId: l.id, ownerId: owned.ownerId!, kind: 'call' as const, title: 'c', dueDate: istDay(), doneAt: done, outcome: 'no_answer' })));
    expect(await unansweredCalls(db, owned)).toBe(5);

    expect(await escalate(db, l.id, 'no_answer')).toMatchObject({ switched: true, name: 'Asha Rao', tier: 'P2' });
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactName: 'Asha Rao', contactPhone: '+91 98200 00001', contactTier: 'P2' });
    expect(await unansweredCalls(db, after)).toBe(0);
    const open = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), isNull(tasks.doneAt)));
    expect(open.filter((t) => t.dueDate === istDay()).map((t) => t.kind).sort()).toEqual(['call', 'email', 'linkedin', 'whatsapp']);

    // Nobody left: a step to find someone, and naming them starts their plan.
    expect(await escalate(db, l.id, 'wrong_person')).toEqual({ switched: false });
    let waiting = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), isNull(tasks.doneAt)));
    expect(waiting.map((t) => t.step)).toEqual([FIND_NEXT_STEP]);
    await newContactNamed(db, l.id);
    waiting = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), isNull(tasks.doneAt)));
    expect(waiting.some((t) => t.step === FIND_NEXT_STEP)).toBe(false);
    expect(waiting.filter((t) => t.dueDate === istDay())).toHaveLength(4);
  });
});

describe('LinkedIn profile by name', () => {
  it('finds the chosen person by name and company, and ignores namesakes', async () => {
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const organic = [
      { title: 'Amit Kumar - Allcargo Logistics | LinkedIn', link: 'https://in.linkedin.com/in/amit-kumar', snippet: 'Allcargo Logistics' },
      { title: 'Amit Chhari - Chief of Operations - Allcargo Logistics | LinkedIn', link: 'https://in.linkedin.com/in/amit-chhari-123?trk=x', snippet: 'Allcargo Logistics · IIM Ahmedabad' },
    ];
    const queries: string[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      queries.push(JSON.parse(String(init?.body)).q);
      return new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    // The current LinkedIn title, without the company's name tacked on.
    expect(await findLinkedinProfile(svc, 'Amit Chhari', 'Allcargo Logistics Ltd')).toMatchObject({ url: 'https://in.linkedin.com/in/amit-chhari-123', title: 'Chief of Operations', employer: 'here' });
    expect(queries[0]).toContain('"Amit Chhari"');
    expect(await findLinkedinProfile(svc, 'Rohit Dalmia', 'Allcargo Logistics Ltd')).toBeNull();
  });

  it('keeps the role and drops only the company from a LinkedIn result title', async () => {
    const { roleFromLinkedinTitle } = await import('@/lib/pipeline/contacts');
    expect(roleFromLinkedinTitle(['Chief of Operations', 'Allcargo Logistics'], 'Allcargo Logistics Ltd')).toBe('Chief of Operations');
    expect(roleFromLinkedinTitle(['VP Operations', 'Supply Chain'], 'Allcargo Logistics Ltd')).toBe('VP Operations - Supply Chain');
    expect(roleFromLinkedinTitle(['Plant Head'], '')).toBe('Plant Head');
  });
});

describe('contacts checked on LinkedIn automatically', () => {
  it('corrects a stale designation, saves the profile, and does not check twice', async () => {
    const db = await getDb();
    const { verifyContacts } = await import('@/lib/verify-contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const organic = [{ title: 'Amit Chhari - Chief of Operations - Allcargo Logistics | LinkedIn', link: 'https://in.linkedin.com/in/amit-chhari-123', snippet: 'Allcargo Logistics' }];
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    await db.insert(leads).values([
      lead('Allcargo Logistics', { contactName: 'Amit Chhari', contactTitle: 'VP Operations, Xpressbees', contactVerifiedAt: null }),
      lead('Nobody Ltd', { contactName: 'Rohit Dalmia', contactTitle: 'Finance Head', contactVerifiedAt: null }),
    ]);
    expect(await verifyContacts(db, svc)).toMatchObject({ corrected: 1, not_found: 1 });
    const [amit] = await db.select().from(leads).where(eq(leads.company, 'Allcargo Logistics'));
    expect(amit).toMatchObject({ contactTitle: 'Chief of Operations', contactLinkedin: 'https://in.linkedin.com/in/amit-chhari-123' });
    expect(amit.contactCheckedAt).not.toBeNull();
    const before = calls;
    expect(await verifyContacts(db, svc)).toMatchObject({ corrected: 0, confirmed: 0, not_found: 0 });
    expect(calls).toBe(before);
  });
});

describe('ICP designations', () => {
  it('reads Chief of Operations as an Operations Head (P1)', async () => {
    const { tierOf } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const mfg = DEFAULT_ICPS[0];
    expect(tierOf('Chief of Operations', mfg)).toBe('P1');
    expect(tierOf('Inventory Manager', mfg)).toBe('P2');
    expect(tierOf('Marketing Manager', mfg)).toBe('');
    expect(tierOf('GM - HR', mfg)).toBe('Avoid');
  });
});

describe('only people who work at the company now', () => {
  it('reads the current employer from LinkedIn headlines and results', async () => {
    const { currentEmployer, nameIsTheCompany } = await import('@/lib/pipeline/employer');
    const nestle = 'Nestlé India Ltd';
    const at = (title: string, extra: { snippet?: string; titleParts?: string[] } = {}) => currentEmployer({ name: 'A B', title, ...extra }, nestle);
    expect(at('Regional Logistics Manager at Nestle India')).toBe('here');
    expect(at('Associate Director-Plant Head at PepsiCo')).toBe('elsewhere');
    expect(at('Plant Head at Bisleri || Unilever || Dabur')).toBe('elsewhere');
    expect(at('Logistics Manager')).toBe('unknown');
    expect(at('Plant Head', { titleParts: ['Plant Head', 'Nestle'] })).toBe('here');
    expect(at('Plant Head', { titleParts: ['Plant Head', 'PepsiCo'] })).toBe('elsewhere');
    expect(at('Supply Chain Head', { snippet: 'Experience: Britannia Industries · Education: IIM' })).toBe('elsewhere');
    expect(at('Supply Chain Head', { snippet: 'Ex-Nestle, now building supply chains' })).toBe('elsewhere');
    expect(currentEmployer({ name: 'A', title: 'Head Operations at Mahindra & Mahindra' }, 'Tata Motors')).toBe('elsewhere');
    expect(currentEmployer({ name: 'A', title: 'Head Operations at Tata Motors Ltd' }, 'Tata Motors')).toBe('here');
    expect(nameIsTheCompany('Cynthia Nestle', nestle)).toBe(true);
    expect(nameIsTheCompany('Nestor Fernandes', nestle)).toBe(false);
  });

  it('removes people who have left and replaces a main contact who has left', async () => {
    const db = await getDb();
    const { purgeFormerEmployees } = await import('@/lib/verify-contacts');
    const { people: peopleTable } = await import('@/lib/db/schema');
    const [l] = await db.insert(leads).values(lead('Nestle India', { segment: 'Manufacturing', contactName: 'Alok Srivastava', contactTitle: 'Associate Director-Plant Head at PepsiCo' })).returning();
    await db.insert(peopleTable).values([
      { leadId: l.id, name: 'Alok Srivastava', title: 'Associate Director-Plant Head at PepsiCo', source: 'LinkedIn', isPrimary: true },
      { leadId: l.id, name: 'Raj Kumar', title: 'Plant Head at Bisleri || Unilever || Dabur', source: 'LinkedIn' },
      { leadId: l.id, name: 'Cynthia Nestle', title: 'Managing Director, Chief Operating Officer', source: 'LinkedIn' },
      { leadId: l.id, name: 'Siddhartha Saha', title: 'Regional Logistics Manager at Nestle India', source: 'LinkedIn' },
    ]);
    expect(await purgeFormerEmployees(db, { leadId: l.id })).toBe(3);
    const left = await db.select().from(peopleTable).where(eq(peopleTable.leadId, l.id));
    expect(left.map((p) => p.name)).toEqual(['Siddhartha Saha']);
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.contactName).toBe('Siddhartha Saha');
  });
});

describe('who to contact first', () => {
  it('ranks plant heads first, then hands-on heads, process owners, VPs, P3, and the MD last', async () => {
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const mfg = DEFAULT_ICPS[0];
    const order = ['Plant Manager', 'Operations Head', 'Inventory Manager', 'VP Supply Chain', 'Store Manager', 'Managing Director'];
    const scores = order.map((t) => contactPriority(t, mfg));
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(contactPriority('Factory Manager', mfg)).toBe(contactPriority('Plant Head', mfg));
    expect(contactPriority('Director - Supply Chain', mfg)).toBeLessThan(99);
    expect(contactPriority('Marketing Manager', mfg)).toBe(99);
    expect(contactPriority('GM - HR', mfg)).toBe(99);
  });

  it('prefers someone at the lead’s own branch', async () => {
    const { rankCandidates } = await import('@/lib/pipeline/contacts');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const people = [
      { name: 'A', title: 'Plant Head', snippet: 'Chennai, Tamil Nadu' },
      { name: 'B', title: 'Plant Head', snippet: 'Moga, Punjab · Nestle' },
    ];
    expect(rankCandidates(people, DEFAULT_ICPS[0], 'Moga')[0].name).toBe('B');
  });

  it('switches an MD main contact to the plant head on file, until outreach has started', async () => {
    const db = await getDb();
    const { promoteBetterContacts } = await import('@/lib/verify-contacts');
    const { people: peopleTable } = await import('@/lib/db/schema');
    const [a, b] = await db
      .insert(leads)
      .values([
        lead('Acme Foods', { segment: 'Manufacturing', contactName: 'Rajesh Mehta', contactTitle: 'Managing Director' }),
        lead('Beta Foods', { segment: 'Manufacturing', contactName: 'Sunil Rao', contactTitle: 'Managing Director' }),
      ])
      .returning();
    for (const l of [a, b]) {
      await db.insert(peopleTable).values([
        { leadId: l.id, name: l.contactName, title: 'Managing Director', isPrimary: true },
        { leadId: l.id, name: `Plant ${l.id}`, title: 'Plant Manager', phone: '98' },
      ]);
    }
    // Beta's MD has already been called: leave it.
    await db.insert(tasks).values({ leadId: b.id, ownerId: 1, kind: 'call', title: 'c', dueDate: istDay(), doneAt: new Date(), outcome: 'no_answer' });
    expect(await promoteBetterContacts(db)).toEqual([a.id]);
    const rows = await db.select().from(leads).orderBy(leads.id);
    expect(rows.map((l) => l.contactName)).toEqual([`Plant ${a.id}`, 'Sunil Rao']);
    // Someone the team picked themselves is never overridden.
    const [c] = await db.insert(leads).values(lead('Gamma Foods', { segment: 'Manufacturing', contactName: 'Uma Iyer', contactTitle: 'Managing Director' })).returning();
    await db.insert(peopleTable).values([
      { leadId: c.id, name: 'Uma Iyer', title: 'Managing Director', isPrimary: true },
      { leadId: c.id, name: 'Plant Gamma', title: 'Plant Head' },
    ]);
    await db.insert(activities).values({ leadId: c.id, kind: 'contact', text: 'Point of contact updated (name): Uma Iyer' });
    expect(await promoteBetterContacts(db, { leadId: c.id })).toEqual([]);
  });

  it('keeps a main contact at the site when someone equally placed is on file (Bharat Forge, Pune)', async () => {
    const db = await getDb();
    const { promoteBetterContacts } = await import('@/lib/verify-contacts');
    const { people: peopleTable } = await import('@/lib/db/schema');
    const [bf] = await db.insert(leads).values(lead('Bharat Forge', { segment: 'Manufacturing', city: 'Pune', contactName: 'Sangamnath Digge', contactTitle: 'Plant Head' })).returning();
    await db.insert(peopleTable).values([
      { leadId: bf.id, name: 'Sangamnath Digge', title: 'Plant Head', source: 'LinkedIn', location: 'Pune, Maharashtra, India', isPrimary: true },
      { leadId: bf.id, name: 'Anita Rao', title: 'Head Supply Chain', source: 'LinkedIn', location: 'Pune, Maharashtra, India' },
    ]);
    expect(await promoteBetterContacts(db)).toEqual([]);
    expect((await db.select().from(leads).where(eq(leads.id, bf.id)))[0].contactName).toBe('Sangamnath Digge');
  });

  it('never makes someone not confirmed at the site the main contact (KLT, Pune)', async () => {
    const db = await getDb();
    const { promoteBetterContacts } = await import('@/lib/verify-contacts');
    const { people: peopleTable } = await import('@/lib/db/schema');
    // Research left these without a main contact: nobody it found was confirmed at the Pune site.
    const [klt, other] = await db
      .insert(leads)
      .values([
        lead('KLT Automotive', { segment: 'Manufacturing', city: 'Pune', contactName: '', contactTitle: '', contactEmail: '', contactVerifiedAt: null }),
        lead('Rane Pune', { segment: 'Manufacturing', city: 'Pune', contactName: '', contactTitle: '', contactEmail: '', contactVerifiedAt: null }),
      ])
      .returning();
    await db.insert(peopleTable).values([
      { leadId: klt.id, name: 'Jogendra Jogendra', title: 'Stores Manager', source: 'LinkedIn', location: '' },
      { leadId: klt.id, name: 'Asha Menon', title: 'Plant Head', source: 'LinkedIn', location: 'Chennai, Tamil Nadu, India' },
      { leadId: other.id, name: 'Rohit Patil', title: 'Plant Head', source: 'LinkedIn', location: 'Pune, Maharashtra, India' },
    ]);
    expect(await promoteBetterContacts(db)).toEqual([other.id]);
    const rows = Object.fromEntries((await db.select().from(leads)).map((l) => [l.company, l]));
    expect(rows['KLT Automotive'].contactName).toBe('');
    expect(rows['Rane Pune'].contactName).toBe('Rohit Patil');
    // One timeline entry for the change, with the reason.
    const notes = (await db.select().from(activities).where(eq(activities.leadId, other.id))).map((a) => a.text);
    expect(notes).toEqual(['Main contact changed to Rohit Patil, Plant Head: INVECK approaches Plant Head before anyone else.']);
  });
});

describe('branches of one company', () => {
  it('treats the same company in another city as a new branch, not a duplicate', async () => {
    const { KnownBranches, sameCity } = await import('@/lib/branches');
    const known = new KnownBranches([{ company: 'Nestle India Ltd', website: 'nestle.in', city: 'Moga' }], [{ company: 'Haldex India', website: 'haldex.com' }]);
    expect(known.has('Nestle India', '', 'Moga, Punjab')).toBe('lead');
    expect(known.has('Nestle India', 'nestle.in', 'Samalkha')).toBe('');
    expect(known.has('Nestle India', '', '')).toBe('lead');
    expect(known.has('Haldex India Pvt Ltd', '', 'Pune')).toBe('client');
    expect(sameCity('Pune', 'Pune, Maharashtra')).toBe(true);
    expect(sameCity('Pune', 'Chakan')).toBe(false);
  });
});

describe('everyone at the company checked on LinkedIn', () => {
  it('removes other people whose LinkedIn shows another employer', async () => {
    const db = await getDb();
    const { verifyContacts } = await import('@/lib/verify-contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const { people: peopleTable } = await import('@/lib/db/schema');
    const profiles: Record<string, { title: string; link: string; snippet: string }> = {
      'Siddhartha Saha': { title: 'Siddhartha Saha - Regional Logistics Manager - Nestle India | LinkedIn', link: 'https://in.linkedin.com/in/ss', snippet: 'Nestle India' },
      'Arzoo Sharma': { title: 'Arzoo Sharma - Logistics Manager - Britannia Industries | LinkedIn', link: 'https://in.linkedin.com/in/as', snippet: 'Experience: Britannia Industries' },
    };
    const fetch = (async (_u: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).q as string;
      const hit = Object.entries(profiles).find(([n]) => q.includes(n));
      return new Response(JSON.stringify({ organic: hit ? [hit[1]] : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const [l] = await db.insert(leads).values(lead('Nestle India', { segment: 'Manufacturing', contactName: 'Siddhartha Saha', contactTitle: 'Regional Logistics Manager', contactCheckedAt: new Date() })).returning();
    await db.insert(peopleTable).values([
      { leadId: l.id, name: 'Siddhartha Saha', title: 'Regional Logistics Manager', isPrimary: true },
      { leadId: l.id, name: 'Arzoo Sharma', title: 'Logistics Manager', source: 'LinkedIn' },
    ]);
    await verifyContacts(db, svc);
    const left = await db.select().from(peopleTable).where(eq(peopleTable.leadId, l.id));
    expect(left.map((p) => p.name)).toEqual(['Siddhartha Saha']);
  });
});

describe('broader LinkedIn search', () => {
  it('matches a name written another way only when the profile shows the company', async () => {
    const { looseName } = await import('@/lib/pipeline/contacts');
    expect(looseName('Siddhartha Saha', 'Siddharth Saha')).toBe(true);
    expect(looseName('S. Saha', 'Siddhartha Saha')).toBe(true);
    expect(looseName('Dr. Siddhartha Kumar Saha', 'Siddhartha Saha')).toBe(true);
    expect(looseName('Sid Saha', 'Siddhartha Saha')).toBe(false);
    expect(looseName('Siddhartha Sen', 'Siddhartha Saha')).toBe(false);
  });

  it('falls back to a shorter name, the company short name, role and city', async () => {
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const queries: string[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).q as string;
      queries.push(q);
      // Only the surname-and-role search finds them, written "Siddharth".
      const organic = q.toLowerCase().includes('"saha" nestle logistics manager')
        ? [{ title: 'Siddharth Saha - Logistics Manager - Nestle India | LinkedIn', link: 'https://in.linkedin.com/in/sid-saha', snippet: 'Nestle India · Moga' }]
        : [];
      return new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const found = await findLinkedinProfile(svc, 'Siddhartha Kumar Saha', 'Nestle India Ltd', { title: 'Regional Logistics Manager', city: 'Moga' });
    expect(found).toMatchObject({ url: 'https://in.linkedin.com/in/sid-saha', employer: 'here' });
    expect(queries.length).toBeGreaterThan(2);
    // The same loose name at another company is not taken.
    queries.length = 0;
    expect(await findLinkedinProfile(svc, 'Siddhartha Saha', 'Britannia Industries', { title: 'Logistics Manager' })).toBeNull();
  });
});

describe('CIE Automotive: a plant head over a contact whose title is the company name', () => {
  it('clears the company-name title and makes a plant head the main contact', async () => {
    const db = await getDb();
    const { tidyContacts } = await import('@/lib/verify-contacts');
    const { people: peopleTable } = await import('@/lib/db/schema');
    const [l] = await db
      .insert(leads)
      .values(lead('CIE Automotive India', { segment: 'Manufacturing', contactName: 'Nivrutti Bachhav', contactTitle: 'CIE Automotive India Ltd', ownerId: 1 }))
      .returning();
    await db.insert(peopleTable).values([
      { leadId: l.id, name: 'Nivrutti Bachhav', title: 'CIE Automotive India Ltd', isPrimary: true, email: 'nbachhav@cieautomotive.com' },
      { leadId: l.id, name: 'sajin sahadevan', title: 'PLANT HEAD OPERATIONS' },
      { leadId: l.id, name: 'Ganesan R.S', title: 'Plant Head' },
      { leadId: l.id, name: 'Saurabh Agarwal', title: 'COO' },
    ]);
    // A call that didn't connect doesn't tie the team to someone off the lists.
    await db.insert(tasks).values({ leadId: l.id, ownerId: 1, kind: 'call', title: 'c', dueDate: istDay(), doneAt: new Date(), outcome: 'no_answer' });
    expect(await tidyContacts(db, { ownerId: 1 })).toEqual([l.id]);
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(['sajin sahadevan', 'Ganesan R.S']).toContain(after.contactName);
    const nivrutti = (await db.select().from(peopleTable).where(eq(peopleTable.leadId, l.id))).find((p) => p.name === 'Nivrutti Bachhav');
    expect(nivrutti?.title).toBe('');
  });
});

describe('LinkedIn headlines', () => {
  it('reads the job from a headline-style result and never mistakes the headline for an employer', async () => {
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const organic = [
      {
        title: 'Amit Chhari - Chief of Operations | Logistics & Supply Chain Leader | Driving Operational Excellence | LinkedIn',
        link: 'https://in.linkedin.com/in/amitchhari',
        snippet: 'Chief of Operations at Allcargo Logistics. Experience: Allcargo Logistics · Education: IIM Ahmedabad',
      },
    ];
    const fetch = (async () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    expect(await findLinkedinProfile(svc, 'Amit Chhari', 'Allcargo Logistics')).toMatchObject({ url: 'https://in.linkedin.com/in/amitchhari', title: 'Chief of Operations', employer: 'here' });
  });
});

describe('Lumax: staff write the company as "Lumax World"', () => {
  it('keeps plant heads who write the company as its website name, and searches by that name', async () => {
    const { currentEmployer, sameFirm, registerFirmWebsite } = await import('@/lib/pipeline/employer');
    // Lumax Auto Technologies' website is lumaxworld.in: "Lumax World" is its own name for itself.
    registerFirmWebsite('Lumax Auto Technologies', 'https://www.lumaxworld.in/');
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const { settingsSchema } = await import('@/lib/settings');
    expect(sameFirm('Lumax World', 'Lumax Auto Technologies')).toBe(true);
    // Lumax Industries is a sister company: a shared brand never proves employment.
    expect(sameFirm('Lumax Industries Ltd.', 'Lumax Auto Technologies')).toBe(false);
    expect(currentEmployer({ name: 'Pankaj Tyagi', title: 'Plant Head @ Lumax World' }, 'Lumax Auto Technologies')).toBe('here');
    expect(contactPriority('Vice President Operations & Plant Head', DEFAULT_ICPS[0])).toBeLessThan(contactPriority('Managing Director', DEFAULT_ICPS[0]));
    const queries: string[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => {
      queries.push(JSON.parse(String(init?.body)).q);
      const organic = [{ title: 'Pankaj Tyagi - Plant Head @ Lumax World | MBA in Operations Management | LinkedIn', link: 'https://in.linkedin.com/in/pankaj-tyagi', snippet: 'Gurgaon, Haryana · Lumax World' }];
      return new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    expect(await findLinkedinProfile(svc, 'Pankaj Tyagi', 'Lumax Auto Technologies')).toMatchObject({ url: 'https://in.linkedin.com/in/pankaj-tyagi', employer: 'here' });
    expect(queries[0]).toContain('"lumax"');
  });
});

describe('BC Shetty & Co: names must belong to the company', () => {
  it('matches a name only when written together, and a result only when it names the firm', async () => {
    const { nameIn } = await import('@/lib/pipeline/contacts');
    expect(nameIn('Divya Somani', 'Our team: Divya Somani, CISA')).toBe(true);
    expect(nameIn('Divya K. Somani', 'Somani Divya')).toBe(true);
    expect(nameIn('Divya Somani', 'Divya Rao and Kiran Somani')).toBe(false);
  });
});

describe('real search results (checked live on five companies)', () => {
  it('reads the role and whether it is current from the snippet', async () => {
    const { snippetRoles } = await import('@/lib/pipeline/employer');
    expect(snippetRoles('Experience. Group Plant Head. CIE Automotive India Ltd. Mar 2025 - Present 1 year 7 months.')).toContainEqual({ role: 'Group Plant Head', company: 'CIE Automotive India Ltd', current: true });
    expect(snippetRoles('Plant Head. CIE Automotive India Ltd. Nov 2024 - May 2026 1 year 7 months. Bengaluru')).toContainEqual({ role: 'Plant Head', company: 'CIE Automotive India Ltd', current: false });
  });

  it('ranks site and region heads first, drops engineering, sales and CXOs, ignores company words in titles', async () => {
    const { contactPriority, tierOf } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const [mfg, tpl] = DEFAULT_ICPS;
    expect(contactPriority('Group Plant Head', mfg)).toBe(contactPriority('Head of Supply Chain', mfg));
    expect(contactPriority('Head Plant engineering', mfg)).toBe(99);
    expect(contactPriority('General Manager Commercial', mfg)).toBe(99);
    expect(contactPriority('Regional Head - West', tpl)).toBeLessThan(contactPriority('Finance Controller', tpl));
    expect(contactPriority('Director - Strategy & Group CFO', tpl)).toBeGreaterThanOrEqual(50);
    expect(tierOf('Manager at Allcargo Logistics Ltd', tpl)).toBe('');
  });

  it('drops profiles on another country’s LinkedIn and people whose job here has ended', async () => {
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const results: Record<string, { title: string; link: string; snippet: string }> = {
      'Haris Khan': { title: 'Haris Khan - Head of Supply Chain at Nestle Pakistan Ltd', link: 'https://pk.linkedin.com/in/haris-khan', snippet: 'Nestle' },
      'sajin sahadevan': { title: 'sajin sahadevan - PLANT HEAD OPERATIONS', link: 'https://in.linkedin.com/in/sajin', snippet: 'Plant Head. CIE Automotive India Ltd. Nov 2024 - May 2026 1 year 7 months. Bengaluru' },
      'Nivrutti Bachhav': { title: 'Nivrutti Bachhav - CIE Automotive India Ltd', link: 'https://in.linkedin.com/in/nivrutti-bachhav', snippet: 'Experience. Group Plant Head. CIE Automotive India Ltd. Mar 2025 - Present 1 year 7 months.' },
    };
    const fetch = (async (_u: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).q as string;
      const hit = Object.entries(results).find(([n]) => q.includes(n));
      return new Response(JSON.stringify({ organic: hit ? [hit[1]] : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    expect(await findLinkedinProfile(svc, 'Haris Khan', 'Nestle India')).toBeNull();
    expect(await findLinkedinProfile(svc, 'sajin sahadevan', 'CIE Automotive India')).toMatchObject({ employer: 'elsewhere' });
    expect(await findLinkedinProfile(svc, 'Nivrutti Bachhav', 'CIE Automotive India')).toMatchObject({ title: 'Group Plant Head', employer: 'here' });
  });
});

describe('Godamwale: Google\'s current-job line decides, supply chain managers first', () => {
  it('drops a former Regional Head whose About text still names the company, keeps the supply chain managers', async () => {
    const { searchLinkedIn } = await import('@/lib/pipeline/contacts');
    const { snippetRoles } = await import('@/lib/pipeline/employer');
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const { settingsSchema } = await import('@/lib/settings');
    // Exactly what Google returned for Godamwale.
    const organic = [
      { title: 'Anil Sargar - Cold Chain .Warehousing .Fulfilment. One ...', subtitle: 'Mumbai, Maharashtra, India · Head of Unit · Balmer Lawrie & Co. Ltd.', link: 'https://in.linkedin.com/in/anil-sargar-a2387a23', snippet: 'My career spans dynamic roles, including Regional Head at Godamwale.com and Business Development Manager at Kennan Pharma, where I cultivated expertise in ...' },
      { title: 'Mukund Pathak - Supply Chain Manager @ Godamwale ...', subtitle: 'Mumbai, Maharashtra, India · Supply Chain Manager · Godamwale.com', link: 'https://in.linkedin.com/in/mukund-pathak-06626014a', snippet: 'Mukund Pathak · Supply Chain Manager @ Godamwale Trading & Logistics Pvt. Ltd. | Inventory Management, Shipment Procedures' },
      { title: 'Ahmed Momin - Supply Chain Manager', subtitle: 'Mumbai, Maharashtra, India · Supply Chain Management · Godamwale', link: 'https://in.linkedin.com/in/ahmedm0min', snippet: '1.Extensive experience in logistics management, including transportation, warehousing, inventory management' },
      { title: 'Rahul Thakur - Warehouse Manager', link: 'https://in.linkedin.com/in/rahul-thakur-158933115', snippet: 'Warehouse Operations Manager. Godamwale.com. Mar 2025 - Present 1 year 7 months. Ghaziabad. Warehouse Manager. Godamwale Trading & Logistic Private Limited. Feb ...' },
      { title: 'Ankit Gupta - AllcargoGati | Ex-Godamwale | Ex-Amazon', subtitle: 'Mumbai, Maharashtra, India · Warehouse Supervisor · Allcargo', link: 'https://in.linkedin.com/in/ankit-gupta-775841286', snippet: 'Ankit Gupta. AllcargoGati | Ex-Godamwale | Ex-Amazon' },
      { title: 'Shawn Fanning - Vice President of Supply Chain', subtitle: 'Whitehouse Station, New Jersey, United States · Vice President of Supply Chain - Godamwale · Godamwale', link: 'https://www.linkedin.com/in/shawn-fanning', snippet: '' },
      { title: 'Vijendra Jadhav - Godamwale Trading & Logistics Pvt Ltd.', link: 'https://in.linkedin.com/in/vijendra-jadhav-598630241', snippet: 'Experience · Logistics Coordinator. Godamwale.com. Jan 2023 - Present 3 years 9 months. Chembur · Warehouse Executive. StowNest ...' },
    ];
    const fetch = (async () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "Godamwale"', 'Godamwale');
    const byName = Object.fromEntries(people.map((p) => [p.name, p.title]));
    expect(byName['Anil Sargar']).toBeUndefined();
    expect(byName['Ankit Gupta']).toBeUndefined();
    expect(byName['Shawn Fanning']).toBeUndefined();
    expect(byName['Mukund Pathak']).toBe('Supply Chain Manager');
    expect(byName['Ahmed Momin']).toBe('Supply Chain Manager');
    expect(byName['Rahul Thakur']).toBe('Warehouse Manager');
    expect(byName['Vijendra Jadhav']).toBe('Logistics Coordinator');
    // About-section prose is never read as a current job.
    expect(snippetRoles(organic[0].snippet)).toEqual([]);
    const tpl = DEFAULT_ICPS[1];
    expect(contactPriority('Supply Chain Manager', tpl)).toBeLessThan(contactPriority('Regional Head', tpl));
  });
});

describe('Rheinmetall Pune: people based abroad are not contacts', () => {
  it('drops Detroit and Arkansas profiles, keeps the Pune plant operations head on top', async () => {
    const { searchLinkedIn, rankCandidates } = await import('@/lib/pipeline/contacts');
    const { basedAbroad, inCity } = await import('@/lib/pipeline/employer');
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const { settingsSchema } = await import('@/lib/settings');
    // Exactly what Google returned for Rheinmetall.
    const organic = [
      { title: 'Fred Julio - Supply Chain Manager at Rheinmetall', subtitle: 'Detroit Metropolitan Area · Supply Chain Manager · Rheinmetall', link: 'https://www.linkedin.com/in/fred-julio-7730639', snippet: 'Supply Chain Manager at Rheinmetall. Rheinmetall Walsh College. Detroit ...' },
      { title: 'Cody Gage - Supply Chain Manager at American ...', subtitle: 'Warren, Arkansas, United States · Supply Chain Manager · Rheinmetall Defence', link: 'https://www.linkedin.com/in/cody-gage-431722142', snippet: 'Supply Chain Manager at American Rheinmetall Munition, Inc.' },
      { title: 'Matthew Giacona - American Rheinmetall', subtitle: 'Detroit Metropolitan Area · Director Supply Chain Management · American Rheinmetall', link: 'https://www.linkedin.com/in/matthew-giacona-56b433176', snippet: 'Director Supply Chain Management. American Rheinmetall. Dec 2024 - Present 1 year 10 months. Troy, Michigan, United States' },
      { title: 'Greg Darling - American Rheinmetall Plant Manager', link: 'https://www.linkedin.com/in/greg-darling-37a471109', snippet: 'Greg Darling. American Rheinmetall Plant Manager. Visteon Corporation Purdue University. Jackson, Michigan, United States.' },
      { title: 'Abhay Musale - Plant Operations Head at Rheinmetall', subtitle: 'Pimpri Chinchwad, Maharashtra, India · Head of Operations · Rheinmetall', link: 'https://in.linkedin.com/in/abhay-musale-b51987202', snippet: 'Abhay Musale. Plant Operations Head at Rheinmetall | 30+ years experience in Manufacturing and Plant operations' },
    ];
    const fetch = (async () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "Rheinmetall"', 'Rheinmetall');
    expect(people.map((p) => p.name)).toEqual(['Abhay Musale']);
    expect(contactPriority('Plant Operations Head', DEFAULT_ICPS[0])).toBe(5);
    expect(inCity('Pimpri Chinchwad, Maharashtra, India', 'Pune')).toBe(true);
    expect(inCity('Gurugram, Haryana, India', 'Delhi')).toBe(true);
    expect(basedAbroad('Mumbai Metropolitan Region')).toBe(false);
    expect(basedAbroad('Greater Bengaluru Area')).toBe(false);
    expect(basedAbroad('Detroit Metropolitan Area')).toBe(true);
    // In the lead's city first, among people of the same rank.
    const ranked = rankCandidates([
      { title: 'Plant Head', snippet: '', location: 'Chennai, Tamil Nadu, India' },
      { title: 'Plant Head', snippet: '', location: 'Chakan, Maharashtra, India' },
    ], DEFAULT_ICPS[0], 'Pune');
    expect(ranked[0].location).toContain('Chakan');
  });
});

describe('review fixes', () => {
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const settingsOf = async () => (await import('@/lib/settings')).settingsSchema.parse({});

  it('keeps Indian towns it has never heard of, drops places that are clearly abroad', async () => {
    const { basedAbroad } = await import('@/lib/pipeline/employer');
    for (const l of ['Jalandhar', 'Belagavi', 'Greater Tiruchirappalli Area', 'Silvassa', 'Rudrapur, Uttarakhand', 'Mumbai Metropolitan Region', 'Greater Bengaluru Area']) expect([l, basedAbroad(l)]).toEqual([l, false]);
    for (const l of ['Detroit Metropolitan Area', 'Warren, Arkansas, United States', 'Lahore, Punjab, Pakistan', 'Greater London', 'الإمارات العربية المتحدة']) expect([l, basedAbroad(l)]).toEqual([l, true]);
  });

  it('a failed LinkedIn lookup is not "not found": nothing is marked checked', async () => {
    const db = await getDb();
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const { verifyContact } = await import('@/lib/verify-contacts');
    const { people } = await import('@/lib/db/schema');
    const fetch = (async () => new Response('quota exceeded', { status: 429 })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: await settingsOf() };
    await expect(findLinkedinProfile(svc, 'Ravi Shah', 'Acme')).rejects.toThrow(/LinkedIn search failed/);
    const [l] = await db.insert(leads).values(lead('Acme', { contactVerifiedAt: null })).returning();
    await db.insert(people).values([{ leadId: l.id, name: 'Ravi Shah', title: 'Plant Head', isPrimary: true }, { leadId: l.id, name: 'Anita Rao', title: 'Supply Chain Manager' }]);
    expect(await verifyContact(db, svc, l)).toBe('skipped');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.contactCheckedAt).toBeNull();
    expect((await db.select().from(people).where(eq(people.leadId, l.id))).every((p) => p.checkedAt === null)).toBe(true);
  });

  it('copies the LinkedIn link and title found for the main contact into the People list', async () => {
    const db = await getDb();
    const { verifyContact } = await import('@/lib/verify-contacts');
    const { companyPeople } = await import('@/lib/pipeline/process-lead');
    const { people } = await import('@/lib/db/schema');
    const organic = [{ title: 'Ravi Shah - Head of Supply Chain - Acme', subtitle: 'Pune, Maharashtra, India · Head of Supply Chain · Acme', link: 'https://in.linkedin.com/in/ravi-shah', snippet: '' }];
    const fetch = (async () => ok({ organic })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: await settingsOf() };
    const [l] = await db.insert(leads).values(lead('Acme', { contactTitle: 'Manager', contactVerifiedAt: null })).returning();
    // The People row isn't flagged as the main contact (an older record): matched by name.
    await db.insert(people).values({ leadId: l.id, name: 'Ravi Shah', title: 'Manager', linkedin: '' });
    expect(await verifyContact(db, svc, l, new Date(), { mainOnly: true })).toBe('corrected');
    const [p] = await db.select().from(people).where(eq(people.leadId, l.id));
    expect(p).toMatchObject({ linkedin: 'https://in.linkedin.com/in/ravi-shah', title: 'Head of Supply Chain' });
    // During research too: the main contact's row carries what the lookup found.
    const rows = companyPeople(
      [{ id: 'W1', source: 'Web', name: 'Ravi Shah', title: 'Manager', email: '', phone: '', linkedin: '', snippet: '' }],
      { name: 'Ravi Shah', email: '', phone: '', title: 'Head of Supply Chain', linkedin: 'https://in.linkedin.com/in/ravi-shah' },
    );
    expect(rows[0]).toMatchObject({ isPrimary: true, title: 'Head of Supply Chain', linkedin: 'https://in.linkedin.com/in/ravi-shah' });
  });

  it('research sets aside a pick nobody can confirm, drops one at another employer, and takes one confirmed at the site', async () => {
    const { vetPick } = await import('@/lib/pipeline/process-lead');
    const { EMPTY_CONTACT } = await import('@/lib/pipeline/contacts');
    const profiles: Record<string, { title: string; subtitle: string; link: string; snippet: string }> = {
      'Sunil Rao': { title: 'Sunil Rao - Plant Head', subtitle: 'Pune, Maharashtra, India · Plant Head · Tata Steel', link: 'https://in.linkedin.com/in/sunil-rao', snippet: '' },
      'Meera Iyer': { title: 'Meera Iyer - Supply Chain Manager', subtitle: 'Chakan, Maharashtra, India · Supply Chain Manager · Acme Forgings', link: 'https://in.linkedin.com/in/meera-iyer', snippet: '' },
    };
    const fetch = (async (_u: string, init?: RequestInit) => {
      const name = Object.keys(profiles).find((n) => String(init?.body).includes(n));
      return ok({ organic: name ? [profiles[name]] : [] });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: await settingsOf() };
    const cands: import('@/lib/pipeline/contacts').Candidate[] = [
      { id: 'W0', source: 'Web' as const, name: 'Ghost Person', title: 'Plant Head', email: '', phone: '', linkedin: '', snippet: '' },
      { id: 'W1', source: 'Web' as const, name: 'Sunil Rao', title: 'Plant Head', email: '', phone: '', linkedin: '', snippet: '' },
      { id: 'W2', source: 'Web' as const, name: 'Meera Iyer', title: 'Supply Chain Manager', email: '', phone: '', linkedin: '', snippet: '' },
    ];
    const pick = async (list: typeof cands) => ({ contact: { ...EMPTY_CONTACT, name: list[0]?.name ?? '', title: list[0]?.title ?? '' }, notes: [], error: '', ranked: list });
    const notes: string[] = [];
    const { picked, lookupFailed, verified } = await vetPick(svc, { company: 'Acme Forgings', city: 'Pune' }, cands, [], pick, notes);
    expect(picked.contact.name).toBe('Meera Iyer');
    expect(verified).toBe(true);
    expect(lookupFailed).toBe(false);
    expect(notes.join(' ')).toContain('Ghost Person set aside: no LinkedIn profile confirms');
    expect(notes.join(' ')).toContain('Sunil Rao left out');
  });

  it('searches further when the first round only finds companies already on the list, and fails loudly when search is down', async () => {
    const { findProspects } = await import('@/lib/pipeline/prospects');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const icps = DEFAULT_ICPS.map((i, n) => ({ ...i, id: n + 1, active: true, createdAt: new Date() })) as never;
    const pages: number[] = [];
    let plans = 0;
    const fetch = (async (u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(u).includes('deepseek')) {
        const system = body.messages[0].content as string;
        const reply = system.startsWith('You plan Google searches')
          ? { queries: [{ query: `forging plants Pune round ${++plans}`, segment: 'Manufacturing', lookalike_of: '' }] }
          : { companies: [{ company: 'New Forge Ltd', website: 'newforge.in', city: 'Pune', segment: 'Manufacturing', lookalike_of: '', why: 'plants' }] };
        return ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] });
      }
      pages.push(body.page ?? 1);
      // Round 1 only finds a company already on the list; round 2 finds a new one.
      // A full first page (ten results), so the second page is read too.
      const organic = body.q.includes('round 1')
        ? Array.from({ length: 10 }, (_, i) => ({ title: 'Old Forge', link: `https://oldforge.in/page${i}`, snippet: 'forging' }))
        : [{ title: 'New Forge Ltd', link: 'https://newforge.in/', snippet: 'forging plants in Pune' }];
      return ok({ organic });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k', deepseek: 'd' } as never, settings: await settingsOf() };
    const found = await findProspects(svc, icps, [], [{ company: 'Old Forge', website: 'oldforge.in' }], async () => {});
    expect(found.map((f) => f.company)).toEqual(['New Forge Ltd']);
    expect(plans).toBeGreaterThanOrEqual(2);
    expect(pages).toContain(2);

    const down = (async (u: string) =>
      String(u).includes('deepseek')
        ? ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ queries: [{ query: `q${Math.random()}`, segment: '', lookalike_of: '' }] }) } }] })
        : new Response('{"message":"Not enough credits"}', { status: 400 })) as unknown as typeof globalThis.fetch;
    await expect(findProspects({ ...svc, fetch: down }, icps, [], [], async () => {})).rejects.toThrow(/Not enough credits|Search failed/);
  });
});

describe('NBC Bearings, Jaipur: the right company and the right site', () => {
  it('never matches another company on what it does (Bearings), only on its name', async () => {
    const { sameFirm, brandOf } = await import('@/lib/pipeline/employer');
    expect(brandOf('NBC Bearings')).toBe('');
    expect(sameFirm('RBC Bearings', 'NBC Bearings')).toBe(false);
    expect(sameFirm('SKF Bearings India', 'NBC Bearings')).toBe(false);
    expect(sameFirm('Bearings', 'NBC Bearings')).toBe(false);
    expect(sameFirm('NBC Bearings Jaipur', 'NBC Bearings')).toBe(true);
    expect(sameFirm('Bharat Petroleum', 'Bharat Forge')).toBe(false);
    expect(sameFirm('MRF Tyres', 'Apollo Tyres')).toBe(false);
    // Brands still match the way staff write them.
    // Lumax World only as the company's own website name (lumaxworld.in).
    (await import('@/lib/pipeline/employer')).registerFirmWebsite('Lumax Auto Technologies', 'lumaxworld.in');
    expect(sameFirm('Lumax World', 'Lumax Auto Technologies')).toBe(true);
    expect(sameFirm('Godamwale.com', 'Godamwale')).toBe(true);
  });

  it('drops RBC Bearings staff and anyone abroad from the search, whatever their title', async () => {
    const { searchLinkedIn } = await import('@/lib/pipeline/contacts');
    const { settingsSchema } = await import('@/lib/settings');
    const organic = [
      { title: 'Jamie King - Vice President and General Manager at RBC Bearings', subtitle: 'United States · Vice President and General Manager · RBC Bearings', link: 'https://www.linkedin.com/in/jamie-king', snippet: '' },
      { title: 'Alex Moore - National Head Supply Chain at NBC Bearings', subtitle: 'Detroit Metropolitan Area · National Head Supply Chain · NBC Bearings', link: 'https://www.linkedin.com/in/alex-moore', snippet: '' },
      { title: 'Rohan Katara - Supply Chain Manager - NBC Bearings', subtitle: 'Jaipur, Rajasthan, India · Supply Chain Manager · NBC Bearings', link: 'https://in.linkedin.com/in/rohan-katara', snippet: '' },
    ];
    const fetch = (async () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "NBC Bearings"', 'NBC Bearings');
    expect(people.map((p) => p.name)).toEqual(['Rohan Katara']);
    expect(people[0].location).toBe('Jaipur, Rajasthan, India');
  });

  it('keeps the Jaipur site; anyone at another site is left out, whatever the role', async () => {
    const { siteOf } = await import('@/lib/pipeline/employer');
    const { atOtherSite, rankCandidates } = await import('@/lib/pipeline/contacts');
    const { nextContact } = await import('@/lib/escalate');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const icp = DEFAULT_ICPS[0];
    expect(siteOf('Jaipur, Rajasthan, India', 'Jaipur')).toBe('here');
    expect(siteOf('Sitapura Industrial Area, Jaipur', 'Jaipur')).toBe('here');
    expect(siteOf('Gurugram, Haryana, India', 'Jaipur')).toBe('elsewhere');
    expect(siteOf('Rajasthan, India', 'Jaipur')).toBe('unknown');
    expect(siteOf('', 'Jaipur')).toBe('unknown');
    expect(siteOf('Gurugram, Haryana, India', '')).toBe('unknown');
    expect(atOtherSite({ title: 'Supply Chain Manager', location: 'Gurugram, Haryana, India' }, 'Jaipur')).toBe(true);
    // No head-office exception: a lead is one site, whatever the role.
    expect(atOtherSite({ title: 'National Head - Supply Chain', location: 'Mumbai, Maharashtra, India' }, 'Jaipur')).toBe(true);
    expect(atOtherSite({ title: 'Supply Chain Manager', location: '' }, 'Jaipur')).toBe(false);
    const ranked = rankCandidates([
      { title: 'National Head - Supply Chain', location: 'Mumbai, Maharashtra, India' },
      { title: 'Supply Chain Manager', location: '' },
      { title: 'Supply Chain Manager', location: 'Jaipur, Rajasthan, India' },
    ], icp, 'Jaipur');
    expect(ranked.map((r) => r.location)).toEqual(['Jaipur, Rajasthan, India', '', 'Mumbai, Maharashtra, India']);
    const person = (id: number, name: string, title: string, location: string) =>
      ({ id, leadId: 1, name, title, location, email: '', emailStatus: '', emailSource: '', emailVerification: '', emailProviderStatus: '', emailRetrievedAt: null as Date | null, phone: '', linkedin: '', source: '', isPrimary: false, passedAt: null, passedReason: '', checkedAt: null, createdAt: new Date() });
    expect(nextContact([person(1, 'Gurgaon Guy', 'Plant Head', 'Gurugram, Haryana, India'), person(2, 'Jaipur Lady', 'Store Manager', 'Jaipur, Rajasthan, India')], icp, 'Jaipur')?.person.name).toBe('Jaipur Lady');
  });

  it('a recheck removes a saved contact based at another site', async () => {
    const db = await getDb();
    const { verifyContact } = await import('@/lib/verify-contacts');
    const { people } = await import('@/lib/db/schema');
    const { settingsSchema } = await import('@/lib/settings');
    const organic = [{ title: 'Hardik Gaur - Supply Chain Manager - NBC Bearings', subtitle: 'Gurugram, Haryana, India · Supply Chain Manager · NBC Bearings', link: 'https://in.linkedin.com/in/hardik-gaur', snippet: '' }];
    // Google Maps knows where Jaipur and Gurugram are: 230 km apart.
    const map: Record<string, [number, number]> = { jaipur: [26.9124, 75.7873], gurugram: [28.4595, 77.0266] };
    const fetch = (async (u: string, init?: RequestInit) => {
      const body = String(init?.body);
      if (String(u).endsWith('/maps')) {
        const at = Object.entries(map).find(([k]) => body.toLowerCase().includes(k))?.[1];
        return new Response(JSON.stringify({ places: at ? [{ title: 'x', latitude: at[0], longitude: at[1] }] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ organic: body.includes('Hardik') ? organic : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const [l] = await db.insert(leads).values(lead('NBC Bearings', { city: 'Jaipur', contactName: 'Rohan Katara', contactTitle: 'Supply Chain Manager', contactCheckedAt: new Date() })).returning();
    await db.insert(people).values([{ leadId: l.id, name: 'Rohan Katara', title: 'Supply Chain Manager', isPrimary: true }, { leadId: l.id, name: 'Hardik Gaur', title: 'Supply Chain Manager' }]);
    await verifyContact(db, svc, l);
    expect((await db.select().from(people).where(eq(people.leadId, l.id))).map((p) => p.name)).toEqual(['Rohan Katara']);
  });
});

describe('NBC Bearings, Jaipur: a contact set aside as unconfirmed', () => {
  const map: Record<string, [number, number]> = { jaipur: [26.9124, 75.7873] };
  const govind = [{ title: 'Govind Gopalia - Head of Procurement - NBC Bearings', subtitle: 'Jaipur, Rajasthan, India · Head of Procurement · NBC Bearings', link: 'https://in.linkedin.com/in/govindgopalia', snippet: '' }];
  const services = async (found: boolean) => {
    const { settingsSchema } = await import('@/lib/settings');
    const fetch = (async (u: string, init?: RequestInit) => {
      const body = String(init?.body);
      if (String(u).endsWith('/maps')) {
        const at = Object.entries(map).find(([k]) => body.toLowerCase().includes(k))?.[1];
        return new Response(JSON.stringify({ places: at ? [{ title: 'x', latitude: at[0], longitude: at[1] }] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ organic: found && body.includes('Govind') ? govind : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
  };

  it('is no longer shown as the main contact, the lead waits for a contact, and nothing addresses the old one', async () => {
    const db = await getDb();
    const { verifyContact } = await import('@/lib/verify-contacts');
    const { people } = await import('@/lib/db/schema');
    const [l] = await db.insert(leads).values(lead('NBC Bearings', { city: 'Jaipur', status: 'Awaiting Approval', contactName: 'Govind Gopalia', contactTitle: 'Head Sourcing & Procurement', contactEmail: '', contactVerifiedAt: null })).returning();
    await db.insert(people).values({ leadId: l.id, name: 'Govind Gopalia', title: 'Head Sourcing & Procurement', isPrimary: true });
    expect(await verifyContact(db, await services(false), l)).toBe('not_found');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactName: '', status: 'Needs Manual Contact' });
    expect((await db.select().from(people).where(eq(people.leadId, l.id)))[0]).toMatchObject({ isPrimary: false, passedReason: 'unverified' });
  });

  it('is checked again and made the main contact once LinkedIn confirms them at the site (also rows set aside before the reason was kept)', async () => {
    const db = await getDb();
    const { verifyContacts } = await import('@/lib/verify-contacts');
    const { people } = await import('@/lib/db/schema');
    // As the lead page showed it: no contact on the lead, the set-aside person still flagged main contact.
    const [l] = await db.insert(leads).values(lead('NBC Bearings', { segment: 'Manufacturing', city: 'Jaipur', status: 'Needs Manual Contact', contactName: '', contactTitle: '', contactEmail: '', contactVerifiedAt: null, emailBody: 'Hello Rohan,' })).returning();
    await db.insert(people).values([
      { leadId: l.id, name: 'Govind Gopalia', title: 'Head Sourcing & Procurement', isPrimary: true, passedAt: new Date(), linkedin: 'https://in.linkedin.com/in/govindgopalia' },
      { leadId: l.id, name: 'Rohan Katara', title: 'Supply Chain Manager', passedAt: new Date(), passedReason: 'tried' },
    ]);
    const svc = await services(true);
    // Picked up by the regular contact check, though the lead has no contact.
    const tally = await verifyContacts(db, svc);
    expect(tally.confirmed, JSON.stringify(tally)).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactName: 'Govind Gopalia', contactTitle: 'Head of Procurement', status: 'Awaiting Approval' });
    expect(after.contactVerifiedAt).not.toBeNull();
    const rows = await db.select().from(people).where(eq(people.leadId, l.id));
    expect(rows.find((p) => p.name === 'Govind Gopalia')).toMatchObject({ isPrimary: true, passedAt: null });
    // Someone the team already tried by phone is not tried again.
    expect(rows.find((p) => p.name === 'Rohan Katara')).toMatchObject({ isPrimary: false, passedReason: 'tried' });
  });
});

describe('a pick whose real LinkedIn role is not wanted', () => {
  it('drops "QA Analyst" found on LinkedIn and picks the next person; nobody after three wrong picks', async () => {
    const { vetPick } = await import('@/lib/pipeline/process-lead');
    const { EMPTY_CONTACT } = await import('@/lib/pipeline/contacts');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const { settingsSchema } = await import('@/lib/settings');
    const profile = (name: string, role: string) => [{ title: `${name} - ${role}`, subtitle: `Gurugram, Haryana, India · ${role} · Metalman Auto`, link: `https://in.linkedin.com/in/${name.replace(' ', '-').toLowerCase()}`, snippet: '' }];
    const roles: Record<string, string> = { 'Ashish Sharma': 'QA Analyst 1', 'Neha Gupta': 'Plant Head' };
    const fetch = (async (_u: string, init?: RequestInit) => {
      const name = Object.keys(roles).find((n) => String(init?.body).includes(n));
      return new Response(JSON.stringify({ organic: name ? profile(name, roles[name]) : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const cands: import('@/lib/pipeline/contacts').Candidate[] = [
      { id: 'H1', source: 'Email database', name: 'Ashish Sharma', title: 'Plant Head', email: '', phone: '', linkedin: '', snippet: '' },
      { id: 'H2', source: 'Email database', name: 'Neha Gupta', title: 'Plant Manager', email: '', phone: '', linkedin: '', snippet: '' },
    ];
    const pick = async (list: typeof cands) => ({ contact: { ...EMPTY_CONTACT, name: list[0]?.name ?? '', title: list[0]?.title ?? '' }, notes: [], error: '', ranked: list });
    const notes: string[] = [];
    const { picked } = await vetPick(svc, { company: 'Metalman Auto', city: '' }, cands, [], pick, notes, DEFAULT_ICPS[0]);
    expect(picked.contact).toMatchObject({ name: 'Neha Gupta', title: 'Plant Head' });
    expect(notes.join(' ')).toContain('Ashish Sharma left out: LinkedIn shows their role is QA Analyst 1');
  });
});

describe('NBC Bearings live findings', () => {
  it('reads "Head of Supply Chain | NBC Bearings" as working there, and SCM as supply chain', async () => {
    const { searchLinkedIn } = await import('@/lib/pipeline/contacts');
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const { settingsSchema } = await import('@/lib/settings');
    const organic = [{ title: 'Pratap Naruka - Head of Supply Chain | NBC Bearings', link: 'https://in.linkedin.com/in/pratap-naruka', snippet: 'Pratap Naruka. Head of Supply Chain | NBC Bearings | CKA Birla Group | MBA Operations' }];
    const fetch = (async () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "NBC Bearings"', 'NBC Bearings');
    expect(people.map((p) => [p.name, p.title])).toEqual([['Pratap Naruka', 'Head of Supply Chain']]);
    expect(contactPriority('Sr.Manager SCM', DEFAULT_ICPS[0])).toBe(5);
  });
});

describe('a company is done only when something was really done', () => {
  it('skipping every step does not count; a real call or message does', async () => {
    const db = await getDb();
    const { markCompanyDay, companyProgress } = await import('@/lib/tasks');
    const day = istDay();
    const [l] = await db.insert(leads).values(lead('Skipped Co', { ownerId: 1 })).returning();
    const kinds = ['call', 'whatsapp', 'email', 'linkedin'] as const;
    const rows = await db.insert(tasks).values(kinds.map((kind) => ({ leadId: l.id, ownerId: 1, kind, title: kind, dueDate: day }))).returning();
    await db.update(tasks).set({ doneAt: new Date(), outcome: 'skipped' }).where(eq(tasks.leadId, l.id));
    expect(await markCompanyDay(db, l.id, 1, day)).toBe(false);
    expect((await companyProgress(db, 1, day)).done).toBe(0);
    // One step really done (the WhatsApp sent) and the rest skipped: done.
    await db.update(tasks).set({ outcome: 'sent' }).where(eq(tasks.id, rows[1].id));
    expect(await markCompanyDay(db, l.id, 1, day)).toBe(true);
    expect((await companyProgress(db, 1, day)).done).toBe(1);
  });
});

describe('Ultra Drugs: a shared brand word is not the same company', () => {
  it('rejects Ultra Corpotech, sister companies and network firms; keeps the company written in full', async () => {
    const { sameFirm } = await import('@/lib/pipeline/employer');
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    expect(sameFirm('Ultra Corpotech Pvt. Ltd.', 'Ultra Drugs Pvt Ltd')).toBe(false);
    expect(sameFirm('Tata Steel', 'Tata Motors')).toBe(false);
    expect(sameFirm('Ultra Drugs Private Limited', 'Ultra Drugs Pvt Ltd')).toBe(true);
    // Group and sister companies are separate firms; a shared brand never proves employment.
    expect(sameFirm('Allcargo Global', 'Allcargo Logistics')).toBe(false);
    expect(sameFirm('Minda Corporation', 'Minda Industries')).toBe(false);
    expect(sameFirm('Sakthi Auto Component Limited', 'Sakthi Auto Ancillary Pvt. Ltd.')).toBe(false);
    expect(sameFirm('PKF Sridhar & Santhanam', 'PKF India')).toBe(false);
    expect(sameFirm('ABC Warehousing Express Logistics', 'Warehousing Express Logistics Pvt Ltd')).toBe(false);
    expect(sameFirm('Allcargo Logistics Limited', 'Allcargo Logistics')).toBe(true);
    expect(contactPriority('Asst.General Manager SAP/IT', DEFAULT_ICPS[0])).toBe(99);
  });
});

describe('phone numbers and emails are not collected', () => {
  it('keeps only a number or an email the sales team gave; found ones are dropped', async () => {
    const { companyPeople } = await import('@/lib/pipeline/process-lead');
    const rows = companyPeople(
      [
        { id: 'H1', source: 'Email database', name: 'Ravi Shah', title: 'Plant Head', email: 'ravi@x.com', phone: '+91 98765 43210', linkedin: '', snippet: '' },
        { id: 'M', source: 'Sales team', name: 'Neha Rao', title: 'Supply Chain Manager', email: 'neha@x.com', phone: '+91 90000 00000', linkedin: '', snippet: '' },
        { id: 'L', source: 'LinkedIn', name: 'Amit Jain', title: 'Plant Manager', email: 'amit@x.com', phone: '', linkedin: 'https://in.linkedin.com/in/amit', snippet: '' },
      ],
      { name: 'Ravi Shah', email: '', phone: '', title: 'Plant Head' },
    );
    expect(rows.map((r) => [r.name, r.phone, r.email])).toEqual([
      ['Ravi Shah', '', ''],
      ['Neha Rao', '+91 90000 00000', 'neha@x.com'],
      ['Amit Jain', '', ''],
    ]);
    expect(rows[1]).toMatchObject({ emailStatus: 'entered by the team', emailSource: 'manual' });
  });
});

describe('only confirmed contacts go out', () => {
  it('sets aside a main contact LinkedIn cannot confirm (kept, retryable), instead of marking it checked', async () => {
    const db = await getDb();
    const { verifyContact } = await import('@/lib/verify-contacts');
    const { people } = await import('@/lib/db/schema');
    const { settingsSchema } = await import('@/lib/settings');
    const fetch = (async () => new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const [l] = await db.insert(leads).values(lead('KSH Integrated Logistics', { contactName: 'Wrong Person', contactVerifiedAt: null })).returning();
    await db.insert(people).values({ leadId: l.id, name: 'Wrong Person', title: 'Plant Head', isPrimary: true });
    expect(await verifyContact(db, svc, l)).toBe('not_found');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactName: '', contactVerifiedAt: null });
    const [kept] = await db.select().from(people).where(eq(people.leadId, l.id));
    expect(kept.name).toBe('Wrong Person');
    expect(kept.passedAt).not.toBeNull();
  });

  it('the morning draw hands out only qualified leads with a confirmed contact, or none yet', async () => {
    const db = await getDb();
    const { runDailyDraw } = await import('@/lib/draw');
    await db.insert(leads).values([
      lead('Confirmed Co'),
      lead('No Contact Co', { contactName: '', contactEmail: '', contactVerifiedAt: null }),
      lead('Unconfirmed Co', { contactVerifiedAt: null }),
      lead('Unqualified Co', { qualified: false }),
    ]);
    await runDailyDraw(db, { now: new Date('2026-09-28T03:30:00Z'), force: true });
    const owned = (await db.select().from(leads)).filter((l) => l.ownerId !== null).map((l) => l.company).sort();
    expect(owned).toEqual(['Confirmed Co', 'No Contact Co']);
  });
});

describe('Micron Sanand: staff of a site in a metro belt, under the brand they write', () => {
  it('keeps Ahmedabad-based staff for a Sanand site, reads the short name and the current position', async () => {
    const { searchLinkedIn, linkedinQuery, confirmedAtSite, atOtherSite } = await import('@/lib/pipeline/contacts');
    const { registerFirmWebsite, sameFirm, inCity } = await import('@/lib/pipeline/employer');
    const { contactPriority } = await import('@/lib/tiers');
    const { DEFAULT_ICPS } = await import('@/lib/db/seed');
    const { settingsSchema } = await import('@/lib/settings');
    const company = 'Micron Semiconductor Technology India';
    registerFirmWebsite(company, 'micron.com');
    // Sanand is in Ahmedabad's industrial belt; Bengaluru and Hyderabad are other sites.
    expect(inCity('Ahmedabad, Gujarat, India', 'Sanand')).toBe(true);
    expect(confirmedAtSite({ location: 'Greater Ahmedabad Area' }, 'Sanand')).toBe(true);
    expect(atOtherSite({ title: '', location: 'Hyderabad, Telangana, India' }, 'Sanand')).toBe(true);
    expect(inCity('Pimpri Chinchwad, Maharashtra, India', 'Chakan')).toBe(true);
    // Short forms of the company's own name that keep its brand (= its website); never another name.
    expect(sameFirm('Micron Technology', company)).toBe(true);
    expect(sameFirm('MICRON SEMICONDUCTOR LIMITED', company)).toBe(true);
    expect(sameFirm('Micron Steel', company)).toBe(false);
    // Staff don't write "India": the search leaves it out.
    expect(linkedinQuery(company, 'Sanand', { ...DEFAULT_ICPS[0], id: 1 } as never)).toContain('"Micron Semiconductor Technology" (');

    // Exactly what Google returned.
    const organic = [
      { title: 'Jitender Pratap Singh-JP - Working as Director Operation ...', subtitle: 'Sanand, Gujarat, India · Director Operations Management · MICRON SEMICONDUCTOR LIMITED', link: 'https://in.linkedin.com/in/jitender-pratap-singh-jp-9567a8382', snippet: '' },
      { title: 'Himesh Sarvaiya - Manufacturing Operations', subtitle: 'Ahmedabad, Gujarat, India · Associate - Manufacturing Operations · Micron Technology', link: 'https://in.linkedin.com/in/himesh-sarvaiya-62366b258', snippet: 'Experience: Micron Technology · Himesh Sarvaiya. Ahmedabad, Gujarat, India. Micron Technology May 2025 - Present 1 year 5 months Sanand, Gujarat. Contact ...' },
      { title: 'Hemanth kumar vemana - Director Procurement-Micron ...', subtitle: 'Hyderabad, Telangana, India · Director Global Procurement · Micron Technology', link: 'https://in.linkedin.com/in/hemanth-kumar-vemana-b3070412', snippet: '' },
    ];
    const fetch = (async () => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;
    const svc = { fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "Micron Semiconductor Technology"', company);
    const byName = Object.fromEntries(people.map((p) => [p.name, p]));
    expect(byName['Jitender Pratap Singh-JP']).toMatchObject({ title: 'Director Operations Management', location: 'Sanand, Gujarat, India' });
    expect(contactPriority(byName['Jitender Pratap Singh-JP'].title, DEFAULT_ICPS[0] as never)).toBeLessThan(99);
    // A dated line in the snippet never turns the title into a place.
    expect(byName['Himesh Sarvaiya'].title).toBe('Associate - Manufacturing Operations');
    expect(atOtherSite(byName['Hemanth kumar vemana'], 'Sanand')).toBe(true);
  });
});

describe('emails are not kept anywhere', () => {
  it('clears every stored email and its labels, and no tracker column shows one', async () => {
    const db = await getDb();
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const { people } = await import('@/lib/db/schema');
    const { TRACKER_HEADERS } = await import('@/lib/tracker');
    const { sql } = await import('drizzle-orm');
    const [l] = await db.insert(leads).values(lead('Mojj Engineering', { contactEmail: 'dhirendra@mojj.in', emailStatus: 'Prospeo (verified)', emailSource: 'prospeo', emailRetrievedAt: new Date() })).returning();
    await db.insert(people).values({ leadId: l.id, name: 'Dhirendra Oke', email: 'dhirendra@mojj.in', emailStatus: 'inferred', emailSource: 'inferred', isPrimary: true });
    for (const s of SCHEMA_STATEMENTS.filter((s) => /SET contact_email = ''|SET email = ''/.test(s))) await db.execute(sql.raw(s));
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactEmail: '', emailStatus: '', emailSource: '', emailRetrievedAt: null, contactName: 'Ravi Shah' });
    expect((await db.select().from(people).where(eq(people.leadId, l.id)))[0]).toMatchObject({ email: '', emailStatus: '', emailSource: '', name: 'Dhirendra Oke' });
    expect(TRACKER_HEADERS.some((h) => /email id/i.test(h))).toBe(false);
  });
});

describe("INVECK's own lead list", () => {
  it('imports a CSV of companies by Company and Website columns, skipping ones already on the list', async () => {
    const db = await getDb();
    const { importKnownCompanies, listKnownCompanies } = await import('@/lib/known-companies');
    const { parseCsv } = await import('@/lib/csv');
    const r1 = await importKnownCompanies(db, parseCsv('Sr No,Company Name,Website,Owner\n1,Mojj Engineering Systems Ltd,mojjpune.com,Puja\n2,RR Kabel,https://www.rrkabel.com/,Anchal\n3,,x.com,Puja\n'));
    expect(r1).toEqual({ added: 2, skipped: 0 });
    const r2 = await importKnownCompanies(db, parseCsv('Company,Website\nMOJJ ENGINEERING SYSTEMS LIMITED,\nNBC Bearings,rrkabel.com\nNBC Bearings,nbcbearings.com\n'));
    expect(r2.added).toBe(1);
    const list = await listKnownCompanies(db);
    expect(list.map((k) => k.company)).toEqual(expect.arrayContaining(['Mojj Engineering Systems Ltd', 'RR Kabel', 'NBC Bearings']));
    expect(list.find((k) => k.company === 'RR Kabel')?.website).toBe('rrkabel.com');
  });

  it('clears the current leads once before handover, keeping logins, ICPs, clients and the own-lead list', async () => {
    const db = await getDb();
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const { clients, knownCompanies, settings } = await import('@/lib/db/schema');
    const { sql } = await import('drizzle-orm');
    // Simulate a database from before the clear: leads, a client, an own-lead entry, no marker yet.
    await db.delete(settings).where(eq(settings.key, 'clearLeadsV2'));
    await db.insert(leads).values(lead('Old Lead Co'));
    await db.insert(clients).values({ company: 'Kept Client' });
    await db.insert(knownCompanies).values({ company: 'Kept Own Lead' });
    for (const s of SCHEMA_STATEMENTS.filter((s) => s.includes('clearLeadsV2'))) await db.execute(sql.raw(s));
    expect(await db.select().from(leads)).toEqual([]);
    expect((await db.select().from(clients)).some((c) => c.company === 'Kept Client')).toBe(true);
    expect((await db.select().from(knownCompanies)).some((k) => k.company === 'Kept Own Lead')).toBe(true);
    expect((await db.select().from(users)).length).toBeGreaterThan(0);
    // Runs once: new leads after it are never cleared again.
    await db.insert(leads).values(lead('New Lead Co'));
    for (const s of SCHEMA_STATEMENTS.filter((s) => s.includes('clearLeadsV2'))) await db.execute(sql.raw(s));
    expect((await db.select().from(leads)).map((l) => l.company)).toEqual(['New Lead Co']);
  });
});
