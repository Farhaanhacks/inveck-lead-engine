import { eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { leads } from './db/schema';
import { logActivity } from './activity';
import { softDeleteLead } from './follow-up-sequence';
import { isCaSegment } from './tasks';

/** Why a lead with nobody to contact goes to Deleted (restorable), now that Needs Manual Contact is gone. */
export const NO_CONTACT_FOUND = "No contact found: nobody on the ICP's P1/P2/P3 lists could be reached at the company";

/** A fit research couldn't confirm: "ICP fit not confirmed: …" (an old "Needs review: …" reworded). */
export function unconfirmedFit(decision: string): string {
  const why = decision.replace(/^needs review:\s*/i, '').trim();
  return `ICP fit not confirmed${why ? `: ${why}` : ''}`;
}

/**
 * Needs Review and Needs Manual Contact are gone (INVECK's decision, 20 Oct 2026). Leads still in them move on,
 * with a note on their timeline: a fit that couldn't be confirmed is Disqualified, with the reason; a lead with
 * nobody to contact goes to Deleted (restorable, back to Approved). A CA firm is worked from the firm's own
 * details, so it is Approved instead. Safe at every start: it matches nothing once done.
 */
export async function retireRemovedStatuses(db: Db): Promise<{ disqualified: number; deleted: number; approved: number }> {
  const out = { disqualified: 0, deleted: 0, approved: 0 };
  for (const l of await db.select().from(leads).where(sql`${leads.status} = 'Needs Review'`)) {
    const decision = unconfirmedFit(l.fitDecision);
    await db.update(leads).set({ status: 'Disqualified', fitDecision: decision, updatedAt: new Date() }).where(eq(leads.id, l.id));
    await logActivity(db, l.id, 'stage', `Disqualified: Needs Review was removed. ${decision}`, 'Disqualified');
    out.disqualified++;
  }
  for (const l of await db.select().from(leads).where(sql`${leads.status} = 'Needs Manual Contact'`)) {
    // Approved first, so a lead restored from Deleted comes back as Approved.
    await db.update(leads).set({ status: 'Approved', updatedAt: new Date() }).where(eq(leads.id, l.id));
    if (isCaSegment(l.segment)) {
      await logActivity(db, l.id, 'stage', "Approved: Needs Manual Contact was removed; a CA firm is worked from the firm's own details", 'Approved');
      out.approved++;
    } else if (await softDeleteLead(db, l.id, NO_CONTACT_FOUND)) out.deleted++;
  }
  return out;
}
