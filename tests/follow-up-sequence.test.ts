import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, people, settings, tasks, users } from '@/lib/db/schema';
import { ensureSequences, istDay } from '@/lib/tasks';
import {
  followUpDates,
  hasConnectedCall,
  JUNK_REASON,
  rescheduleFollowUps,
  restoreLead,
  sequenceComplete,
  startFollowUpSequence,
} from '@/lib/follow-up-sequence';
import { reconcileFollowUps } from '@/lib/follow-up-reconcile';
import { getHolidays, saveHolidays } from '@/lib/holidays';
import { loadFunnel } from '@/lib/followups';

const me = { id: 0, role: 'bda' as const, name: 'Puja' };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const today = () => istDay();
const form = (v: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, String(x));
  return f;
};
const openTasks = (leadId: number) => db.select().from(tasks).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt)));
const rounds = (leadId: number) => db.select().from(tasks).where(and(eq(tasks.leadId, leadId), gt(tasks.followUpRound, 0))).orderBy(asc(tasks.followUpRound), asc(tasks.id));
const leadOf = async (id: number) => (await db.select().from(leads).where(eq(leads.id, id)))[0];
/** A lead with its Day 1 steps planned and due today. */
async function mk(extra: Partial<typeof leads.$inferInsert> = {}) {
  const [l] = await db.insert(leads).values({ company: 'Seq Co', segment: 'Manufacturing', status: 'Approved', ownerId: me.id, contactName: 'Ravi Shah', contactTitle: 'Plant Head', contactPhone: '9800000001', ...extra }).returning();
  await ensureSequences(db, today());
  await db.update(tasks).set({ dueDate: today() }).where(eq(tasks.leadId, l.id));
  return l;
}
const dayOne = async (leadId: number, kind: 'call' | 'whatsapp' | 'email') => (await openTasks(leadId)).find((t) => t.kind === kind && t.followUpRound === 0)!;

describe('the dates: every other working day', () => {
  it('Follow-up 1 to 5 fall 2, 4, 6, 8 and 10 working days after Day 1; weekends never count', () => {
    // 2026-09-25 is a Friday: Monday is the skipped working day, so Follow-up 1 is Tuesday.
    expect(followUpDates('2026-09-25')).toEqual(['2026-09-29', '2026-10-01', '2026-10-05', '2026-10-07', '2026-10-09']);
    // Monday: Wed, Fri, Tue, Thu, Mon.
    expect(followUpDates('2026-09-28')).toEqual(['2026-09-30', '2026-10-02', '2026-10-06', '2026-10-08', '2026-10-12']);
    for (const start of ['2026-09-25', '2026-09-28', '2026-10-01']) for (const d of followUpDates(start)) expect([0, 6]).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
  });

  it('a holiday is skipped like a weekend', () => {
    expect(followUpDates('2026-09-25', new Set(['2026-09-29']))).toEqual(['2026-09-30', '2026-10-02', '2026-10-06', '2026-10-08', '2026-10-12']);
  });

  it('a call on a Friday plans the rounds from that day, in India time', async () => {
    const l = await mk();
    // Friday 25 Sep 2026, 10:30 in India.
    const dates = await startFollowUpSequence(db, l.id, new Date('2026-09-25T05:00:00Z'));
    expect(dates).toEqual(['2026-09-29', '2026-10-01', '2026-10-05', '2026-10-07', '2026-10-09']);
    const made = await rounds(l.id);
    expect(made).toHaveLength(15);
    expect(new Set(made.map((t) => t.kind))).toEqual(new Set(['call', 'whatsapp', 'email']));
    expect([...new Set(made.map((t) => `${t.followUpRound}:${t.dueDate}`))]).toEqual(['1:2026-09-29', '2:2026-10-01', '3:2026-10-05', '4:2026-10-07', '5:2026-10-09']);
    expect((await leadOf(l.id)).followUpStartedOn).toBe('2026-09-25');
  });
});

describe('what starts the sequence', () => {
  it.each(['no_answer', 'busy', 'wrong_number'])('a call saved as %s starts it at once, with no separate action', async (outcome) => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk();
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome }));
    expect(await rounds(l.id)).toHaveLength(15);
    expect((await leadOf(l.id)).followUpStartedOn).toBe(today());
  });

  it('no contact found, a skipped call, WhatsApp sent and email sent do not', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk({ status: 'Contacted' });
    const [call, email, whatsapp] = [await dayOne(l.id, 'call'), await dayOne(l.id, 'email'), await dayOne(l.id, 'whatsapp')];
    await completeTaskAction(form({ id: email.id, outcome: 'done' }));
    await completeTaskAction(form({ id: whatsapp.id, outcome: 'sent' }));
    await completeTaskAction(form({ id: call.id, outcome: 'no_contact' }));
    expect(await rounds(l.id)).toHaveLength(0);
    const l2 = await mk({ company: 'Other Co', status: 'Contacted' });
    await completeTaskAction(form({ id: (await dayOne(l2.id, 'call')).id, outcome: 'skipped' }));
    expect(await rounds(l2.id)).toHaveLength(0);
    // New, Contacted or a sent email alone start nothing: a plan has only Day 1.
    expect((await openTasks(l2.id)).every((t) => t.followUpRound === 0)).toBe(true);
  });

  it('no contact found during the sequence ends it for the company: every open round is ticked off, the company stays, and Undo brings them back (27 Oct)', async () => {
    const { completeTaskAction, undoTaskAction } = await import('@/app/team-actions');
    const l = await mk();
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'no_answer' }));
    expect(await rounds(l.id)).toHaveLength(15);
    const r1 = (await rounds(l.id)).find((t) => t.followUpRound === 1 && t.kind === 'call')!;
    await db.update(tasks).set({ dueDate: today() }).where(eq(tasks.id, r1.id));
    await completeTaskAction(form({ id: r1.id, outcome: 'no_contact' }));
    expect((await rounds(l.id)).filter((t) => !t.doneAt)).toHaveLength(0);
    expect((await rounds(l.id)).filter((t) => t.id !== r1.id).every((t) => t.outcome === 'closed')).toBe(true);
    expect((await leadOf(l.id)).status).not.toBe('Deleted');
    // Nothing starts them again: another unanswered call later doesn't.
    const [later] = await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'call', step: 'Call again', title: 'later', dueDate: today() }).returning();
    await completeTaskAction(form({ id: later.id, outcome: 'no_answer' }));
    expect((await rounds(l.id)).filter((t) => !t.doneAt)).toHaveLength(0);
    await undoTaskAction(form({ id: later.id }));
    // Undo of the no-contact call brings every round back.
    await undoTaskAction(form({ id: r1.id }));
    expect((await rounds(l.id)).filter((t) => !t.doneAt)).toHaveLength(15);
  });

  it('once on the live database: companies already marked "No contact found" during their follow-ups have their open rounds ticked off, with a note (27 Oct)', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const { sql } = await import('drizzle-orm');
    // Before the fix: a round call saved as no contact found left the other rounds open.
    const marked = await mk();
    await completeTaskAction(form({ id: (await dayOne(marked.id, 'call')).id, outcome: 'no_answer' }));
    const r1 = (await rounds(marked.id)).find((t) => t.followUpRound === 1 && t.kind === 'call')!;
    await db.update(tasks).set({ doneAt: new Date(), outcome: 'no_contact' }).where(eq(tasks.id, r1.id));
    // Untouched: a company in follow-ups with no such call, and one marked before its follow-ups started (a number turned up since).
    const plain = await mk({ company: 'Plain Co' });
    await completeTaskAction(form({ id: (await dayOne(plain.id, 'call')).id, outcome: 'no_answer' }));
    const earlier = await mk({ company: 'Earlier Co' });
    await db.insert(tasks).values({ leadId: earlier.id, ownerId: me.id, kind: 'call', step: 'Call again', title: 'old', dueDate: today(), doneAt: new Date(Date.now() - 86_400_000), outcome: 'no_contact' });
    await completeTaskAction(form({ id: (await dayOne(earlier.id, 'call')).id, outcome: 'no_answer' }));
    const step = SCHEMA_STATEMENTS.filter((x) => x.includes('noContactFollowUpsV1'));
    expect(step).toHaveLength(3);
    for (let i = 0; i < 2; i++) for (const x of step) await db.execute(sql.raw(x));
    expect((await rounds(marked.id)).filter((t) => !t.doneAt)).toHaveLength(0);
    expect((await rounds(marked.id)).filter((t) => t.id !== r1.id).every((t) => t.outcome === 'closed')).toBe(true);
    expect((await leadOf(marked.id)).status).not.toBe('Deleted');
    const notes = (await db.select().from(activities).where(eq(activities.leadId, marked.id))).filter((a) => a.text.startsWith('Follow-ups stopped: "No contact found"'));
    expect(notes).toHaveLength(1);
    expect((await rounds(plain.id)).filter((t) => !t.doneAt)).toHaveLength(15);
    expect((await rounds(earlier.id)).filter((t) => !t.doneAt)).toHaveLength(15);
  });

  it('another qualifying outcome during the sequence does not duplicate or reset it', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk();
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'no_answer' }));
    const before = await rounds(l.id);
    await db.update(leads).set({ followUpStartedOn: '2026-01-05' }).where(eq(leads.id, l.id));
    const [extra] = await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'call', step: 'Call again', title: 'extra', dueDate: today() }).returning();
    await completeTaskAction(form({ id: extra.id, outcome: 'busy' }));
    expect(await rounds(l.id)).toHaveLength(before.length);
    expect((await leadOf(l.id)).followUpStartedOn).toBe('2026-01-05');
  });

  it('undoing the call takes the sequence back', async () => {
    const { completeTaskAction, undoTaskAction } = await import('@/app/team-actions');
    const l = await mk();
    const call = await dayOne(l.id, 'call');
    await completeTaskAction(form({ id: call.id, outcome: 'no_answer' }));
    expect(await rounds(l.id)).toHaveLength(15);
    await undoTaskAction(form({ id: call.id }));
    expect(await rounds(l.id)).toHaveLength(0);
    expect((await leadOf(l.id)).followUpStartedOn).toBe('');
  });

  it('a wrong number with another saved number retries at once; that retry is not a round', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk({ contactPhone: '9800000001, 9800000002' });
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'wrong_number' }));
    const left = await openTasks(l.id);
    expect(left.filter((t) => t.title === 'Call the next number')).toHaveLength(1);
    expect(left.find((t) => t.title === 'Call the next number')!.followUpRound).toBe(0);
    expect(await rounds(l.id)).toHaveLength(15);
    expect((await leadOf(l.id)).contactPhone).toBe('9800000002');
  });
});

describe('a connected call', () => {
  it('stops the sequence: open rounds are cancelled, the draft cleared, the lead leaves the funnel; Undo brings it back', async () => {
    const { completeTaskAction, undoTaskAction } = await import('@/app/team-actions');
    const l = await mk();
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'no_answer' }));
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), eq(tasks.followUpRound, 1)));
    await db.update(leads).set({ followUpSubject: 'Re: x', followUpBody: 'draft' }).where(eq(leads.id, l.id));
    const call = (await openTasks(l.id)).find((t) => t.kind === 'call' && t.followUpRound === 1)!;
    await completeTaskAction(form({ id: call.id, outcome: 'connected', note: 'Spoke to him', feedback: 'Interested' }));
    expect((await openTasks(l.id)).filter((t) => t.followUpRound > 0)).toHaveLength(0);
    expect((await rounds(l.id)).filter((t) => t.outcome === 'closed').length).toBeGreaterThan(0);
    const after = await leadOf(l.id);
    expect(after.followUpBody).toBe('');
    expect((await loadFunnel(db, me.id, today())).find((c) => c.lead.id === l.id)?.stage).not.toBe('today');
    // Undo puts the cancelled rounds back.
    await undoTaskAction(form({ id: call.id }));
    expect((await openTasks(l.id)).filter((t) => t.followUpRound > 0).length).toBeGreaterThan(0);
  });

  it('never starts it, and a promised callback does not enrol the lead', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk();
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'connected', note: 'Call me Friday', feedback: 'Call back later', callbackDate: '2099-01-02' }));
    expect((await leadOf(l.id)).followUpStartedOn).toBe('');
    expect(await rounds(l.id)).toHaveLength(0);
    expect(await hasConnectedCall(db, await leadOf(l.id))).toBe(true);
    // The callback itself is a priority task, and an unanswered callback still doesn't enrol the lead.
    const cb = (await openTasks(l.id)).find((t) => t.priority)!;
    expect(cb.followUpRound).toBe(0);
    await completeTaskAction(form({ id: cb.id, outcome: 'no_answer' }));
    expect(await rounds(l.id)).toHaveLength(0);
  });
});

describe('after Follow-up 5: Deleted (junk), nothing erased', () => {
  const work = async (leadId: number, round: number, outcomes: Record<string, string> = {}) => {
    const { completeTaskAction } = await import('@/app/team-actions');
    for (const t of (await rounds(leadId)).filter((r) => r.followUpRound === round && !r.doneAt)) {
      await completeTaskAction(form({ id: t.id, outcome: outcomes[t.kind] ?? (t.kind === 'call' ? 'no_answer' : t.kind === 'email' ? 'done' : 'sent') }));
    }
  };

  it('five finished rounds move the lead to Deleted with the reason; a round left undone does not', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk({ status: 'Contacted' });
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'no_answer' }));
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), gt(tasks.followUpRound, 0)));
    for (const n of [1, 2, 3, 4]) await work(l.id, n);
    expect((await leadOf(l.id)).status).not.toBe('Deleted');
    // Round 5 due date passed, but nothing in it has been done: still not Deleted.
    expect(await sequenceComplete(db, l.id)).toBe(false);
    // Two of its three steps done: still open.
    const r5 = (await rounds(l.id)).filter((t) => t.followUpRound === 5);
    await completeTaskAction(form({ id: r5.find((t) => t.kind === 'call')!.id, outcome: 'no_answer' }));
    await completeTaskAction(form({ id: r5.find((t) => t.kind === 'whatsapp')!.id, outcome: 'sent' }));
    expect((await leadOf(l.id)).status).toBe('Contacted');
    // The last step explicitly skipped counts as complete.
    await completeTaskAction(form({ id: r5.find((t) => t.kind === 'email')!.id, outcome: 'skipped' }));
    const gone = await leadOf(l.id);
    expect(gone.status).toBe('Deleted');
    expect(gone.deletedReason).toBe(JUNK_REASON);
    expect(gone.statusBeforeDelete).toBe('Contacted');
    // Nothing erased: the lead, its call/message records and its timeline.
    expect((await rounds(l.id)).length).toBe(15);
    expect((await rounds(l.id)).every((t) => t.doneAt)).toBe(true);
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((t) => t.startsWith('Moved to Deleted'))).toBe(true);
    expect(log.some((t) => t.startsWith('Follow-up sequence started'))).toBe(true);
    // Out of active work.
    expect((await loadFunnel(db, me.id, today())).some((c) => c.lead.id === l.id)).toBe(false);
  });

  it('a cancelled (bulk ticked-off) step is not a completed one', async () => {
    const l = await mk();
    await startFollowUpSequence(db, l.id);
    await db.update(tasks).set({ doneAt: new Date(), outcome: 'sent' }).where(and(eq(tasks.leadId, l.id), gt(tasks.followUpRound, 0)));
    expect(await sequenceComplete(db, l.id)).toBe(true);
    const [one] = await rounds(l.id);
    await db.update(tasks).set({ outcome: 'closed' }).where(eq(tasks.id, one.id));
    expect(await sequenceComplete(db, l.id)).toBe(false);
  });

  it('restoring puts the lead back where it was, and it is not enrolled again', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await mk({ status: 'Contacted' });
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'busy' }));
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), gt(tasks.followUpRound, 0)));
    for (const n of [1, 2, 3, 4, 5]) await work(l.id, n);
    expect((await leadOf(l.id)).status).toBe('Deleted');
    expect(await restoreLead(db, l.id, 'Puja')).toBe(true);
    const back = await leadOf(l.id);
    expect(back).toMatchObject({ status: 'Contacted', deletedReason: '', deletedAt: null });
    expect(await startFollowUpSequence(db, l.id)).toBeNull();
    expect(await rounds(l.id)).toHaveLength(15);
  });

  it('five unanswered calls never switch the contact or stop the sequence, even with someone else on file', async () => {
    const l = await mk({ status: 'Contacted' });
    await db.insert(people).values({ leadId: l.id, name: 'Inv Manager', title: 'Inventory Manager', linkedin: 'https://in.linkedin.com/in/inv', source: 'LinkedIn' });
    const { completeTaskAction } = await import('@/app/team-actions');
    await completeTaskAction(form({ id: (await dayOne(l.id, 'call')).id, outcome: 'no_answer' }));
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), gt(tasks.followUpRound, 0)));
    for (const n of [1, 2, 3, 4]) await work(l.id, n);
    expect((await openTasks(l.id)).some((t) => t.step === 'Find the next person')).toBe(false);
    expect((await leadOf(l.id)).contactName).toBe('Ravi Shah');
    expect((await openTasks(l.id)).filter((t) => t.followUpRound === 5)).toHaveLength(3);
  });
});

describe('holidays', () => {
  it('a holiday moves the open rounds to the next working days; done steps stay', async () => {
    const l = await mk();
    await startFollowUpSequence(db, l.id, new Date('2026-09-25T05:00:00Z'));
    const [done] = (await rounds(l.id)).filter((t) => t.followUpRound === 1);
    await db.update(tasks).set({ doneAt: new Date(), outcome: 'sent' }).where(eq(tasks.id, done.id));
    await saveHolidays(db, ['2026-10-01']);
    expect([...(await getHolidays(db))]).toEqual(['2026-10-01']);
    await rescheduleFollowUps(db);
    const by = Object.fromEntries((await rounds(l.id)).map((t) => [t.followUpRound, t.dueDate]));
    expect(by).toEqual({ 1: '2026-09-29', 2: '2026-10-02', 3: '2026-10-06', 4: '2026-10-08', 5: '2026-10-12' });
    // Taking it off puts them back.
    await saveHolidays(db, []);
    await rescheduleFollowUps(db);
    expect((await rounds(l.id)).find((t) => t.followUpRound === 2)!.dueDate).toBe('2026-10-01');
  });

  it('ignores anything that is not a date', async () => {
    await saveHolidays(db, ['2026-10-01', 'tomorrow', '2026-13-45']);
    expect([...(await getHolidays(db))]).toEqual(['2026-10-01']);
  });
});

describe('existing records', () => {
  const doneCall = (leadId: number, outcome: string, daysAgo: number) =>
    db.insert(tasks).values({ leadId, ownerId: me.id, kind: 'call', step: 'Day 1', title: 'call', dueDate: today(), doneAt: new Date(Date.now() - daysAgo * 86_400_000), outcome });

  it('enrols from the saved call outcomes only, keeps finished old rounds, and can be run again', async () => {
    const mkLead = async (company: string, extra: Partial<typeof leads.$inferInsert> = {}) => (await db.insert(leads).values({ company, segment: 'Manufacturing', status: 'Contacted', ownerId: me.id, contactName: 'X Y', ...extra }).returning())[0];
    const a = await mkLead('Unanswered Co');
    await doneCall(a.id, 'no_answer', 3);
    // One old round fully done, one open: kept as round 1, the open one replaced.
    await db.insert(tasks).values([
      { leadId: a.id, ownerId: me.id, kind: 'call', step: 'Follow-up 1', title: 'c', dueDate: today(), doneAt: new Date(), outcome: 'no_answer' },
      { leadId: a.id, ownerId: me.id, kind: 'email', step: 'Follow-up 1', title: 'e', dueDate: today(), doneAt: new Date(), outcome: 'done' },
      { leadId: a.id, ownerId: me.id, kind: 'call', step: 'Follow-up 2', title: 'c', dueDate: today() },
    ]);
    const b = await mkLead('Connected Co');
    await doneCall(b.id, 'no_answer', 4);
    await doneCall(b.id, 'connected', 2);
    await db.insert(tasks).values({ leadId: b.id, ownerId: me.id, kind: 'call', step: 'Follow-up 1', title: 'c', dueDate: today() });
    const c = await mkLead('Scheduled Only Co', { nextFollowUpAt: new Date(), followUpBody: 'old draft' });
    const d = await mkLead('Replied Co', { status: 'Replied' });
    await doneCall(d.id, 'busy', 5);
    const e = await mkLead('Stage Only Co');

    const report = await reconcileFollowUps(db);
    expect(report).toMatchObject({ enrolled: 1, keptRounds: 1 });
    expect(report.needsReview.map((r) => r.company)).toEqual(['Replied Co']);

    expect((await leadOf(a.id)).followUpStartedOn).toBe(istDay(new Date(Date.now() - 3 * 86_400_000)));
    const made = await rounds(a.id);
    expect(new Set(made.map((t) => t.followUpRound))).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(made.filter((t) => t.followUpRound === 1 && t.doneAt)).toHaveLength(2);
    // Round 1 was not planned again; the open old Follow-up 2 step was replaced by the new round 2.
    expect(made.filter((t) => t.followUpRound === 1)).toHaveLength(2);
    expect((await db.select().from(tasks).where(and(eq(tasks.leadId, a.id), eq(tasks.step, 'Follow-up 2'), isNull(tasks.doneAt), eq(tasks.followUpRound, 0)))).length).toBe(0);

    // A connected call: not enrolled, its old open step is cancelled.
    expect(await rounds(b.id)).toHaveLength(0);
    expect((await openTasks(b.id)).length).toBe(0);
    // A schedule from the old mechanism alone enrols nobody; it and its draft are cleared.
    const cleared = await leadOf(c.id);
    expect(cleared).toMatchObject({ followUpStartedOn: '', nextFollowUpAt: null, followUpBody: '' });
    // Left alone: a reply, and a lead with nothing saved.
    expect(await rounds(d.id)).toHaveLength(0);
    expect(await rounds(e.id)).toHaveLength(0);

    // Running it again changes nothing.
    const count = (await db.select().from(tasks)).length;
    const again = await reconcileFollowUps(db);
    expect(again.enrolled).toBe(0);
    expect((await db.select().from(tasks)).length).toBe(count);
    expect((await db.select().from(settings).where(eq(settings.key, 'followUpSeqV1'))).length).toBe(1);
  });
});
