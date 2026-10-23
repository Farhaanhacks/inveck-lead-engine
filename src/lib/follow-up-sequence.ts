import { and, asc, eq, gt, inArray, isNull, lte, notInArray } from 'drizzle-orm';
import type { Db } from './db';
import { leads, tasks, type Lead, type LeadStatus, type Task } from './db/schema';
import { logActivity } from './activity';
import { formatDate } from './dates';
import { getHolidays } from './holidays';
import { addWorkingDays, firstWorkingDay, isCaSegment, istDay, type Holidays } from './tasks';
import { defaultProduct, followupRuleFor, listIcps } from './config';
import { DEFAULT_FOLLOWUP, scheduleFor, type FollowupRule } from './config-rules';
import { normSegment } from './icp-match';

/**
 * The follow-up sequence: the one source of truth for who is in it, where they are in it and when the
 * next round is due.
 *
 * - It starts only when a call is saved as no answer, busy or wrong number (QUALIFYING_OUTCOMES).
 * - The day of that call is Day 1. Follow-up 1 to 5 fall 2, 4, 6, 8 and 10 working days later (weekends
 *   and the holidays set in Settings never count), so the sequence works every other working day.
 * - Each round is a call, a WhatsApp and an email (no LinkedIn request). They are tasks with
 *   `followUpRound` 1-5, planned all at once, so Today, the funnel and the counts read the same rows.
 * - A connected call stops it for good. Completing all five rounds (every task done or skipped, not
 *   ticked off in bulk) moves the lead to Deleted, as junk, with its history kept.
 */
// These are the defaults (Inveck's starting configuration): how many rounds, how far apart and which outcomes start them
// are Configuration → Follow-up rules, per product and ICP (see config.ts); these values are what applies until it says otherwise.
export const FOLLOW_UP_ROUNDS = DEFAULT_FOLLOWUP.rounds;
export const FOLLOW_UP_OFFSETS = [2, 4, 6, 8, 10] as const;
export const QUALIFYING_OUTCOMES = ['no_answer', 'busy', 'wrong_number'] as const;
export const isQualifyingOutcome = (outcome: string, outcomes: readonly string[] = QUALIFYING_OUTCOMES) => outcomes.includes(outcome);
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** Why a lead whose follow-ups all went unanswered is moved to Deleted ("five" for the default five rounds). */
export const junkReason = (rounds: number) => `Junk/Waste: completed ${WORDS[rounds] ?? rounds} unanswered follow-up rounds.`;
export const JUNK_REASON = junkReason(FOLLOW_UP_ROUNDS);
export const isJunkReason = (reason: string | null | undefined) => /^Junk\/Waste: completed \w+ unanswered follow-up rounds\.$/.test(reason ?? '');

/** The follow-up rule that applies to a lead: its ICP's, else its product's, else the defaults. */
export async function ruleForLead(db: Db, lead: Pick<Lead, 'productId' | 'icpId' | 'segment'>): Promise<FollowupRule> {
  const productId = lead.productId ?? (await defaultProduct(db))?.id;
  if (!productId) return DEFAULT_FOLLOWUP;
  let icpId = lead.icpId ?? 0;
  if (!icpId) icpId = (await listIcps(db, productId)).find((i) => normSegment(i.segment) === normSegment(lead.segment))?.id ?? 0;
  return (await followupRuleFor(db, productId, icpId)).rule;
}
export async function ruleForLeadId(db: Db, leadId: number): Promise<FollowupRule> {
  const [lead] = await db.select({ productId: leads.productId, icpId: leads.icpId, segment: leads.segment }).from(leads).where(eq(leads.id, leadId));
  return lead ? ruleForLead(db, lead) : DEFAULT_FOLLOWUP;
}

/** Where a lead can be and still be enrolled: being worked, not in a conversation or ruled out. */
const ENROLLABLE: LeadStatus[] = ['Approved', 'Contacted'];
const ROUND_KINDS = ['call', 'whatsapp', 'email'] as const;
const KIND_LABEL = { call: 'call', whatsapp: 'WhatsApp', email: 'email' } as const;

/** The five due dates for a sequence whose Day 1 is `day1`. */
export function followUpDates(day1: string, holidays?: Holidays, rule: Pick<FollowupRule, 'rounds' | 'spacingDays'> = DEFAULT_FOLLOWUP): string[] {
  return scheduleFor(rule, day1, holidays);
}

/** The tasks of the rounds from `fromRound` on. */
export function followUpPlan(day1: string, holidays?: Holidays, fromRound = 1, rule: Pick<FollowupRule, 'rounds' | 'spacingDays'> = DEFAULT_FOLLOWUP) {
  const dates = followUpDates(day1, holidays, rule);
  return dates.flatMap((dueDate, i) =>
    i + 1 < fromRound
      ? []
      : ROUND_KINDS.map((kind) => ({ kind, step: `Follow-up ${i + 1}`, title: `Follow-up ${i + 1}: ${KIND_LABEL[kind]}`, dueDate, slot: 'day' as const, followUpRound: i + 1 })),
  );
}

/** A call to the current contact has connected: that never starts, and always ends, the sequence. */
export async function hasConnectedCall(db: Db, lead: Pick<Lead, 'id' | 'contactSince'>): Promise<boolean> {
  const rows = await db
    .select({ doneAt: tasks.doneAt })
    .from(tasks)
    .where(and(eq(tasks.leadId, lead.id), eq(tasks.kind, 'call'), eq(tasks.outcome, 'connected')));
  // A call to an earlier contact (before the lead switched to this person) doesn't count.
  return rows.some((r) => r.doneAt && (!lead.contactSince || r.doneAt > lead.contactSince));
}

/**
 * Starts the sequence for a lead whose call has just been saved as no answer, busy or wrong number.
 * Returns the due dates, or null when nothing started: already in it (or finished it, or was stopped
 * by a connected call), no owner, a lead past outreach, or one that has had a connected call.
 */
export async function startFollowUpSequence(db: Db, leadId: number, now = new Date()): Promise<string[] | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  // CA firms have their own three rounds after the LinkedIn request: never this sequence.
  if (!lead?.ownerId || lead.followUpStartedOn || isCaSegment(lead.segment)) return null;
  if (!ENROLLABLE.includes(lead.status) || (await hasConnectedCall(db, lead))) return null;
  const day1 = istDay(now);
  const holidays = await getHolidays(db);
  const rule = await ruleForLead(db, lead);
  await db.insert(tasks).values(followUpPlan(day1, holidays, 1, rule).map((t) => ({ ...t, leadId, ownerId: lead.ownerId! })));
  await db.update(leads).set({ followUpStartedOn: day1, updatedAt: now }).where(eq(leads.id, leadId));
  const dates = followUpDates(day1, holidays, rule);
  await logActivity(db, leadId, 'note', `Follow-up sequence started: Follow-up 1 to ${rule.rounds} on ${dates.join(', ')}`);
  return dates;
}

/**
 * Ends the sequence's open work: every open round task is ticked off ("closed"), and the follow-up
 * draft is dropped. The lead drops out of the active follow-up funnel with them. `reset` also clears
 * the Day 1 mark (a new contact starts afresh); without it the lead can't be enrolled again.
 */
export async function cancelFollowUpSequence(db: Db, leadId: number, why: string, opts: { now?: Date; reset?: boolean } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const closed = await db
    .update(tasks)
    .set({ doneAt: now, outcome: 'closed' })
    .where(and(eq(tasks.leadId, leadId), gt(tasks.followUpRound, 0), isNull(tasks.doneAt)))
    .returning({ id: tasks.id });
  const [lead] = await db.select({ started: leads.followUpStartedOn }).from(leads).where(eq(leads.id, leadId));
  if (!lead?.started) return 0;
  await db
    .update(leads)
    .set({ followUpSubject: '', followUpBody: '', nextFollowUpAt: null, ...(opts.reset ? { followUpStartedOn: '' } : {}), updatedAt: now })
    .where(eq(leads.id, leadId));
  if (closed.length) await logActivity(db, leadId, 'note', `Follow-up sequence stopped (${why}); ${closed.length} open follow-up step${closed.length === 1 ? '' : 's'} cancelled`);
  return closed.length;
}

/** All the rounds are planned and every step in them was done or skipped by a person. */
export async function sequenceComplete(db: Db, leadId: number, totalRounds = FOLLOW_UP_ROUNDS): Promise<boolean> {
  const rows = await db.select({ round: tasks.followUpRound, doneAt: tasks.doneAt, outcome: tasks.outcome }).from(tasks).where(and(eq(tasks.leadId, leadId), gt(tasks.followUpRound, 0)));
  const rounds = new Set(rows.map((r) => r.round));
  return Array.from({ length: totalRounds }, (_, i) => i + 1).every((n) => rounds.has(n)) && rows.every((r) => r.doneAt && r.outcome !== 'closed');
}

/** Moves the lead to Deleted (a soft delete: nothing is removed) and takes it out of the open work. */
export async function softDeleteLead(db: Db, leadId: number, reason: string, now = new Date()): Promise<boolean> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.status === 'Deleted') return false;
  await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt)));
  await db
    .update(leads)
    .set({ status: 'Deleted', statusBeforeDelete: lead.status, deletedReason: reason, deletedAt: now, followUpSubject: '', followUpBody: '', nextFollowUpAt: null, updatedAt: now })
    .where(eq(leads.id, leadId));
  await logActivity(db, leadId, 'stage', `Moved to Deleted. ${reason}`, 'Deleted');
  return true;
}

/** Puts a Deleted lead back at the stage it was in. Its history is untouched. */
export async function restoreLead(db: Db, leadId: number, by: string, now = new Date()): Promise<boolean> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.status !== 'Deleted') return false;
  const back = (lead.statusBeforeDelete || 'Contacted') as LeadStatus;
  await db.update(leads).set({ status: back, statusBeforeDelete: '', deletedReason: '', deletedAt: null, updatedAt: now }).where(eq(leads.id, leadId));
  await logActivity(db, leadId, 'stage', `Restored from Deleted by ${by}; back to ${back}`, back);
  return true;
}

/** After a round's step is logged: the lead goes to Deleted once all five rounds are complete. */
export async function junkIfComplete(db: Db, leadId: number, now = new Date()): Promise<boolean> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.status === 'Deleted') return false;
  const rule = await ruleForLead(db, lead);
  if (!(await sequenceComplete(db, leadId, rule.rounds)) || (await hasConnectedCall(db, lead))) return false;
  return softDeleteLead(db, leadId, junkReason(rule.rounds), now);
}

/** The lowest follow-up round whose email is still open: the one the lead's draft is for. */
export async function nextEmailRound(db: Db, leadId: number): Promise<Task | null> {
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.leadId, leadId), eq(tasks.kind, 'email'), gt(tasks.followUpRound, 0), isNull(tasks.doneAt)))
    .orderBy(asc(tasks.followUpRound))
    .limit(1);
  return t ?? null;
}

/** "Follow-up 2 on 24 Oct 2026", or due / overdue when its day has come. */
export function roundBadge(r: { round: number; dueDate: string }, today = istDay()): { due: boolean; label: string } {
  const due = r.dueDate <= today;
  return { due, label: `Follow-up ${r.round} ${r.dueDate < today ? 'overdue' : due ? 'due today' : `on ${formatDate(new Date(`${r.dueDate}T12:00:00+05:30`))}`}` };
}

/** Each lead's next open round (soonest first), for lists that show "Follow-up N due …". */
export async function nextRounds(db: Db, leadIds: number[]): Promise<Map<number, { round: number; dueDate: string }>> {
  const out = new Map<number, { round: number; dueDate: string }>();
  if (!leadIds.length) return out;
  const rows = await db
    .select({ leadId: tasks.leadId, round: tasks.followUpRound, dueDate: tasks.dueDate })
    .from(tasks)
    .where(and(inArray(tasks.leadId, leadIds), gt(tasks.followUpRound, 0), isNull(tasks.doneAt)))
    .orderBy(asc(tasks.followUpRound));
  for (const r of rows) if (!out.has(r.leadId)) out.set(r.leadId, { round: r.round, dueDate: r.dueDate });
  return out;
}

/** Leads with a follow-up round due today or earlier, for the dashboard. */
export async function followUpsDue(db: Db, today = istDay(), limit = 8): Promise<{ lead: Lead; round: number; dueDate: string }[]> {
  const rows = await db
    .select({ lead: leads, round: tasks.followUpRound, dueDate: tasks.dueDate })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(gt(tasks.followUpRound, 0), isNull(tasks.doneAt), lte(tasks.dueDate, today), notInArray(leads.status, ['Deleted', 'Replied', 'Meeting Booked', 'Won', 'Lost', 'Disqualified', 'Rejected', 'Existing Client'])))
    .orderBy(asc(tasks.dueDate), asc(tasks.followUpRound));
  const seen = new Set<number>();
  const out: { lead: Lead; round: number; dueDate: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.lead.id)) continue;
    seen.add(r.lead.id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Recalculates the dates of every open round after the holidays changed: each lead's Day 1 stays, the
 * holidays now being skipped like a weekend. Done steps never move.
 */
export async function rescheduleFollowUps(db: Db): Promise<number> {
  const holidays = await getHolidays(db);
  const open = await db
    .select({ id: tasks.id, leadId: tasks.leadId, round: tasks.followUpRound, dueDate: tasks.dueDate, started: leads.followUpStartedOn, productId: leads.productId, icpId: leads.icpId, segment: leads.segment })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(gt(tasks.followUpRound, 0), isNull(tasks.doneAt)));
  let moved = 0;
  const rules = new Map<number, FollowupRule>();
  for (const t of open) {
    if (!t.started) continue;
    if (!rules.has(t.leadId)) rules.set(t.leadId, await ruleForLead(db, t));
    const due = followUpDates(t.started, holidays, rules.get(t.leadId))[t.round - 1];
    if (due && due !== t.dueDate) {
      await db.update(tasks).set({ dueDate: due }).where(eq(tasks.id, t.id));
      moved++;
    }
  }
  return moved + (await rescheduleCaRounds(db, holidays));
}

/**
 * A CA firm's open rounds that now fall on a holiday (or a weekend) move to the next working day, and
 * each round stays after the one before it. Done steps never move.
 */
async function rescheduleCaRounds(db: Db, holidays: Holidays): Promise<number> {
  const open = await db
    .select({ id: tasks.id, leadId: tasks.leadId, round: tasks.caRound, dueDate: tasks.dueDate })
    .from(tasks)
    .where(and(gt(tasks.caRound, 0), isNull(tasks.doneAt)))
    .orderBy(asc(tasks.leadId), asc(tasks.caRound), asc(tasks.id));
  let moved = 0;
  // One firm at a time, one round at a time (a round's call, WhatsApp and email share a day).
  const groups = new Map<string, typeof open>();
  for (const t of open) groups.set(`${t.leadId}:${t.round}`, [...(groups.get(`${t.leadId}:${t.round}`) ?? []), t]);
  const prev = new Map<number, string>();
  for (const list of groups.values()) {
    const { leadId } = list[0];
    let due = firstWorkingDay(list[0].dueDate, holidays);
    const before = prev.get(leadId);
    if (before && due <= before) due = addWorkingDays(before, 1, holidays);
    const ids = list.filter((t) => t.dueDate !== due).map((t) => t.id);
    if (ids.length) {
      await db.update(tasks).set({ dueDate: due }).where(inArray(tasks.id, ids));
      moved += ids.length;
    }
    prev.set(leadId, due);
  }
  return moved;
}
