import { and, asc, eq, gt, isNull, lte, notInArray } from 'drizzle-orm';
import type { Db } from '../db';
import { leads, tasks, type Lead } from '../db/schema';
import { logActivity } from '../activity';
import { FOLLOW_UP_ROUNDS, nextEmailRound } from '../follow-up-sequence';
import { emailedAlready } from '../mail/plan';
import { istDay } from '../tasks';
import { askJson } from './ai';
import { readDraft } from './draft';
import { FOLLOW_UP_PROMPT } from './prompts';
import type { Services } from './services';
import { signalLines } from './signals';

// When follow-ups fall due is decided by the follow-up sequence (lib/follow-up-sequence.ts), not here:
// this file only writes the AI draft for a round's email.
export { FOLLOW_UP_ROUNDS };

const schema = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
};

/** The AI's follow-up draft for a round (1-5, default the next one); one retry when a field is missing. */
export async function writeFollowUp(svc: Services, lead: Lead, round = lead.followUpStep + 1): Promise<{ subject?: string; body?: string; error?: string }> {
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
    `## This is follow-up ${round} of ${FOLLOW_UP_ROUNDS}${round >= FOLLOW_UP_ROUNDS ? ': the last one' : ''}`,
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

/** Writes and stores the draft for a lead's next open follow-up email. It stays editable until someone marks it sent. */
export async function draftFollowUp(db: Db, svc: Services, lead: Lead): Promise<{ ok: boolean; error?: string }> {
  const round = (await nextEmailRound(db, lead.id))?.followUpRound ?? lead.followUpStep + 1;
  const out = await writeFollowUp(svc, lead, round);
  if (!out.body) return { ok: false, error: out.error };
  await db.update(leads).set({ followUpSubject: out.subject!, followUpBody: out.body, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await logActivity(db, lead.id, 'follow_up_drafted', `Follow-up ${round} drafted, waiting for approval`);
  return { ok: true };
}

/** Drafts the follow-up emails that are due (an open round's email, first email already sent) and not written yet. */
export async function draftDueFollowUps(db: Db, svc: Services, log: (m: string, level?: 'info' | 'warn' | 'error') => Promise<void>, max = 10) {
  const rows = await db
    .select({ lead: leads })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(
      and(
        eq(tasks.kind, 'email'),
        gt(tasks.followUpRound, 0),
        isNull(tasks.doneAt),
        lte(tasks.dueDate, istDay()),
        eq(leads.followUpBody, ''),
        notInArray(leads.status, ['Deleted', 'Replied', 'Meeting Booked', 'Won', 'Lost', 'Disqualified', 'Rejected', 'Existing Client']),
      ),
    )
    .orderBy(asc(tasks.followUpRound));
  const due = [...new Map(rows.map((r) => [r.lead.id, r.lead])).values()].filter(emailedAlready).slice(0, max);
  let drafted = 0;
  for (const lead of due) {
    const r = await draftFollowUp(db, svc, lead);
    if (r.ok) drafted++;
    else await log(`${lead.company}: follow-up draft failed: ${r.error}`, 'warn');
  }
  if (drafted) await log(`Drafted ${drafted} follow-up${drafted === 1 ? '' : 's'} due today; they're waiting for approval`);
  return drafted;
}
