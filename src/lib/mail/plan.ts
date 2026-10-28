import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { sentEmails, type Lead, type SentEmail } from '../db/schema';
import { formatDateTime } from '../dates';
import { firstEmailFor } from './first-email';
import type { TemplateSet } from '../config';
import { htmlToText } from '../rich-text';

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
  /** A follow-up to someone already emailed, not the first email. */
  followUp: boolean;
  subject: string;
  /** What the sender writes; for a follow-up, the earlier email is quoted below it when sent. */
  body: string;
  quote: string;
  /** The body is sanitized HTML (a configured template), shown and edited as formatted text; otherwise plain text. */
  html?: boolean;
  /** Manufacturing / 3PL first email: its template (and PDF) apply. */
  template?: 'manufacturing' | '3pl';
  /** Why it can't be sent yet (a name missing for the template), else ''. */
  problem: string;
};

/**
 * What the next email to a contact is: the template assigned to the step it is for (Configuration → Templates): the first
 * contact, or follow-up n once they have been emailed (with the last email quoted below it). A step with no template is a
 * problem to fix, never a drafted email: nothing is written for it, and it can't be sent until an administrator assigns one.
 */
export function planEmail(lead: Lead, prior: SentEmail | undefined, sign: { from?: string; as?: string; owner?: string | null; templates?: TemplateSet; /** Which follow-up this is (see emailStepOf); 0 or none: the first contact. */ step?: number }): EmailPlan {
  // Emailed from the app before, or by hand on any earlier step (marked sent): never the first email twice.
  const followUp = !!prior || emailedAlready(lead);
  const step = followUp ? sign.step || 1 : 0;
  const found = firstEmailFor(lead, sign.owner, sign.templates, step);
  if (!found) {
    const where = step === 0 ? 'the first contact' : `Follow-up ${step}`;
    return { followUp, subject: '', body: '', quote: '', problem: `No email template is assigned to ${where} for ${lead.segment || 'this ICP'}. Nothing is written for it: an administrator can assign one under Configuration → Templates.` };
  }
  return { followUp, subject: found.subject, body: found.body, html: found.html, quote: followUp && prior ? quoteOf(prior) : '', template: found.template, problem: found.problem };
}

/**
 * Which step of its ICP's email sequence a task is: the follow-up round it carries (a CA firm's round, or the general one), else
 * the next one after those already used up. The first contact is 0.
 */
export function emailStepOf(task: { followUpRound: number; caRound: number }, lead: Pick<Lead, 'followUpStep'>, followUp: boolean): number {
  if (!followUp) return 0;
  return task.followUpRound > 0 ? task.followUpRound : task.caRound > 0 ? task.caRound : lead.followUpStep + 1;
}

/** The earlier email, quoted under a follow-up the way mail apps do. */
function quoteOf(e: SentEmail): string {
  return ['-----Original message-----', `From: ${e.fromAddress}`, `Sent: ${e.sentAt ? formatDateTime(e.sentAt) : ''}`, `To: ${e.toAddress}`, `Subject: ${e.subject}`, '', /^<p[\s>]/.test(e.body) ? htmlToText(e.body) : e.body].join('\n');
}
