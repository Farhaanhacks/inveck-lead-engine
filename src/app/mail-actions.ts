'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, people, sentEmails, tasks } from '@/lib/db/schema';
import { logActivity } from '@/lib/activity';
import { getSettings } from '@/lib/settings';
import { requireUser } from '@/lib/users';
import { disconnectMailbox, MailError, sendFromMailbox } from '@/lib/mail/outlook';
import { lastSentTo, leadAddresses, planEmail, sentByLead } from '@/lib/mail/plan';
import { draftFollowUp, FOLLOW_UP_ROUNDS } from '@/lib/pipeline/follow-ups';
import { errorMessage } from '@/lib/pipeline/text';
import { formatDateTime } from '@/lib/dates';
import { liveServices } from '@/lib/run-driver';
import { completeTaskAction } from './team-actions';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export type SendMailState = { error: string; sent?: boolean };

/**
 * "Send mail" on a Today email step: sends the email from the person's own Outlook, then logs the
 * step exactly as "Mark sent" would. Quick send uses the draft as it stands; the review form sends
 * what was reviewed (to, subject and text as edited). Only the company's owner can send, and a step
 * is never sent twice.
 */
export async function sendEmailAction(_prev: SendMailState, form: FormData): Promise<SendMailState> {
  const user = await requireUser();
  const id = Number(str(form, 'id'));
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task || task.kind !== 'email') return { error: 'This email step no longer exists. Refresh the page.' };
  if (task.doneAt) return { error: 'This step was already logged. Refresh the page.' };
  if (task.ownerId !== user.id) return { error: 'Only the person this company belongs to can send its email.' };
  // Sent before and the step undone since: it went, so it is only to be logged.
  const [went] = await db.select().from(sentEmails).where(eq(sentEmails.taskId, task.id));
  if (went) return { error: went.status === 'sent' ? `This email already went from Outlook${went.sentAt ? ` (${formatDateTime(went.sentAt)})` : ''}: click Mark sent to log it.` : 'This email is already being sent. Refresh the page.' };
  const [lead] = await db.select().from(leads).where(eq(leads.id, task.leadId));
  if (!lead) return { error: 'This company no longer exists.' };

  const others = await db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leadId, lead.id));
  const addresses = leadAddresses(lead, others);
  const to = (str(form, 'to') || addresses[0] || '').toLowerCase();
  if (!to) return { error: 'No email address is saved for this contact: add one first.' };
  if (!addresses.includes(to)) return { error: 'Send to one of the addresses saved for this contact.' };

  const settings = await getSettings(db);
  const prior = lastSentTo((await sentByLead(db, [lead.id])).get(lead.id), to);
  const plan = planEmail(lead, prior, { from: settings.senderName, as: user.name });
  const reviewed = form.has('body');
  const subject = (reviewed ? str(form, 'subject') : plan.subject).trim();
  const body = (reviewed ? String(form.get('body') ?? '') : plan.body).trim();
  if (!body) return { error: plan.followUp ? 'No follow-up written yet: write it, or use Write it for me.' : 'There is no email draft yet: write it first.' };
  if (!subject && !plan.replyTo) return { error: 'Add a subject.' };

  // One send per step, even with two clicks or two tabs open.
  const [claim] = await db
    .insert(sentEmails)
    .values({ leadId: lead.id, taskId: task.id, userId: user.id, toAddress: to, subject, body })
    .onConflictDoNothing()
    .returning({ id: sentEmails.id });
  if (!claim) return { error: 'This email is already being sent, or was sent. Refresh the page.' };
  let sent: Awaited<ReturnType<typeof sendFromMailbox>>;
  try {
    sent = await sendFromMailbox(db, user.id, { to, subject, body: plan.quote ? `${body}\n\n${plan.quote}` : body, replyTo: plan.replyTo || undefined });
  } catch (e) {
    await db.delete(sentEmails).where(eq(sentEmails.id, claim.id));
    if (!(e instanceof MailError)) console.error('[mail] send failed:', e);
    return { error: e instanceof MailError ? e.message : `Couldn't send: ${errorMessage(e)}` };
  }
  const now = new Date();
  await db
    .update(sentEmails)
    .set({ status: 'sent', sentAt: now, fromAddress: sent.from, graphId: sent.graphId, conversationId: sent.conversationId })
    .where(eq(sentEmails.id, claim.id));

  // What went out is what the lead shows: the first email as sent; a follow-up is used up.
  if (!plan.followUp) {
    await db.update(leads).set({ emailSubject: subject, emailBody: body, updatedAt: now }).where(eq(leads.id, lead.id));
  } else {
    const step = task.followUpRound > 0 ? task.followUpRound : Math.min(lead.followUpStep + 1, FOLLOW_UP_ROUNDS);
    await db
      .update(leads)
      .set({ followUpSubject: '', followUpBody: '', followUpStep: step, updatedAt: now })
      .where(eq(leads.id, lead.id));
  }
  await logActivity(db, lead.id, 'note', `${plan.followUp ? 'Follow-up' : 'Email'} sent from Outlook (${sent.from}) to ${to}${plan.replyTo ? ', in the same thread' : ''}: “${subject || `Re: ${prior?.subject ?? ''}`}”`);

  // The step is done, logged as "Mark sent" logs it (the counters, the stage, the next steps).
  const done = new FormData();
  done.set('id', String(task.id));
  done.set('outcome', 'done');
  await completeTaskAction(done);
  return { error: '', sent: true };
}

/** "Write it for me" on a follow-up: the AI writes the follow-up from the email already sent. */
export async function writeFollowUpForTaskAction(form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, Number(str(form, 'id'))), eq(tasks.kind, 'email')));
  if (!task || task.doneAt || task.ownerId !== user.id) return;
  const [lead] = await db.select().from(leads).where(eq(leads.id, task.leadId));
  if (!lead) return;
  const r = await draftFollowUp(db, await liveServices(), lead);
  if (!r.ok) await logActivity(db, lead.id, 'error', `Couldn't write the follow-up: ${r.error}`);
  revalidatePath('/today');
  revalidatePath(`/leads/${lead.id}`);
}

/** Disconnects the person's Outlook: nothing is sent from it until they connect it again. */
export async function disconnectMailboxAction() {
  const user = await requireUser();
  if (!user.id) return;
  await disconnectMailbox(await getDb(), user.id);
  revalidatePath('/account');
  revalidatePath('/today');
}
