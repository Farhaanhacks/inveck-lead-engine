import { and, eq, isNotNull, lte, lt } from 'drizzle-orm';
import type { Db } from '../db';
import { leads, type Lead } from '../db/schema';
import { logActivity } from '../activity';
import { askJson } from './ai';
import { readDraft } from './draft';
import { FOLLOW_UP_PROMPT } from './prompts';
import type { Services } from './services';
import { signalLines } from './signals';

/** Follow-ups go out this many days after the first email. */
export const FOLLOW_UP_DAYS = [3, 7] as const;
const DAY = 24 * 60 * 60 * 1000;

/** When the next follow-up is due, given the first send and how many follow-ups have gone. */
export function nextFollowUpAt(sentAt: Date, sentSoFar: number): Date | null {
  const days = FOLLOW_UP_DAYS[sentSoFar];
  return days === undefined ? null : new Date(sentAt.getTime() + days * DAY);
}

const schema = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

/** The AI's follow-up draft for the next step; one retry when a field is missing. */
export async function writeFollowUp(svc: Services, lead: Lead): Promise<{ subject?: string; body?: string; error?: string }> {
  const step = lead.followUpStep + 1;
  const s = svc.settings;
  const userText = [
    `## Company: ${lead.company}${lead.city ? ` (${lead.city})` : ''}`,
    lead.researchSummary,
    ...(lead.signals.length ? ['', '## Recent news (buying signals)', signalLines(lead.signals)] : []),
    '',
    '## Contact',
    `Name: ${lead.contactName}`,
    `Title: ${lead.contactTitle}`,
    '',
    '## Email already sent',
    `Subject: ${lead.emailSubject}`,
    lead.emailBody,
    '',
    step <= FOLLOW_UP_DAYS.length ? `## This is follow-up ${step} of ${FOLLOW_UP_DAYS.length}` : `## This is follow-up ${step}: a last, short nudge`,
    '',
    '## Sender',
    `Name: ${s.senderName}`,
    `Title: ${s.senderTitle}`,
    `Company: ${s.senderCompany}`,
    `Demo link: ${s.demoLink || '(none; ask for a convenient time instead)'}`,
  ].join('\n');

  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await askJson(svc, FOLLOW_UP_PROMPT, userText, schema);
    if (result.error !== undefined) {
      error = result.error;
      continue;
    }
    const d = readDraft(result.data);
    if (d.body) return { subject: d.subject || `Re: ${lead.emailSubject}`, body: d.body };
    error = 'The AI follow-up is missing a body';
  }
  return { error };
}

/** Writes and stores the next follow-up for one lead. */
export async function draftFollowUp(db: Db, svc: Services, lead: Lead): Promise<{ ok: boolean; error?: string }> {
  const out = await writeFollowUp(svc, lead);
  if (!out.body) return { ok: false, error: out.error };
  await db.update(leads).set({ followUpSubject: out.subject!, followUpBody: out.body, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await logActivity(db, lead.id, 'follow_up_drafted', `Follow-up ${lead.followUpStep + 1} drafted, waiting for approval`);
  return { ok: true };
}

/** Drafts follow-ups that are due and not written yet (runs do this before researching). */
export async function draftDueFollowUps(db: Db, svc: Services, log: (m: string, level?: 'info' | 'warn' | 'error') => Promise<void>, max = 10) {
  const due = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.status, 'Contacted'),
        isNotNull(leads.nextFollowUpAt),
        lte(leads.nextFollowUpAt, new Date()),
        eq(leads.followUpBody, ''),
        lt(leads.followUpStep, FOLLOW_UP_DAYS.length),
      ),
    )
    .limit(max);
  let drafted = 0;
  for (const lead of due) {
    const r = await draftFollowUp(db, svc, lead);
    if (r.ok) drafted++;
    else await log(`${lead.company}: follow-up draft failed: ${r.error}`, 'warn');
  }
  if (drafted) await log(`Drafted ${drafted} follow-up${drafted === 1 ? '' : 's'} due today; they're waiting for approval`);
  return drafted;
}
