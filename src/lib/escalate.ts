import { and, eq, gt, inArray, isNull, like, or } from 'drizzle-orm';
import type { Db } from './db';
import { activities, icps, leads, people, settings, tasks, type Lead, type Person } from './db/schema';
import { logActivity } from './activity';
import { makePrimary } from './people';
import { contactPriority, icpFor, tierOf, type Tier } from './tiers';
import { personSite, rankCandidates } from './pipeline/contacts';
import { FIND_NEXT_STEP, istDay, MAX_CALL_ATTEMPTS, planSequence } from './tasks';
import { cancelFollowUpSequence, softDeleteLead } from './follow-up-sequence';
import { getHolidays } from './holidays';
export { FIND_NEXT_STEP };

/** Call outcomes where nobody useful picked up. */
const UNANSWERED = ['no_answer', 'busy', 'wrong_number'];

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
  // Never someone known to be at another of the company's sites (company-wide roles aside).
  // At this site, or a P1 at another site (a P1 elsewhere before a P2 here).
  const listed = candidates.filter((p) => !p.passedAt && contactPriority(p.title, icp) < 99 && (personSite(p, city) !== 'elsewhere' || ['P1', 'P2', 'P3'].includes(tierOf(p.title, icp))));
  const person = rankCandidates(listed, icp, city)[0];
  return person ? { person, tier: tierOf(person.title, icp) } : null;
}

/** Why a lead goes to Deleted when its contact is used up and nobody else is eligible. */
export const NO_CONTACT_REASON = 'The contact was used up and no eligible P1 or P2 contact is left at the company.';

/** The best P1 or P2 on file who hasn't been tried (P3 and unlisted titles don't count), or null. */
export function eligibleContact(candidates: Person[], icp: Parameters<typeof tierOf>[1], city = ''): { person: Person; tier: Tier } | null {
  return nextContact(candidates.filter((p) => ['P1', 'P2'].includes(tierOf(p.title, icp))), icp, city);
}

/** A lead still on its first attempts at a contact: no follow-up or CA round has been planned for it. */
async function isFresh(db: Db, leadId: number): Promise<boolean> {
  const rounds = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.leadId, leadId), or(gt(tasks.followUpRound, 0), gt(tasks.caRound, 0)))).limit(1);
  return !rounds.length;
}

/** Restored from Deleted by a person: it isn't deleted again by a sweep (only by the same thing happening again). */
export async function wasRestored(db: Db, leadId: number): Promise<boolean> {
  const rows = await db.select({ id: activities.id }).from(activities).where(and(eq(activities.leadId, leadId), like(activities.text, 'Restored from Deleted%'))).limit(1);
  return rows.length > 0;
}

/** Closes what is left of the current plan and starts the full sequence again for the new person, from today. */
export async function restartSequence(db: Db, leadId: number, ownerId: number, now = new Date()): Promise<void> {
  // A new person: the follow-up sequence of the last one ends, and the new person's own can start.
  await cancelFollowUpSequence(db, leadId, 'the point of contact changed', { now, reset: true });
  await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt), eq(tasks.priority, false)));
  await db.insert(tasks).values(planSequence(istDay(now), await getHolidays(db)).map((t) => ({ ...t, leadId, ownerId })));
}

/** `cleared`: the lead has no point of contact any more (nobody else to switch to). */
export type Escalation = { switched: true; name: string; tier: Tier; deleted?: false } | { switched: false; cleared?: boolean; deleted?: boolean };

/**
 * The P2 flow. After MAX_CALL_ATTEMPTS unanswered calls to the point of contact, or a call where
 * they said they're not the right person, the lead moves to the next person at the company: the
 * best P2 (else P3) already found, with a fresh plan from today. When nobody else is on file, a
 * "Find the next person" step goes on Today; naming someone with Edit point of contact restarts the plan.
 *
 * For a lead still on its first attempts (no follow-up round yet) it changes in two ways. Nobody is switched to
 * automatically except another P1: a P2 or P3 on file is for the associate to choose (Edit point of contact), and
 * the step on Today says so. And when no P1 or P2 is left at all, there is no "find someone" step: the lead goes to
 * Deleted (a soft delete, restorable, with its history kept).
 */
export async function escalate(db: Db, leadId: number, why: 'no_answer' | 'wrong_person' | 'left' | 'abroad' | 'other_site' | 'unverified' | 'off_list', now = new Date(), detail = ''): Promise<Escalation> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return { switched: false };
  const [icpRows, found] = await Promise.all([db.select().from(icps), db.select().from(people).where(eq(people.leadId, leadId))]);
  const icp = icpFor(lead.segment, icpRows);
  const others = found.filter((p) => !p.isPrimary && p.name.trim() && p.name.toLowerCase() !== lead.contactName.toLowerCase());
  const fresh = await isFresh(db, leadId);
  const eligible = eligibleContact(others, icp, lead.city);
  let next = nextContact(others, icp, lead.city);
  if (fresh && next && next.tier !== 'P1') next = null;
  const reason =
    why === 'left'
      ? `${lead.contactName || 'The contact'} no longer works at ${lead.company}${detail ? ` (LinkedIn: ${detail})` : ''}`
      : why === 'abroad'
        ? `${lead.contactName || 'The contact'} is based outside India${detail ? ` (${detail})` : ''}, not at this site`
        : why === 'other_site'
          ? `${lead.contactName || 'The contact'} is based in ${detail || 'another city'}, not at the ${lead.city || 'lead\'s'} site`
          : why === 'off_list'
            ? `${lead.contactName || 'The contact'} isn't contacted: ${detail || "not on the ICP's contact lists"}`
          : why === 'unverified'
            ? `${lead.contactName || 'The contact'} couldn't be confirmed on LinkedIn at ${lead.company}${lead.city ? ` ${lead.city}` : ''}${detail ? ` (${detail})` : ''}; set aside until confirmed`
      : why === 'wrong_person'
        ? `${lead.contactName || 'The contact'} said they are not the right person`
        : `No answer from ${lead.contactName || 'the contact'} after ${MAX_CALL_ATTEMPTS} calls`;

  if (why === 'off_list') {
    await db.update(people).set({ passedAt: now, passedReason: 'excluded', whyNot: detail, isPrimary: false }).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
  }
  if (why === 'left' || why === 'abroad' || why === 'other_site') {
    // Someone who has left (or works abroad, or at another site) is never shown or contacted again.
    await db.delete(people).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
  }

  if (!next) {
    if (why === 'left' || why === 'abroad' || why === 'other_site' || why === 'off_list' || why === 'unverified') {
      // Someone not confirmed is set aside, not deleted: no longer the main contact, and checked on
      // LinkedIn again later (reconfirmSetAside), when they may be picked again.
      if (why === 'unverified') {
        await db.update(people).set({ passedAt: now, passedReason: 'unverified', whyNot: reason, isPrimary: false }).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
      }
      // Nobody to send the draft to: the team finds someone first.
      const waiting = lead.status === 'Awaiting Approval' || lead.status === 'Approved';
      await db
        .update(leads)
        .set({ contactVerifiedAt: null, contactName: '', contactTitle: '', contactEmail: '', contactPhone: '', contactLinkedin: '', contactTier: '', contactSince: now, ...(waiting ? { status: 'Needs Manual Contact' as const } : {}), updatedAt: now })
        .where(eq(leads.id, leadId));
    }
    const cleared = why === 'left' || why === 'abroad' || why === 'other_site' || why === 'off_list' || why === 'unverified';
    if (fresh && !eligible && lead.ownerId) {
      await logActivity(db, leadId, 'note', `${reason}. No P1 or P2 contact is left to try at ${lead.company}.`);
      await softDeleteLead(db, leadId, NO_CONTACT_REASON, now);
      return { switched: false, cleared, deleted: true };
    }
    if (!lead.ownerId) {
      await logActivity(db, leadId, 'note', `${reason}. Nobody else on the ICP's P1/P2/P3 lists found at ${lead.company} yet.`);
      return cleared ? { switched: false, cleared } : { switched: false };
    }
    await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt), eq(tasks.priority, false)));
    await db.insert(tasks).values({
      leadId,
      ownerId: lead.ownerId,
      kind: 'call',
      step: FIND_NEXT_STEP,
      title: fresh && eligible ? `Choose the next contact: ${eligible.person.name} (${eligible.tier}) is on file` : 'Find the next person to contact (P2: process owner)',
      dueDate: istDay(now),
      slot: 'day',
    });
    await logActivity(
      db,
      leadId,
      'note',
      fresh && eligible
        ? `${reason}. ${eligible.person.name} (${eligible.tier}) is on file at ${lead.company}: switch to them under Edit point of contact.`
        : `${reason}. Nobody else found at ${lead.company} yet: find a P2 contact (ask at reception, LinkedIn, ContactOut) and add them under Edit point of contact.`,
    );
    return cleared ? { switched: false, cleared } : { switched: false };
  }

  // The person moved past isn't tried again automatically.
  await db.update(people).set({ passedAt: now, passedReason: why === 'unverified' ? 'unverified' : 'tried', whyNot: reason }).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
  await makePrimary(db, next.person.id);
  const tier = next.tier === '' || next.tier === 'Avoid' || next.tier === 'Top' ? '' : next.tier;
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

/**
 * Existing leads waiting on "find someone" (an open Find the next person step, or an assigned lead with no contact
 * at all) move to Deleted when no P1 or P2 is on file for them. Leads with an eligible contact, with a named
 * contact still to confirm, with follow-up rounds, unassigned, or restored by a person are left alone.
 */
export async function retireWithoutContact(db: Db, now = new Date()): Promise<number[]> {
  const icpRows = await db.select().from(icps);
  const openFind = await db.select({ leadId: tasks.leadId }).from(tasks).where(and(eq(tasks.step, FIND_NEXT_STEP), isNull(tasks.doneAt)));
  const findIds = new Set(openFind.map((t) => t.leadId));
  const rows = (await db.select().from(leads)).filter((l) => l.ownerId != null && l.status !== 'Deleted' && (findIds.has(l.id) || (l.status === 'Needs Manual Contact' && !l.contactName)));
  const gone: number[] = [];
  for (const lead of rows) {
    if (!(await isFresh(db, lead.id)) || (await wasRestored(db, lead.id))) continue;
    const found = await db.select().from(people).where(eq(people.leadId, lead.id));
    const others = found.filter((p) => !p.isPrimary && p.name.trim() && p.name.toLowerCase() !== lead.contactName.toLowerCase());
    if (eligibleContact(others, icpFor(lead.segment, icpRows), lead.city)) continue;
    if (await softDeleteLead(db, lead.id, NO_CONTACT_REASON, now)) gone.push(lead.id);
  }
  return gone;
}

/** Runs the sweep once per database, and keeps what it did under settings.noContactDeleteV1. */
export async function retireWithoutContactOnce(db: Db): Promise<void> {
  const key = 'noContactDeleteV1';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  const gone = await retireWithoutContact(db);
  await db.insert(settings).values({ key, value: { at: new Date().toISOString(), deleted: gone } }).onConflictDoNothing();
}
