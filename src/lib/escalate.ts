import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Db } from './db';
import { icps, leads, people, tasks, type Lead, type Person } from './db/schema';
import { logActivity } from './activity';
import { makePrimary } from './people';
import { contactPriority, tierOf, type Tier } from './tiers';
import { rankCandidates } from './pipeline/contacts';
import { istDay, MAX_CALL_ATTEMPTS, planSequence } from './tasks';

/** Call outcomes where nobody useful picked up. */
const UNANSWERED = ['no_answer', 'busy', 'wrong_number'];
export const FIND_NEXT_STEP = 'Find the next person';

/** Unanswered calls to the current point of contact (since they took over). */
export async function unansweredCalls(db: Db, lead: Pick<Lead, 'id' | 'contactSince'>): Promise<number> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.leadId, lead.id), eq(tasks.kind, 'call'), inArray(tasks.outcome, UNANSWERED), lead.contactSince ? gt(tasks.doneAt, lead.contactSince) : undefined));
  return rows.length;
}

/**
 * The next person to try: the best-ranked by INVECK's contact priority (plant head, hands-on heads,
 * process owners, VPs, P3, the MD last), someone at the lead's branch first, among people on the ICP's
 * lists who haven't been tried and moved past already. HR, admin, quality and unlisted titles never.
 */
export function nextContact(candidates: Person[], icp: Parameters<typeof tierOf>[1], city = ''): { person: Person; tier: Tier } | null {
  const listed = candidates.filter((p) => !p.passedAt && contactPriority(p.title, icp) < 99);
  const person = rankCandidates(listed, icp, city)[0];
  return person ? { person, tier: tierOf(person.title, icp) } : null;
}

/** Closes what is left of the current plan and starts the full sequence again for the new person, from today. */
export async function restartSequence(db: Db, leadId: number, ownerId: number, now = new Date()): Promise<void> {
  await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt), eq(tasks.priority, false)));
  await db.insert(tasks).values(planSequence(istDay(now)).map((t) => ({ ...t, leadId, ownerId })));
}

export type Escalation = { switched: true; name: string; tier: Tier } | { switched: false };

/**
 * The P2 flow. After MAX_CALL_ATTEMPTS unanswered calls to the point of contact, or a call where
 * they said they're not the right person, the lead moves to the next person at the company: the
 * best P2 (else P3) already found, with a fresh plan from today. When nobody else is on file, a
 * "Find the next person" step goes on Today; naming someone with Edit point of contact restarts the plan.
 */
export async function escalate(db: Db, leadId: number, why: 'no_answer' | 'wrong_person' | 'left', now = new Date(), detail = ''): Promise<Escalation> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return { switched: false };
  const [icpRows, found] = await Promise.all([db.select().from(icps), db.select().from(people).where(eq(people.leadId, leadId))]);
  const icp = icpRows.find((i) => i.segment.toLowerCase() === lead.segment.toLowerCase());
  const others = found.filter((p) => !p.isPrimary && p.name.trim() && p.name.toLowerCase() !== lead.contactName.toLowerCase());
  const next = nextContact(others, icp, lead.city);
  const reason =
    why === 'left'
      ? `${lead.contactName || 'The contact'} no longer works at ${lead.company}${detail ? ` (LinkedIn: ${detail})` : ''}`
      : why === 'wrong_person'
        ? `${lead.contactName || 'The contact'} said they are not the right person`
        : `No answer from ${lead.contactName || 'the contact'} after ${MAX_CALL_ATTEMPTS} calls`;

  if (why === 'left') {
    // Someone who has left is never shown or contacted again.
    await db.delete(people).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
  }

  if (!next) {
    if (why === 'left') {
      await db.update(leads).set({ contactName: '', contactTitle: '', contactEmail: '', contactPhone: '', contactLinkedin: '', contactTier: '', contactSince: now, updatedAt: now }).where(eq(leads.id, leadId));
    }
    if (!lead.ownerId) {
      await logActivity(db, leadId, 'note', `${reason}. Nobody else on the ICP's P1/P2/P3 lists found at ${lead.company} yet.`);
      return { switched: false };
    }
    await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt), eq(tasks.priority, false)));
    await db.insert(tasks).values({
      leadId,
      ownerId: lead.ownerId,
      kind: 'call',
      step: FIND_NEXT_STEP,
      title: 'Find the next person to contact (P2: process owner)',
      dueDate: istDay(now),
      slot: 'day',
    });
    await logActivity(db, leadId, 'note', `${reason}. Nobody else found at ${lead.company} yet: find a P2 contact (ask at reception, LinkedIn, ContactOut) and add them under Edit point of contact.`);
    return { switched: false };
  }

  // The person moved past isn't tried again automatically.
  await db.update(people).set({ passedAt: now }).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
  await makePrimary(db, next.person.id);
  const tier = next.tier === '' || next.tier === 'Avoid' ? '' : next.tier;
  await db.update(leads).set({ contactTier: tier, contactSince: now }).where(eq(leads.id, leadId));
  if (lead.ownerId) await restartSequence(db, leadId, lead.ownerId, now);
  await logActivity(db, leadId, 'note', `${reason}. Switched to ${tier ? `${tier} ` : ''}${next.person.name}${next.person.title ? `, ${next.person.title}` : ''}${lead.ownerId ? ', with a fresh plan from today' : ''}.`);
  return { switched: true, name: next.person.name, tier };
}

/**
 * A new point of contact named by hand. Unanswered calls count from now; if the lead was waiting
 * for someone (a "Find the next person" step) or had nothing left planned, the full plan starts again.
 */
export async function newContactNamed(db: Db, leadId: number, now = new Date()): Promise<void> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return;
  await db.update(leads).set({ contactSince: now }).where(eq(leads.id, leadId));
  if (!lead.ownerId) return;
  const open = await db.select().from(tasks).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt), eq(tasks.priority, false)));
  if (!open.length || open.some((t) => t.step === FIND_NEXT_STEP)) await restartSequence(db, leadId, lead.ownerId, now);
}
