import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import { icps, leads, people } from './db/schema';
import { canBeMain } from './pipeline/contacts';
import { icpFor } from './tiers';
import { isCaSegment } from './tasks';

/** Before outreach, waiting on a contact or ready: the statuses a contact change can move between. */
const WAITING_FOR_CONTACT = 'Needs Manual Contact' as const;
const READY = ['Approved'] as const;

/**
 * Puts a lead's status in step with its point of contact, after any change to the contact (an edit,
 * a check on LinkedIn, a switch to someone else):
 * - waiting for a contact, and now someone reachable is confirmed (by the team, on LinkedIn at this
 *   site, or as a person on file found at this site): Approved;
 * - Approved, but nobody is the contact any more: waiting for a contact again.
 * Someone who works at the company but isn't confirmed at this site leaves the lead waiting: that
 * distinction stays. Returns the new status when it changed.
 */
export async function reconcileContactStatus(db: Db, leadId: number): Promise<string | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return null;
  const name = lead.contactName.trim();
  if (!name) {
    if (!(READY as readonly string[]).includes(lead.status)) return null;
    // A CA firm from the database is reached on the firm's own phone or email: it stays Approved with no person named.
    if (isCaSegment(lead.segment) && (lead.contactPhone || lead.contactEmail)) return null;
    await db.update(leads).set({ status: WAITING_FOR_CONTACT, updatedAt: new Date() }).where(eq(leads.id, leadId));
    return WAITING_FOR_CONTACT;
  }
  if (lead.status !== WAITING_FOR_CONTACT) return null;
  const reachable = !!(lead.contactLinkedin || lead.contactEmail || lead.contactPhone);
  if (!reachable) return null;
  let confirmed = !!lead.contactVerifiedAt;
  if (!confirmed) {
    const [primary] = await db.select().from(people).where(and(eq(people.leadId, leadId), eq(people.isPrimary, true)));
    const icp = icpFor(lead.segment, await db.select().from(icps));
    confirmed =
      !!primary &&
      !primary.passedAt &&
      primary.name.toLowerCase() === name.toLowerCase() &&
      (primary.source === 'Sales team' || primary.source === 'Added by the team' || (!!primary.checkedAt && canBeMain(primary, lead.city, icp)));
  }
  if (!confirmed) return null;
  await db.update(leads).set({ status: 'Approved', updatedAt: new Date() }).where(eq(leads.id, leadId));
  return 'Approved';
}
