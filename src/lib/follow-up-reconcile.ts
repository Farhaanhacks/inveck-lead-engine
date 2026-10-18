import { and, eq, inArray, isNotNull, isNull, like, notInArray, or } from 'drizzle-orm';
import type { Db } from './db';
import { leads, settings, tasks, type LeadStatus, type Task } from './db/schema';
import { logActivity } from './activity';
import { followUpPlan, isQualifyingOutcome } from './follow-up-sequence';
import { getHolidays } from './holidays';
import { isCaSegment, isSameDayRetry, istDay } from './tasks';

/** Where an existing lead can be enrolled; any other stage with a qualifying call is left for a person to look at. */
const ENROLLABLE: LeadStatus[] = ['Awaiting Approval', 'Approved', 'Contacted'];
/** The old plan's rounds (Follow-up 1 to 3 on consecutive days). */
const OLD_ROUND = /^Follow-up ([1-3])$/;

export type ReconcileReport = {
  at: string;
  /** Leads put into the new sequence, and how many of their old rounds were kept as completed rounds. */
  enrolled: number;
  keptRounds: number;
  /** Open steps of the old cadence that were ticked off, on leads that are or aren't in the new sequence. */
  cancelledSteps: number;
  /** Old 3-day / 7-day schedules cleared. */
  oldSchedulesCleared: number;
  /** Leads with a qualifying call that couldn't be classified safely: left as they were. */
  needsReview: { id: number; company: string; reason: string }[];
};

const completed = (t: Task) => !!t.doneAt && t.outcome !== 'closed';
/** Open steps of the old cadence: its follow-up rounds, and the "call again" reminders (not the same-day retry of a wrong number). */
const oldCadence = (t: Task) => t.followUpRound === 0 && !t.doneAt && !t.priority && (OLD_ROUND.test(t.step) || (t.step === 'Call again' && !isSameDayRetry(t)));

/**
 * Brings existing records onto the new follow-up rules, from the saved call outcomes (never from a
 * lead's stage). Safe to run again: a lead already in the sequence is skipped, and nothing it does can
 * happen twice.
 * - A lead with a no answer / busy / wrong number call and no connected call to the current contact is
 *   enrolled, with Day 1 the day of its earliest such call. Old rounds (Follow-up 1 to 3) that were fully
 *   done are kept as completed rounds 1 to 3; the rest of the five are planned. Dates come from Day 1,
 *   so rounds already past are overdue on Today, not moved.
 * - Open steps of the old cadence are ticked off for every lead that isn't enrolled.
 * - The old 3-day / 7-day schedule is cleared; drafts it had written for leads not enrolled are dropped.
 * - A qualifying call on a lead that is past outreach (a reply, a meeting, a loss...) or has no owner is
 *   not touched and is listed for review.
 */
export async function reconcileFollowUps(db: Db, now = new Date()): Promise<ReconcileReport> {
  const report: ReconcileReport = { at: now.toISOString(), enrolled: 0, keptRounds: 0, cancelledSteps: 0, oldSchedulesCleared: 0, needsReview: [] };
  const holidays = await getHolidays(db);
  const all = await db.select().from(leads).where(notInArray(leads.status, ['Deleted']));
  const scheduled = new Set(all.filter((l) => l.nextFollowUpAt).map((l) => l.id));
  const rows = await db
    .select()
    .from(tasks)
    .where(or(and(eq(tasks.kind, 'call'), isNotNull(tasks.doneAt)), and(eq(tasks.followUpRound, 0), or(like(tasks.step, 'Follow-up %'), eq(tasks.step, 'Call again')))));
  const byLead = new Map<number, Task[]>();
  for (const t of rows) byLead.set(t.leadId, [...(byLead.get(t.leadId) ?? []), t]);

  for (const lead of all) {
    // CA firms are not part of this sequence (they have their own three rounds).
    if (lead.followUpStartedOn || isCaSegment(lead.segment)) continue;
    const mine = byLead.get(lead.id) ?? [];
    const calls = mine.filter((t) => t.kind === 'call' && t.doneAt && (!lead.contactSince || t.doneAt > lead.contactSince));
    const connected = calls.some((t) => t.outcome === 'connected');
    const qualifying = calls.filter((t) => isQualifyingOutcome(t.outcome)).sort((a, b) => a.doneAt!.getTime() - b.doneAt!.getTime());
    const old = mine.filter(oldCadence);
    const close = async (list: Task[]) => {
      if (!list.length) return;
      await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(inArray(tasks.id, list.map((t) => t.id)), isNull(tasks.doneAt)));
      report.cancelledSteps += list.length;
    };

    if (qualifying.length && !connected) {
      if (!lead.ownerId || !ENROLLABLE.includes(lead.status)) {
        report.needsReview.push({ id: lead.id, company: lead.company, reason: !lead.ownerId ? 'has a no answer / busy / wrong number call but no owner' : `has a no answer / busy / wrong number call but is in ${lead.status}` });
        continue;
      }
      const day1 = istDay(qualifying[0].doneAt!);
      // Old rounds fully done, in order, stay as completed rounds.
      let kept = 0;
      for (let k = 1; k <= 3; k++) {
        const round = mine.filter((t) => t.followUpRound === 0 && t.step === `Follow-up ${k}`);
        if (!round.length || !round.every(completed)) break;
        await db.update(tasks).set({ followUpRound: k }).where(inArray(tasks.id, round.map((t) => t.id)));
        kept = k;
      }
      await close(old);
      await db.insert(tasks).values(followUpPlan(day1, holidays, kept + 1).map((t) => ({ ...t, leadId: lead.id, ownerId: lead.ownerId! })));
      await db.update(leads).set({ followUpStartedOn: day1, nextFollowUpAt: null, updatedAt: now }).where(eq(leads.id, lead.id));
      await logActivity(db, lead.id, 'note', `Follow-up sequence applied from the saved call history: Day 1 ${day1}${kept ? `, Follow-up 1 to ${kept} already done` : ''}; the rest are planned`);
      report.enrolled++;
      report.keptRounds += kept;
      if (scheduled.has(lead.id)) report.oldSchedulesCleared++;
      continue;
    }

    // Not enrolled: the old cadence's open steps go, and so does its schedule and the draft it wrote.
    await close(old);
    if (scheduled.has(lead.id)) {
      await db.update(leads).set({ nextFollowUpAt: null, followUpSubject: '', followUpBody: '', updatedAt: now }).where(eq(leads.id, lead.id));
      report.oldSchedulesCleared++;
    }
  }
  return report;
}

/** Runs the reconciliation once per database, and keeps its report under settings.followUpSeqV1. */
export async function reconcileFollowUpsOnce(db: Db): Promise<void> {
  const key = 'followUpSeqV1';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  const report = await reconcileFollowUps(db);
  await db.insert(settings).values({ key, value: report }).onConflictDoNothing();
}
