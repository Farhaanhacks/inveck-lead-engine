/**
 * Message templates (email and WhatsApp) per product and ICP. A template is plain text with variables in double braces:
 *   {{contact_name}}  the main contact's name as saved (a leading Mr/Mrs/Ms/Shri dropped)
 *   {{first_name}}    the contact's first name
 *   {{greeting}}      "Hi Ravi Sir," or, with no usable name, "Hi Sir/Ma’am,"  (WhatsApp)
 *   {{company_name}}  the lead's company
 *   {{bd_name}}       the BDA who owns the lead
 * Rendering never leaves a variable blank: a template that needs one the lead doesn't have is a plain problem to fix first.
 * The built-in texts below are what the app has always sent; they are the starting configuration for the Inveck product.
 */
export const TEMPLATE_VARIABLES = ['contact_name', 'first_name', 'greeting', 'company_name', 'bd_name'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export const VARIABLE_HELP: Record<TemplateVariable, string> = {
  contact_name: "The main contact's name",
  first_name: "The contact's first name",
  greeting: 'Hi <first name> Sir, or Hi Sir/Ma’am, when there is no name',
  company_name: "The lead's company",
  bd_name: 'The BDA who owns the lead',
};

const USED = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** The variables a text uses, and any that are not one of the known ones. */
export function variablesIn(text: string): { used: TemplateVariable[]; unknown: string[] } {
  const used = new Set<TemplateVariable>();
  const unknown = new Set<string>();
  for (const m of text.matchAll(USED)) {
    const v = m[1].toLowerCase();
    if ((TEMPLATE_VARIABLES as readonly string[]).includes(v)) used.add(v as TemplateVariable);
    else unknown.add(m[1]);
  }
  return { used: [...used], unknown: [...unknown] };
}

export type Vars = Partial<Record<TemplateVariable, string>>;
export type Rendered = { ok: true; text: string } | { ok: false; missing: TemplateVariable[] };

/** Fills in the variables. A variable the lead has no value for is reported, never rendered blank. */
export function renderTemplate(text: string, vars: Vars): Rendered {
  const missing = variablesIn(text).used.filter((v) => !(vars[v] ?? '').trim());
  if (missing.length) return { ok: false, missing };
  return { ok: true, text: text.replace(USED, (all, v: string) => (vars[v.toLowerCase() as TemplateVariable] ?? all).trim()) };
}

/** What a missing variable means to the person fixing the record. */
export const MISSING_TEXT: Record<TemplateVariable, string> = {
  contact_name: "the main contact's name",
  first_name: "the main contact's name",
  greeting: "the main contact's name",
  company_name: "the company's name",
  bd_name: "the company owner's name",
};

export type TemplateSeed = { icp: string; channel: 'email' | 'whatsapp'; subject: string; body: string };

const WA_FOOT_MANUFACTURING =
  'A quick question — when physical inventory verification happens across your plants or warehouses, is your team still using count sheets, Excel, and manual consolidation?\n\n' +
  'Inveck helps manufacturing teams digitize this workflow — physical verification → real-time data → variance reporting → reconciliation, reducing paperwork and manual consolidation.\n\n' +
  'I’m sharing our product profile. Would be glad to understand how your team currently handles inventory verification.';
const WA_FOOT_3PL =
  'A quick question — when verifying inventory across your warehouses or client locations, does your team still rely on count sheets, Excel, and manual consolidation?\n\n' +
  'Inveck helps 3PL and warehousing companies digitize physical inventory verification through mobile-based counting, real-time data capture, variance reporting, and reconciliation, reducing paperwork and manual effort.\n\n' +
  'I’m sharing our product profile for your reference. Would be glad to understand how your team currently handles inventory verification across warehouses.';

/** The templates the app sent before they were configurable, by ICP name. */
export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    icp: 'Manufacturing',
    channel: 'email',
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
  {
    icp: '3PL & Logistics',
    channel: 'email',
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
  {
    icp: 'Manufacturing',
    channel: 'whatsapp',
    subject: '',
    body: `{{greeting}} {{bd_name}} this side from Inveck. I tried reaching you regarding the physical stock counting process at your organization.\n\n${WA_FOOT_MANUFACTURING}`,
  },
  {
    icp: '3PL & Logistics',
    channel: 'whatsapp',
    subject: '',
    body: `{{greeting}} {{bd_name}} this side from Inveck. I tried reaching you regarding the inventory verification process at {{company_name}}.\n\n${WA_FOOT_3PL}`,
  },
  {
    icp: 'CA Firms',
    channel: 'whatsapp',
    subject: '',
    body:
      'Hi Sir/Ma’am, quick question\n\n' +
      'During your stock audit / physical inventory verification assignments, does your team still have to manage count sheets, consolidate Excel files, follow up on variances and prepare the final data for review?\n\n' +
      'That’s exactly the gap INVECK is solving for CA & Audit firms digitising physical verification from counting to reporting, while giving your team better visibility across the assignment.\n\n' +
      'We’re already working with businesses across industries and CA & Advisory firms.\n\n' +
      'Sharing a short overview if you handle stock audits or physical verification for your clients, this could be very relevant for your next assignment. 👇',
  },
];

/** Sample values for the preview on the configuration page. */
export const SAMPLE_VARS: Vars = { contact_name: 'Ravi Kumar', first_name: 'Ravi', greeting: 'Hi Ravi Sir,', company_name: 'Hosur Gears', bd_name: 'Puja' };

/** The values for a lead: the contact's name without a leading honorific, and the WhatsApp greeting that never says "Sir Sir". */
export function varsFor(lead: { contactName: string; company: string }, ownerName: string | null | undefined, contactFirstName: (n: string) => string, nameForGreeting: (n: string) => string): Vars {
  const first = contactFirstName(lead.contactName);
  return {
    contact_name: nameForGreeting(lead.contactName),
    first_name: first,
    greeting: first ? `Hi ${first} Sir,` : 'Hi Sir/Ma’am,',
    company_name: lead.company.trim(),
    bd_name: String(ownerName ?? '').trim(),
  };
}
