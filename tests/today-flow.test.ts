import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, people, tasks, users } from '@/lib/db/schema';
import { ensureSequences, FIND_NEXT_STEP, istDay, loadTodayTasks, nextDue } from '@/lib/tasks';
import { saveContactEdit } from '@/lib/contact-edit';

let db: Db;
let owner: number;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  owner = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const SUNDAY = '2026-10-04';
const MONDAY = '2026-10-05';
const addLead = async (values: Partial<typeof leads.$inferInsert>) =>
  (await db.insert(leads).values({ company: 'Unique Shell', city: 'Coimbatore', segment: 'Manufacturing', ownerId: owner, qualified: true, ...values }).returning())[0];

describe('leads go from the Leads list to Today on their own', () => {
  it('a lead ready for approval gets its first call, WhatsApp, email and LinkedIn steps on the next working day', async () => {
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'Ananda Kumar', contactTitle: 'Works Manager', contactLinkedin: 'https://in.linkedin.com/in/ananda' });
    await ensureSequences(db, SUNDAY);
    // A Sunday: nothing is due today, and the page says when the steps start.
    expect(await loadTodayTasks(db, owner, SUNDAY)).toEqual([]);
    expect(await nextDue(db, owner, SUNDAY)).toEqual({ day: MONDAY, companies: 1 });
    const monday = await loadTodayTasks(db, owner, MONDAY);
    expect(monday.map((t) => t.task.kind).sort()).toEqual(['call', 'email', 'linkedin', 'whatsapp']);
    expect(monday.every((t) => t.lead.id === l.id)).toBe(true);
  });

  it('a lead waiting for a contact with nobody eligible on file goes to Deleted, not onto Today', async () => {
    const l = await addLead({ status: 'Needs Manual Contact' });
    await ensureSequences(db, SUNDAY);
    expect(await loadTodayTasks(db, owner, MONDAY)).toEqual([]);
    const [gone] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(gone).toMatchObject({ status: 'Deleted', statusBeforeDelete: 'Needs Manual Contact' });
    expect((await db.select().from(tasks).where(eq(tasks.leadId, l.id))).some((t) => t.step === FIND_NEXT_STEP)).toBe(false);
  });

  it('with a P1 or P2 on file, the lead stays on Today with a step to choose them; naming someone starts the sequence', async () => {
    const l = await addLead({ status: 'Needs Manual Contact' });
    await db.insert(people).values({ leadId: l.id, name: 'Asha Rao', title: 'Inventory Manager' });
    await ensureSequences(db, SUNDAY);
    const monday = await loadTodayTasks(db, owner, MONDAY);
    expect(monday.map((t) => [t.lead.id, t.task.step, t.task.title])).toEqual([[l.id, FIND_NEXT_STEP, 'Choose the next contact: Asha Rao (P2) is on file']]);
    // Run again: no second step.
    await ensureSequences(db, SUNDAY);
    expect((await db.select().from(tasks).where(eq(tasks.leadId, l.id))).length).toBe(1);

    // The team names someone: ready for approval, the step closes and the sequence starts.
    await saveContactEdit(db, l.id, { contactName: 'Ravi K', contactTitle: 'Plant Head', contactPhone: '9876543210', contactEmail: '', contactLinkedin: '' });
    await ensureSequences(db, MONDAY);
    const open = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), isNull(tasks.doneAt)));
    expect(open.some((t) => t.step === FIND_NEXT_STEP)).toBe(false);
    expect(open.map((t) => t.kind)).toContain('call');
    // Saving plans from the real day, so look on the day the first call is due.
    const firstCall = open.filter((t) => t.kind === 'call').map((t) => t.dueDate).sort()[0];
    expect((await loadTodayTasks(db, owner, firstCall)).some((t) => t.lead.id === l.id && t.task.kind === 'call')).toBe(true);
  });

  it('the one-time sweep deletes only leads with nobody eligible; others, restored and unassigned leads stay', async () => {
    const { retireWithoutContact, FIND_NEXT_STEP: FIND } = await import('@/lib/escalate');
    const none = await addLead({ company: 'No One Co', status: 'Needs Manual Contact' });
    const withP2 = await addLead({ company: 'Has P2 Co', status: 'Needs Manual Contact' });
    await db.insert(people).values({ leadId: withP2.id, name: 'Asha Rao', title: 'Inventory Manager' });
    const confirming = await addLead({ company: 'Confirm Co', status: 'Needs Manual Contact', contactName: 'Srihari K.R' });
    const unowned = await addLead({ company: 'Pool Co', status: 'Needs Manual Contact', ownerId: null });
    const oldFind = await addLead({ company: 'Old Find Co', status: 'Contacted', contactName: 'Ravi Shah' });
    await db.insert(tasks).values({ leadId: oldFind.id, ownerId: owner, kind: 'call', step: FIND, title: 'Find the next person to contact (P2: process owner)', dueDate: MONDAY });
    const gone = await retireWithoutContact(db);
    expect(gone.sort()).toEqual([none.id, oldFind.id].sort());
    for (const l of [withP2, confirming, unowned]) expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].status).not.toBe('Deleted');
    expect((await db.select().from(tasks).where(and(eq(tasks.leadId, oldFind.id), isNull(tasks.doneAt)))).length).toBe(0);
  });

  it('a named contact not yet confirmed at the site: the step asks to confirm them, or find someone', async () => {
    await addLead({ status: 'Needs Manual Contact', contactName: 'Srihari K.R' });
    await ensureSequences(db, MONDAY);
    const [t] = await loadTodayTasks(db, owner, MONDAY);
    expect(t.task.title).toBe("Confirm Srihari K.R is at the Coimbatore site, or find the person to contact");
  });

  it('the "next steps" count is the companies Today will show that day: not deleted, rejected or set-aside leads', async () => {
    const shown = await addLead({ status: 'Awaiting Approval', contactName: 'A', contactLinkedin: 'https://in.linkedin.com/in/a' });
    const rejected = await addLead({ company: 'Gone Co', status: 'Awaiting Approval', contactName: 'B', contactLinkedin: 'https://in.linkedin.com/in/b' });
    const deleted = await addLead({ company: 'Deleted Co', status: 'Awaiting Approval', contactName: 'C', contactLinkedin: 'https://in.linkedin.com/in/c' });
    await ensureSequences(db, SUNDAY);
    await db.update(leads).set({ status: 'Rejected' }).where(eq(leads.id, rejected.id));
    // A lead deleted the old way, leaving its planned steps behind.
    await db.delete(leads).where(eq(leads.id, deleted.id));
    const monday = await loadTodayTasks(db, owner, MONDAY);
    expect(new Set(monday.map((t) => t.lead.id))).toEqual(new Set([shown.id]));
    expect(await nextDue(db, owner, SUNDAY)).toEqual({ day: MONDAY, companies: 1 });
  });
});

describe('calling again after no answer: the day split at 2 pm IST', () => {
  it('before 2 pm: again at 5 pm today; from 2 pm: again at 9 am the next working day', async () => {
    const { callAgainAt } = await import('@/lib/tasks');
    // Monday 5 Oct 2026, India time.
    expect(callAgainAt(new Date('2026-10-05T10:00:00+05:30'))).toEqual({ day: '2026-10-05', slot: 'evening' });
    expect(callAgainAt(new Date('2026-10-05T13:59:00+05:30'))).toEqual({ day: '2026-10-05', slot: 'evening' });
    expect(callAgainAt(new Date('2026-10-05T18:00:00+05:30'))).toEqual({ day: '2026-10-06', slot: 'morning' });
    // Friday evening: Monday morning.
    expect(callAgainAt(new Date('2026-10-09T18:00:00+05:30'))).toEqual({ day: '2026-10-12', slot: 'morning' });
    // A Saturday: Monday morning.
    expect(callAgainAt(new Date('2026-10-10T10:00:00+05:30'))).toEqual({ day: '2026-10-12', slot: 'morning' });
  });

  it('a 5 pm call shows on Today from 5 pm (listed as later today before that); a 9 am call from 9 am', async () => {
    const { laterToday } = await import('@/lib/tasks');
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'A', contactLinkedin: 'https://in.linkedin.com/in/a' });
    await db.insert(tasks).values([
      { leadId: l.id, ownerId: owner, kind: 'call', step: 'Call again', title: 'Call again at 5 pm', dueDate: MONDAY, slot: 'evening' },
    ]);
    const at = (h: string) => new Date(`${MONDAY}T${h}:00+05:30`);
    expect((await loadTodayTasks(db, owner, MONDAY, at('10:00'))).length).toBe(0);
    expect((await laterToday(db, owner, MONDAY, at('10:00'))).map((t) => t.lead.id)).toEqual([l.id]);
    expect((await loadTodayTasks(db, owner, MONDAY, at('17:05'))).length).toBe(1);
    expect(await laterToday(db, owner, MONDAY, at('17:05'))).toEqual([]);
    await db.update(tasks).set({ slot: 'morning', title: 'Call again at 9 am' }).where(eq(tasks.leadId, l.id));
    expect((await loadTodayTasks(db, owner, MONDAY, at('08:30'))).length).toBe(0);
    expect((await loadTodayTasks(db, owner, MONDAY, at('09:00'))).length).toBe(1);
  });
});

describe('calls attempted', () => {
  it('counts numbers actually dialled, not "No contact found" or skips', async () => {
    const { dayCounts } = await import('@/lib/tasks');
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'A', contactLinkedin: 'https://in.linkedin.com/in/a' });
    const now = new Date();
    const call = (outcome: string) => ({ leadId: l.id, ownerId: owner, kind: 'call' as const, step: 'Day 1', title: 'call', dueDate: istDay(), slot: 'day' as const, doneAt: now, outcome });
    await db.insert(tasks).values([call('connected'), call('no_answer'), call('busy'), call('wrong_number'), call('no_contact'), call('no_contact'), call('skipped'), call('closed')]);
    const c = await dayCounts(db, owner, istDay());
    expect(c.callAttempts).toBe(4);
    expect(c.connectedCalls).toBe(1);
  });
});

describe('Fresh leads and Follow-up on Today', () => {
  it('first-contact steps are told apart from follow-up rounds, CA rounds, callbacks and calls again', async () => {
    const { isFirstContact, CA_WAITING_STEP } = await import('@/lib/tasks');
    const t = (extra: Partial<{ step: string; priority: boolean; followUpRound: number; caRound: number }>) => ({ step: 'Day 1', priority: false, followUpRound: 0, caRound: 0, ...extra });
    expect(isFirstContact(t({}))).toBe(true);
    expect(isFirstContact(t({ step: FIND_NEXT_STEP }))).toBe(true);
    expect(isFirstContact(t({ step: CA_WAITING_STEP }))).toBe(true);
    expect(isFirstContact(t({ step: 'Follow-up 2', followUpRound: 2 }))).toBe(false);
    expect(isFirstContact(t({ step: 'Not accepted on LinkedIn', caRound: 1 }))).toBe(false);
    expect(isFirstContact(t({ step: 'Promised callback', priority: true }))).toBe(false);
    expect(isFirstContact(t({ step: 'Call again' }))).toBe(false);
  });
});
