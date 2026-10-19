'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, tasks, users, whatsappMessages } from '@/lib/db/schema';
import { mayActOn } from '@/lib/access';
import { waNumber } from '@/lib/phones';
import { getSettings } from '@/lib/settings';
import { requireUser } from '@/lib/users';
import { formatDateTime } from '@/lib/dates';
import { waConfig } from '@/lib/whatsapp/cloud';
import { CONSENT_WAYS, recordConsent, removeConsent, sendFromInveck } from '@/lib/whatsapp/contacts';
import { buildWhatsApp } from '@/lib/whatsapp-outreach';
import { completeTaskAction } from './team-actions';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const reviewed = (f: FormData) => (f.has('body') ? String(f.get('body') ?? '') : undefined);

export type SendWhatsAppState = { error: string; sent?: boolean };

/**
 * "Send WhatsApp" on a Today step: sends from INVECK's number (the approved template, or the reviewed
 * text within 24 hours of their last message), then logs the step as "Mark sent" would. Only the
 * company's owner, only to someone who agreed, and never twice for one step.
 */
export async function sendWhatsAppAction(_prev: SendWhatsAppState, form: FormData): Promise<SendWhatsAppState> {
  const user = await requireUser();
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, Number(str(form, 'id'))));
  if (!task || task.kind !== 'whatsapp') return { error: 'This WhatsApp step no longer exists. Refresh the page.' };
  if (task.doneAt) return { error: 'This step was already logged. Refresh the page.' };
  if (task.ownerId !== user.id) return { error: 'Only the person this company belongs to can send its WhatsApp.' };
  // Sent before and the step undone since: it went, so it is only to be logged.
  const [went] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.taskId, task.id));
  if (went) return { error: went.status === 'sending' ? 'This WhatsApp is already being sent. Refresh the page.' : `This WhatsApp already went from INVECK's number (${formatDateTime(went.at)}): click Mark sent to log it.` };
  const c = waConfig();
  if (!c) return { error: "WhatsApp sending isn't set up on the server yet." };
  const [lead] = await db.select().from(leads).where(eq(leads.id, task.leadId));
  if (!lead) return { error: 'This company no longer exists.' };
  const r = await sendFromInveck(db, c, { lead, user, settings: await getSettings(db), taskId: task.id, text: reviewed(form) });
  if (r.error) return { error: r.error };
  const done = new FormData();
  done.set('id', String(task.id));
  done.set('outcome', 'sent');
  await completeTaskAction(done);
  return { error: '', sent: true };
}

/** A WhatsApp from the company page: a reply while they wrote in the last 24 hours, else the approved template. */
export async function sendWhatsAppMessageAction(_prev: SendWhatsAppState, form: FormData): Promise<SendWhatsAppState> {
  const user = await requireUser();
  const leadId = Number(str(form, 'leadId'));
  if (!(await mayActOn(leadId))) return { error: 'Only the person this company belongs to, or an administrator, can message them.' };
  const c = waConfig();
  if (!c) return { error: "WhatsApp sending isn't set up on the server yet." };
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return { error: 'This company no longer exists.' };
  const [owner] = user.role === 'admin' && lead.ownerId ? await db.select({ name: users.name }).from(users).where(eq(users.id, lead.ownerId)) : [];
  const r = await sendFromInveck(db, c, { lead, user, settings: await getSettings(db), text: reviewed(form), sender: owner?.name });
  if (r.error) return { error: r.error };
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/today');
  return { error: '', sent: true };
}

/** Marks that the contact agreed to WhatsApp from INVECK (and how), or takes a mark made in error back. */
export async function setWhatsAppConsentAction(form: FormData) {
  const user = await requireUser();
  const leadId = Number(str(form, 'leadId'));
  if (!(await mayActOn(leadId))) return;
  const db = await getDb();
  const [lead] = await db.select({ phone: leads.contactPhone }).from(leads).where(eq(leads.id, leadId));
  const waId = waNumber(lead?.phone ?? '');
  if (!waId) return;
  if (str(form, 'agree') === '1') {
    const how = (CONSENT_WAYS as readonly string[]).includes(str(form, 'how')) ? str(form, 'how') : 'Other';
    await recordConsent(db, { waId, leadId, how, by: { id: user.id, name: user.name } });
  } else {
    await removeConsent(db, waId, leadId, user.name);
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/today');
}

/** A WhatsApp that needs no answer: off the replies list (with anything else waiting from that number). */
export async function dismissWhatsAppReplyAction(form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const [msg] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.id, Number(str(form, 'id'))));
  if (!msg || msg.direction !== 'in') return;
  if (msg.leadId ? !(await mayActOn(msg.leadId)) : user.role !== 'admin') return;
  await db
    .update(whatsappMessages)
    .set({ handledAt: new Date() })
    .where(and(eq(whatsappMessages.waId, msg.waId), eq(whatsappMessages.direction, 'in'), isNull(whatsappMessages.handledAt)));
  revalidatePath('/today');
  if (msg.leadId) revalidatePath(`/leads/${msg.leadId}`);
}

/**
 * The BDA's own WhatsApp (a wa.me link with the template filled in) opened for a Today step: that logs the step
 * as sent. The message is built again here from what is saved, so a step whose message can't be built (no owner,
 * no number, an unmatched segment) is never logged, and only the company's owner can log it.
 */
export async function openedWhatsAppAction(taskId: number): Promise<{ error: string }> {
  const user = await requireUser();
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, Number(taskId)));
  if (!task || task.kind !== 'whatsapp') return { error: 'This WhatsApp step no longer exists. Refresh the page.' };
  if (task.doneAt) return { error: '' };
  if (task.ownerId !== user.id) return { error: 'Only the person this company belongs to can send its WhatsApp.' };
  const [lead] = await db.select().from(leads).where(eq(leads.id, task.leadId));
  if (!lead) return { error: 'This company no longer exists.' };
  const [owner] = lead.ownerId != null ? await db.select({ name: users.name }).from(users).where(eq(users.id, lead.ownerId)) : [];
  const built = buildWhatsApp(lead, owner?.name);
  if (!built.ok) return { error: built.error };
  const done = new FormData();
  done.set('id', String(task.id));
  done.set('outcome', 'sent');
  done.set('note', 'Opened in WhatsApp');
  await completeTaskAction(done);
  return { error: '' };
}
