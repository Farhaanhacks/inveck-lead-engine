import { and, eq, inArray, ne } from 'drizzle-orm';
import { INBOUND_SOURCE } from './inbound-source';
import type { Db } from './db';
import { leads, tasks, type Lead, type LeadStatus, type Task } from './db/schema';
import { CA_FALLBACK_STEP, CA_ROUNDS, caRoundsOf, CA_WAITING_STEP, FIND_NEXT_STEP, isCallAttempt, isCaSegment, istDay, notYet } from './tasks';

/**
 * The follow-up funnel: every lead in outreach, by where its follow-up stands. Built from the same
 * steps Today works from, so the two always agree.
 * - today: a step is due today or overdue (it's on Today);
 * - upcoming: the next step is due on a later day;
 * - finished: every planned step is done, nobody has replied and no follow-up sequence is running;
 * - conversation: they replied or a meeting is booked.
 */
export const FUNNEL_STAGES = ['today', 'upcoming', 'finished', 'conversation'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_LABEL: Record<FunnelStage, string> = {
  today: 'Due today',
  upcoming: 'Coming up',
  finished: 'No reply yet',
  conversation: 'In conversation',
};

export const FUNNEL_HELP: Record<FunnelStage, string> = {
  today: 'A step is due today or overdue. Work it on Today.',
  upcoming: 'The next step is planned for a later day. It appears on Today that morning.',
  finished: 'Every planned step is done and nobody has replied. Follow-ups start when a call is saved as no answer, busy or wrong number; or mark it lost.',
  conversation: 'They replied or a meeting is booked. Move it on as the conversation goes.',
};

/** Leads in outreach: being worked, or talking to us. */
const IN_OUTREACH: LeadStatus[] = ['Approved', 'Contacted', 'Replied', 'Meeting Booked'];
const TALKING: LeadStatus[] = ['Replied', 'Meeting Booked'];

export type FunnelCard = {
  lead: Lead;
  stage: FunnelStage;
  /** The next open step (the one due soonest), if any. */
  next: Task | null;
  /** The last thing logged (not skips or ticked-off rounds). */
  last: Task | null;
  /** Steps logged so far, and how many were real attempts (a call dialled, a message sent). */
  logged: number;
  attempts: number;
  /** Which follow-up round it is on, in plain words. */
  round: string;
  /** The CA firm's open "Request accepted?" step, for the button. */
  waitingTask: Task | null;
};

const ROUNDS = ['Day 1', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3', 'Follow-up 4', 'Follow-up 5'];

function roundOf(t: Task | null): string {
  if (!t) return '';
  if (t.priority) return 'Promised callback';
  if (t.step === CA_WAITING_STEP) return 'Waiting for LinkedIn';
  if (t.step === CA_FALLBACK_STEP) return `Follow-up round ${t.caRound || 1} of ${caRoundsOf(t)}`;
  if (t.step === 'Day 1') return 'First contact';
  return t.step || t.title;
}

export async function loadFunnel(db: Db, ownerId: number | null, today = istDay(), now = new Date()): Promise<FunnelCard[]> {
  const rows = await db
    .select()
    .from(leads)
    .where(and(inArray(leads.status, IN_OUTREACH), ne(leads.source, INBOUND_SOURCE), ownerId === null ? undefined : eq(leads.ownerId, ownerId)));
  if (!rows.length) return [];
  const all = await db.select().from(tasks).where(inArray(tasks.leadId, rows.map((l) => l.id)));
  const byLead = new Map<number, Task[]>();
  for (const t of all) byLead.set(t.leadId, [...(byLead.get(t.leadId) ?? []), t]);
  const cards: FunnelCard[] = [];
  for (const lead of rows) {
    const list = (byLead.get(lead.id) ?? []).filter((t) => t.step !== FIND_NEXT_STEP);
    // Not started yet (no plan): not in follow-up.
    if (!list.length) continue;
    const open = list.filter((t) => !t.doneAt).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || Number(b.priority) - Number(a.priority));
    const waitingTask = open.find((t) => t.step === CA_WAITING_STEP) ?? null;
    const steps = open.filter((t) => t.step !== CA_WAITING_STEP);
    const done = list.filter((t) => t.doneAt && t.outcome !== 'closed').sort((a, b) => b.doneAt!.getTime() - a.doneAt!.getTime());
    const real = done.filter((t) => t.outcome !== 'skipped' && t.outcome !== 'no_contact');
    const next = steps[0] ?? null;
    // A CA firm whose LinkedIn request is out is not in follow-up yet: that starts with its first call, WhatsApp and
    // email round. Until that round is due it only waits (Today carries the "Request accepted" option).
    if (waitingTask && !TALKING.includes(lead.status) && !(next && next.dueDate <= today)) continue;
    let stage: FunnelStage;
    if (TALKING.includes(lead.status)) stage = 'conversation';
    // On Today now (a 5 pm call-back only from 5 pm, like Today shows it).
    else if (next && next.dueDate <= today && !notYet(next, today, now)) stage = 'today';
    else if (next) stage = 'upcoming';
    else if (done.length) stage = 'finished';
    else continue;
    const reached = ROUNDS.filter((r) => done.some((t) => t.step === r));
    cards.push({
      lead,
      stage,
      next,
      last: real[0] ?? done[0] ?? null,
      logged: done.length,
      attempts: real.filter((t) => t.kind !== 'call' || isCallAttempt(t.outcome)).length,
      round: next ? roundOf(next) : reached.length ? (isCaSegment(lead.segment) ? `${new Set(done.filter((t) => t.caRound > 0).map((t) => t.caRound)).size} of ${CA_ROUNDS} follow-up rounds done` : `${reached.length} of ${ROUNDS.length} rounds done`) : roundOf(done[0] ?? null),
      waitingTask,
    });
  }
  // Within a stage: the most urgent first (overdue, then soonest), else the longest untouched.
  const at = (c: FunnelCard) => c.next?.dueDate ?? (c.last?.doneAt ? c.last.doneAt.toISOString().slice(0, 10) : '9999');
  return cards.sort((a, b) => at(a).localeCompare(at(b)) || a.lead.company.localeCompare(b.lead.company));
}
