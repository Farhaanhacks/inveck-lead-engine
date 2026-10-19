import { normSegment } from './icp-match';
import { splitPhones } from './phones';
import { isCaSegment } from './tasks';

/**
 * The first WhatsApp a BDA sends a company, from their own WhatsApp (a wa.me click-to-chat link with the
 * message filled in). The three texts are fixed wording, never rewritten: only [Name], [BD Name] and
 * [Company Name] are replaced.
 */

export type WhatsAppTemplate = 'manufacturing' | '3pl' | 'ca';

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

const FOOT_MANUFACTURING =
  'A quick question — when physical inventory verification happens across your plants or warehouses, is your team still using count sheets, Excel, and manual consolidation?\n\n' +
  'Inveck helps manufacturing teams digitize this workflow — physical verification → real-time data → variance reporting → reconciliation, reducing paperwork and manual consolidation.\n\n' +
  "I’m sharing our product profile. Would be glad to understand how your team currently handles inventory verification.";

const FOOT_3PL =
  'A quick question — when verifying inventory across your warehouses or client locations, does your team still rely on count sheets, Excel, and manual consolidation?\n\n' +
  'Inveck helps 3PL and warehousing companies digitize physical inventory verification through mobile-based counting, real-time data capture, variance reporting, and reconciliation, reducing paperwork and manual effort.\n\n' +
  "I’m sharing our product profile for your reference. Would be glad to understand how your team currently handles inventory verification across warehouses.";

const CA_TEXT =
  'Hi Sir/Ma’am, quick question\n\n' +
  'During your stock audit / physical inventory verification assignments, does your team still have to manage count sheets, consolidate Excel files, follow up on variances and prepare the final data for review?\n\n' +
  'That’s exactly the gap INVECK is solving for CA & Audit firms digitising physical verification from counting to reporting, while giving your team better visibility across the assignment.\n\n' +
  'We’re already working with businesses across industries and CA & Advisory firms.\n\n' +
  'Sharing a short overview if you handle stock audits or physical verification for your clients, this could be very relevant for your next assignment. 👇';

export type WhatsAppOutreach = { ok: true; template: WhatsAppTemplate; text: string; number: string; url: string } | { ok: false; error: string };

/**
 * The message and link for a company. The name is the main contact's, the BDA is the one who owns the company
 * (not whoever is logged in), and the number is the main contact's. Anything missing that the template needs is a
 * plain error, never a blank in the message.
 */
export function buildWhatsApp(lead: { segment: string; company: string; contactName: string; contactPhone: string }, ownerName: string | null | undefined): WhatsAppOutreach {
  const number = whatsAppDigits(lead.contactPhone);
  if (!number) return { ok: false, error: "A valid WhatsApp number is needed for the main contact. Add a mobile number under Edit point of contact first." };
  const template = templateFor(lead.segment);
  if (!template) return { ok: false, error: `There is no WhatsApp message for the segment "${lead.segment || 'not set'}". Messages exist for Manufacturing, 3PL & Logistics and CA Firms.` };
  const bda = String(ownerName ?? '').trim();
  const company = lead.company.trim();
  let text: string;
  if (template === 'ca') {
    text = CA_TEXT;
  } else {
    if (!bda) return { ok: false, error: 'This company has no owner yet, so there is no BDA name for the message. Assign it to a BDA first.' };
    const first = contactFirstName(lead.contactName);
    const greeting = first ? `Hi ${first} Sir,` : 'Hi Sir/Ma’am,';
    if (template === 'manufacturing') {
      text = `${greeting} ${bda} this side from Inveck. I tried reaching you regarding the physical stock counting process at your organization.\n\n${FOOT_MANUFACTURING}`;
    } else {
      if (!company) return { ok: false, error: "This company's name is missing, so the message can't be filled in." };
      text = `${greeting} ${bda} this side from Inveck. I tried reaching you regarding the inventory verification process at ${company}.\n\n${FOOT_3PL}`;
    }
  }
  return { ok: true, template, text, number, url: `https://wa.me/${number}?text=${encodeURIComponent(text)}` };
}
