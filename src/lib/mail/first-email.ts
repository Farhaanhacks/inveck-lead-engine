import { contactFirstName, templateFor } from '../whatsapp-outreach';

/**
 * The first email to a Manufacturing or 3PL company: fixed wording, never rewritten. Only {{contact_name}}
 * (the saved main contact) and {{bd_name}} (the company's owner in the CRM) are replaced. CA firms and every other
 * segment keep the drafted email: this returns null for them.
 */
const TEMPLATES = {
  '3pl': {
    subject: 'Inveck - Digitalizing Physical Inventory Verification for 3PL Operations',
    body: `Dear Mr. {{contact_name}},

Thank you for connecting with us on LinkedIn.

I’m {{bd_name}}, leading Business Development. Inveck is a mobile application designed to digitize physical inventory verification across 3PL warehouses and client locations.

It enables:

* Cycle Counts & Wall-to-Wall Verification
* Real-Time Variance & Reconciliation
* Client/Account & Warehouse-wise Reporting
* Completion Tracking & Audit Trails

This helps reduce manual counting, Excel consolidation, and reconciliation efforts while providing real-time visibility across locations.

Please find the Inveck 3PL Profile attached for your reference. I’d be happy to arrange a 15–20-minute demo to walk you through the application and its 3PL use cases. Please share a convenient time, and I’ll schedule the meeting accordingly.

Looking forward to connecting.`,
  },
  manufacturing: {
    subject: 'Inventory verification and reconciliation application',
    body: `Hello Mr. {{contact_name}},

I hope you're doing well.

I am {{bd_name}}, leading Business Development at Inveck. We are pleased to introduce a mobile application designed to digitize the inventory and asset verification process, delivering an ROI of 30–40%.

We understand that physical inventory verification in the manufacturing industry is a critical control/process, involving multiple departments from Finance to Supply Chain Management.

With Inveck, you can:

* Digitize the entire stock count process
* Reduce human error and time consumption
* Achieve an ROI of 30–40% by automating key verification steps

If inventory verification is part of your regular operations, I would be glad to connect and arrange a brief walkthrough with our product experts. We’d like to understand your current process and explore how Inveck can support your team.

Please find our product profile attached for your reference. Kindly let me know a convenient date and time for a quick call.

Looking forward to hearing from you.`,
  },
} as const;

export type FirstEmail = { template: 'manufacturing' | '3pl'; subject: string; body: string; problem: '' } | { template: 'manufacturing' | '3pl'; subject: ''; body: ''; problem: string };

/** The saved name as the template wants it: the template says "Mr.", so a saved Mr/Mrs/Ms/Shri in front is dropped. */
export function nameForGreeting(full: string | null | undefined): string {
  const name = String(full ?? '').trim().replace(/^(mr|mrs|ms|miss|shri|smt)\.?\s+/i, '').trim();
  return contactFirstName(name) ? name : '';
}

/** The filled-in first email for the lead's segment, a problem to fix first, or null when the segment has no template. */
export function firstEmailFor(lead: { segment: string; contactName: string }, ownerName: string | null | undefined): FirstEmail | null {
  const t = templateFor(lead.segment);
  if (t !== 'manufacturing' && t !== '3pl') return null;
  const contact = nameForGreeting(lead.contactName);
  const bd = String(ownerName ?? '').trim();
  const missing = [!contact && "the main contact's name", !bd && "the company owner's name"].filter(Boolean);
  if (missing.length) return { template: t, subject: '', body: '', problem: `This email can't be sent yet: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing in the CRM. Correct the record first.` };
  const fill = (s: string) => s.replaceAll('{{contact_name}}', contact).replaceAll('{{bd_name}}', bd);
  return { template: t, subject: fill(TEMPLATES[t].subject), body: fill(TEMPLATES[t].body), problem: '' };
}
