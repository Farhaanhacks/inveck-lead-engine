import { normSegment } from './icp-match';
import { splitPhones } from './phones';
import { isCaSegment } from './tasks';
import { DEFAULT_TEMPLATES, MISSING_TEXT, renderTemplate, varsFor } from './config-templates';
import { templateKey, type TemplateSet } from './config';

/**
 * The first WhatsApp a BDA sends a company, from their own WhatsApp (a wa.me click-to-chat link with the
 * message filled in). The three texts are fixed wording, never rewritten: only [Name], [BD Name] and
 * [Company Name] are replaced.
 */

export type WhatsAppTemplate = 'manufacturing' | '3pl' | 'ca';

/** Which step of its ICP's sequence a WhatsApp task is: the follow-up round it carries (the general one, or a CA firm's), else the first contact. */
export const whatsappStepOf = (task: { followUpRound: number; caRound: number }) => (task.followUpRound > 0 ? task.followUpRound : task.caRound > 0 ? task.caRound : 0);

/** The template for a segment, or null when it is none of the three (no guessing). */
export function templateFor(segment: string): WhatsAppTemplate | null {
  const s = normSegment(segment);
  if (/\b3pl\b|logistics|warehous/.test(s)) return '3pl';
  if (isCaSegment(segment)) return 'ca';
  if (s === 'manufacturing' || s.startsWith('manufacturing ')) return 'manufacturing';
  return null;
}

const NAME_PREFIX = /^(mr|mrs|ms|miss|dr|prof|ca|cs|shri|smt|sri)\.?\s+/i;
const NOT_A_NAME = /^(sir|madam|ma'?am|sirs?\/madam)$/i;

/** The first name of the main contact, or '' when there isn't a usable one. */
export function contactFirstName(full: string | null | undefined): string {
  let name = String(full ?? '').trim();
  while (NAME_PREFIX.test(name)) name = name.replace(NAME_PREFIX, '');
  const first = (name.split(/\s+/)[0] ?? '').replace(/[^\p{L}.'-]/gu, '').replace(/^[.'-]+|[.'-]+$/g, '');
  return !first || NOT_A_NAME.test(first) || !/\p{L}/u.test(first) ? '' : first;
}

/**
 * The number as wa.me wants it (country code first, digits only), or '' when it can't be a WhatsApp number.
 * Indian mobiles: 10 digits, 0 + 10 digits, or 91 + 10 digits (never 91 twice); another country only when written
 * with + or 00. The first number is used when several are saved.
 */
export function whatsAppDigits(phone: string | null | undefined): string {
  const raw = splitPhones(phone)[0] ?? '';
  let d = raw.replace(/\D/g, '');
  const international = raw.trim().startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^91[6-9]\d{9}$/.test(d)) return d;
  if (/^[6-9]\d{9}$/.test(d)) return `91${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `91${d.slice(1)}`;
  if (/^091[6-9]\d{9}$/.test(d)) return d.slice(1);
  return international && !d.startsWith('91') && !d.startsWith('0') && d.length >= 11 && d.length <= 15 ? d : '';
}

export type WhatsAppOutreach = { ok: true; template: WhatsAppTemplate | null; text: string; number: string; url: string } | { ok: false; error: string };

const builtInBody = (segment: string): string | null => {
  const t = templateFor(segment);
  const icp = t === 'manufacturing' ? 'Manufacturing' : t === '3pl' ? '3PL & Logistics' : t === 'ca' ? 'CA Firms' : '';
  return DEFAULT_TEMPLATES.find((x) => x.channel === 'whatsapp' && x.icp === icp)?.body ?? null;
};

/**
 * The message and link for a company, from its ICP's WhatsApp template (Configuration → Templates; with no configured set
 * given, the built-in Manufacturing, 3PL and CA ones). The name is the main contact's, the BDA is the one who owns the
 * company (not whoever is logged in), and the number is the main contact's. Anything missing that the template needs is a
 * plain error, never a blank in the message.
 */
export function buildWhatsApp(
  lead: { segment: string; company: string; contactName: string; contactPhone: string },
  ownerName: string | null | undefined,
  templates?: TemplateSet,
  /** Which step of the ICP's sequence this message is for: 0 the first contact, n the n-th follow-up. */
  step = 0,
): WhatsAppOutreach {
  const number = whatsAppDigits(lead.contactPhone);
  if (!number) return { ok: false, error: "A valid WhatsApp number is needed for the main contact. Add a mobile number under Edit point of contact first." };
  const body = templates ? (templates.get(templateKey(lead.segment, 'whatsapp', step))?.body ?? null) : step === 0 ? builtInBody(lead.segment) : null;
  // Nothing is written for a step with no template: it is flagged until an administrator assigns one.
  if (!body) return { ok: false, error: step === 0 ? `There is no WhatsApp template for the segment "${lead.segment || 'not set'}". An administrator can add and assign one under Configuration → Templates.` : `No WhatsApp template is assigned to Follow-up ${step} for "${lead.segment || 'not set'}". An administrator can assign one under Configuration → Templates.` };
  const vars = varsFor(lead, ownerName, contactFirstName, (n) => (contactFirstName(n) ? n.trim() : ''));
  const r = renderTemplate(body, vars);
  if (!r.ok) {
    // The same plain messages as before for the two a BDA can fix.
    if (r.missing.includes('bd_name')) return { ok: false, error: 'This company has no owner yet, so there is no BDA name for the message. Assign it to a BDA first.' };
    if (r.missing.includes('company_name')) return { ok: false, error: "This company's name is missing, so the message can't be filled in." };
    return { ok: false, error: `The message needs ${r.missing.map((m) => MISSING_TEXT[m]).join(' and ')}, which is missing in the CRM. Correct the record first.` };
  }
  return { ok: true, template: templateFor(lead.segment), text: r.text, number, url: `https://wa.me/${number}?text=${encodeURIComponent(r.text)}` };
}
