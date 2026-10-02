import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { icps, leads } from '../db/schema';
import { logActivity } from '../activity';
import type { Services } from './services';
import type { Research } from './research';
import type { Contact } from './contacts';
import { writeOutreach } from './draft';
import { icpFor } from '../tiers';

/** Rewrites the email and LinkedIn note for the lead's current point of contact (after a switch to P2, or a new person named by hand). */
export async function redraftForContact(db: Db, svc: Services, leadId: number): Promise<boolean> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead?.contactName) return false;
  const icp = icpFor(lead.segment, await db.select().from(icps));
  if (!icp) return false;
  // The stored research summary stands in for the full research; the draft only needs its text.
  const research = { text: [lead.researchSummary, lead.fitReason && `Why they fit: ${lead.fitReason}`].filter(Boolean).join('\n') } as Research;
  const contact = { name: lead.contactName, title: lead.contactTitle } as Contact;
  const out = await writeOutreach(svc, { company: lead.company, city: lead.city, segment: icp.segment }, research, icp, contact, lead.signals);
  if (!out.draft) {
    await logActivity(db, leadId, 'error', `Couldn't rewrite the email for ${lead.contactName}: ${out.error}. Edit the draft by hand.`);
    return false;
  }
  await db.update(leads).set({ emailSubject: out.draft.subject, emailBody: out.draft.body, linkedinMessage: out.draft.linkedin, updatedAt: new Date() }).where(eq(leads.id, leadId));
  await logActivity(db, leadId, 'note', `Email draft rewritten for ${lead.contactName}`);
  return true;
}
