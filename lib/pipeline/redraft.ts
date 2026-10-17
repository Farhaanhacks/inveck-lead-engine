import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db';
import { icps, leads } from '../db/schema';
import { logActivity } from '../activity';
import type { Services } from './services';
import type { Research } from './research';
import type { Contact } from './contacts';
import { writeLinkedinMessage, writeOutreach } from './draft';
import { icpFor } from '../tiers';

/** Rewrites the email and LinkedIn note for the lead's current point of contact (after a switch to P2, or a new person named by hand). */
export async function redraftForContact(db: Db, svc: Services, leadId: number): Promise<boolean> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return false;
  const icp = icpFor(lead.segment, await db.select().from(icps));
  if (!icp) return false;
  // The stored research summary stands in for the full research; the draft only needs its text.
  const research = { text: [lead.researchSummary, lead.fitReason && `Why they fit: ${lead.fitReason}`].filter(Boolean).join('\n') } as Research;
  const contact = { name: lead.contactName, title: lead.contactTitle } as Contact;
  const out = await writeOutreach(svc, { company: lead.company, city: lead.city, segment: icp.segment }, research, icp, contact, lead.signals);
  if (!out.draft) {
    await logActivity(db, leadId, 'error', `Couldn't write the email${lead.contactName ? ` for ${lead.contactName}` : ''}: ${out.error}. Edit the draft by hand.`);
    return false;
  }
  await db.update(leads).set({ emailSubject: out.draft.subject, emailBody: out.draft.body, linkedinMessage: out.draft.linkedin, lastError: '', updatedAt: new Date() }).where(eq(leads.id, leadId));
  await logActivity(db, leadId, 'note', lead.contactName ? `Email draft rewritten for ${lead.contactName}` : 'Email and LinkedIn drafts written (no contact found yet)');
  return true;
}

/** Leads whose outreach hasn't started, qualified, missing the email draft or the LinkedIn message. */
const NOT_STARTED = ['Awaiting Approval', 'Approved', 'Needs Manual Contact', 'Low Score'] as const;

/**
 * Writes the drafts qualified leads are missing: the email and LinkedIn message when there is no
 * email yet (also for leads with no contact found), or just the LinkedIn message next to an email
 * that exists (which the team may have edited). Returns how many leads were filled in.
 */
export async function fillMissingDrafts(db: Db, svc: Services, opts: { leadId?: number; limit?: number } = {}): Promise<number> {
  const rows = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.qualified, true),
        inArray(leads.status, [...NOT_STARTED]),
        or(eq(leads.emailBody, ''), eq(leads.linkedinMessage, '')),
        opts.leadId ? eq(leads.id, opts.leadId) : undefined,
      ),
    )
    .limit(opts.limit ?? 10);
  const all = await db.select().from(icps);
  let filled = 0;
  for (const lead of rows) {
    if (!lead.emailBody) {
      if (await redraftForContact(db, svc, lead.id)) filled++;
      continue;
    }
    const icp = icpFor(lead.segment, all);
    if (!icp) continue;
    const research = { text: [lead.researchSummary, lead.fitReason && `Why they fit: ${lead.fitReason}`].filter(Boolean).join('\n') } as Research;
    const text = await writeLinkedinMessage(svc, { company: lead.company, city: lead.city, segment: icp.segment }, research, icp, { name: lead.contactName, title: lead.contactTitle }, { subject: lead.emailSubject, body: lead.emailBody });
    if (!text) continue;
    await db.update(leads).set({ linkedinMessage: text, lastError: '', updatedAt: new Date() }).where(eq(leads.id, lead.id));
    filled++;
  }
  return filled;
}
