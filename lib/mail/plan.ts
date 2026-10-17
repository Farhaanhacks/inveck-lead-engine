import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { sentEmails, type Lead, type SentEmail } from '../db/schema';
import { formatDateTime } from '../dates';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The addresses saved for a lead's contact, the main one first, then any more saved for the company ("Other email"). */
export function leadAddresses(lead: Pick<Lead, 'contactEmail'>, others: { name: string; email: string }[]): string[] {
  const all = [lead.contactEmail, ...others.filter((p) => p.name === 'Other email').map((p) => p.email)].map((e) => e.trim().toLowerCase());
  return [...new Set(all.filter((e) => EMAIL.test(e)))];
}

/** Emails sent from the app, newest first, per lead. */
export async function sentByLead(db: Db, leadIds: number[]): Promise<Map<number, SentEmail[]>> {
  const out = new Map<number, SentEmail[]>();
  if (!leadIds.length) return out;
  const rows = await db.select().from(sentEmails).where(and(inArray(sentEmails.leadId, leadIds), eq(sentEmails.status, 'sent'))).orderBy(desc(sentEmails.sentAt));
  for (const r of rows) out.set(r.leadId, [...(out.get(r.leadId) ?? []), r]);
  return out;
}

/** Mail outcomes that mean the first email has gone (from the app or by hand); a bounce means it never arrived. */
const EMAILED = ['Sent', 'No reply', 'Replied: interested', 'Replied: not interested'];
export const emailedAlready = (lead: Pick<Lead, 'mailOutcome'>) => EMAILED.includes(lead.mailOutcome);

/** The last email sent from the app to this address, if any. */
export const lastSentTo = (sent: SentEmail[] | undefined, to: string) => sent?.find((e) => e.toAddress === to.trim().toLowerCase());

export type EmailPlan = {
  /** A follow-up to someone already emailed (a reply in that thread), not the first email. */
  followUp: boolean;
  subject: string;
  /** What the sender writes; for a follow-up, the earlier email is quoted below it when sent. */
  body: string;
  quote: string;
  /** Outlook's id of the email being followed up, to reply in its thread. */
  replyTo: string;
};

/**
 * What the next email to a contact is: the lead's drafted first email, or, once they have been
 * emailed, a follow-up (the follow-up draft, sent as a reply to the last email). Drafts are signed
 * with the sender name in Settings; sent from someone's own mailbox, they are signed with theirs.
 */
export function planEmail(lead: Lead, prior: SentEmail | undefined, sign: { from: string; as: string }): EmailPlan {
  // Emailed from the app before, or by hand on any earlier step (marked sent): never the first email twice.
  const followUp = !!prior || emailedAlready(lead);
  const from = sign.from.trim();
  const as = sign.as.trim();
  // Only the sign-off: the sender name where it last appears, near the end (not every mention of it).
  const signed = (text: string) => {
    const i = text.lastIndexOf(from);
    return from.length >= 3 && as && from !== as && i >= 0 && i >= text.length - from.length - 200 ? text.slice(0, i) + as + text.slice(i + from.length) : text;
  };
  if (!followUp) return { followUp, subject: lead.emailSubject, body: signed(lead.emailBody), quote: '', replyTo: '' };
  const original = (prior?.subject || lead.emailSubject).replace(/^\s*re:\s*/i, '');
  return {
    followUp,
    subject: lead.followUpSubject || (original ? `Re: ${original}` : ''),
    body: signed(lead.followUpBody),
    quote: prior ? quoteOf(prior) : '',
    replyTo: prior?.graphId ?? '',
  };
}

/** The earlier email, quoted under a follow-up the way mail apps do. */
function quoteOf(e: SentEmail): string {
  return ['-----Original message-----', `From: ${e.fromAddress}`, `Sent: ${e.sentAt ? formatDateTime(e.sentAt) : ''}`, `To: ${e.toAddress}`, `Subject: ${e.subject}`, '', e.body].join('\n');
}
