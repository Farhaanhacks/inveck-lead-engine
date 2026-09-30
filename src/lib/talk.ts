import type { Lead } from './db/schema';

const CA = /\b(ca|chartered|audit|accountant)/i;

export function firstName(full: string): string {
  return full.replace(/^(mr|mrs|ms|dr|ca)\.?\s+/i, '').trim().split(/\s+/)[0] || 'there';
}

const isCa = (lead: Pick<Lead, 'segment'>) => CA.test(lead.segment);

function hook(lead: Pick<Lead, 'signals' | 'company' | 'segment'>): string {
  const s = lead.signals[0];
  return s ? `I saw that ${s.headline.replace(/[.\s]+$/, '')}.` : isCa(lead) ? 'I work with audit firms on stock and asset verification.' : `I work with manufacturing and logistics teams like ${lead.company} on stock and asset verification.`;
}

const PITCH = 'INVECK lets teams count stock and verify assets on mobile and reconcile against ERP records without Excel.';

/** What to say in the first 30 seconds of a call. */
export function callOpener(lead: Pick<Lead, 'contactName' | 'signals' | 'company' | 'segment'>, bda: string): string {
  return `Hi ${firstName(lead.contactName)}, this is ${bda} from INVECK. ${hook(lead)} ${PITCH} Is this a good moment for a minute?`;
}

export function discoveryQuestions(lead: Pick<Lead, 'segment'>): string[] {
  return isCa(lead)
    ? [
        'Which audits do you run that include physical verification of stock or assets?',
        'How do your teams capture counts in the field today: registers, Excel, or an app?',
        'How long does reconciliation and reporting take after the count?',
        'How many clients and audit staff would use it?',
        'Who else at the firm should see a demo?',
      ]
    : [
        'How do you count and verify stock and assets today: paper registers, Excel, or your ERP?',
        'How many plants or warehouses, and how often do you run a physical verification?',
        'How long does reconciliation take after a count, and who does it?',
        'What happens when the count does not match the books?',
        'Who else would need to see a demo: operations, finance or audit?',
      ];
}

export function whatsappIntro(lead: Pick<Lead, 'contactName' | 'signals' | 'company' | 'segment'>, bda: string): string {
  return `Hi ${firstName(lead.contactName)}, this is ${bda} from INVECK. ${hook(lead)} ${PITCH} Could I call you at a convenient time, or share a short note first?`;
}

/** A LinkedIn connection note, kept under the 200 characters a free account allows. */
export function linkedinNote(lead: Pick<Lead, 'contactName' | 'segment'>, bda: string): string {
  const who = isCa(lead) ? 'audit firms' : 'manufacturing and logistics teams';
  const note = `Hi ${firstName(lead.contactName)}, I'm ${bda} at INVECK. We help ${who} verify stock and assets on mobile. Would be glad to connect.`;
  return note.length <= 200 ? note : note.slice(0, 197) + '...';
}

/** A click-to-chat link with the message filled in, or '' when there is no usable number. */
export function whatsappLink(phone: string, text: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = '91' + digits;
  if (digits.length < 11 || digits.length > 15) return '';
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
