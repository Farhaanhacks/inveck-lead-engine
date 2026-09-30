'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, tasks, users, type TaskKind } from '@/lib/db/schema';
import { logActivity } from '@/lib/activity';
import { clockIn, clockOut } from '@/lib/attendance';
import { canReassign } from '@/lib/assign';
import { checkPassword, DEFAULT_PASSWORD, hashPassword, MIN_PASSWORD_LENGTH, requireUser } from '@/lib/users';
import { dayCounts, DAILY_LINKEDIN_LIMIT, istDay } from '@/lib/tasks';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

const OUTCOMES: Record<TaskKind, string[]> = {
  call: ['connected', 'no_answer', 'busy', 'wrong_number'],
  whatsapp: ['sent', 'skipped'],
  linkedin: ['sent', 'skipped'],
  email: ['done', 'skipped'],
};

const OUTCOME_TEXT: Record<string, string> = {
  connected: 'Call connected',
  no_answer: 'Call: no answer',
  busy: 'Call: busy or voicemail',
  wrong_number: 'Call: wrong number',
};

/** A date typed as YYYY-MM-DD that is today or later, else ''. */
function futureDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= istDay() ? value : '';
}

/** Logs what happened on a task. A connected call needs a note and ends the rest of the sequence for that lead. */
export async function completeTaskAction(form: FormData) {
  const user = await requireUser();
  const id = Number(str(form, 'id'));
  const outcome = str(form, 'outcome');
  const note = str(form, 'note').slice(0, 2000);
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task || task.doneAt) return;
  if (user.role !== 'admin' && task.ownerId !== user.id) return;
  if (!OUTCOMES[task.kind].includes(outcome)) return;
  if (task.kind === 'call' && outcome === 'connected' && !note) return;
  if (task.kind === 'linkedin' && outcome === 'sent') {
    if ((await dayCounts(db, task.ownerId)).linkedinSent >= DAILY_LINKEDIN_LIMIT) return;
  }

  await db.update(tasks).set({ doneAt: new Date(), outcome, note: note || task.note }).where(and(eq(tasks.id, id), isNull(tasks.doneAt)));

  const what =
    task.kind === 'call'
      ? OUTCOME_TEXT[outcome]
      : task.kind === 'whatsapp'
        ? 'WhatsApp message sent'
        : task.kind === 'linkedin'
          ? 'LinkedIn connection request sent'
          : 'Email sent';
  const skipped = outcome === 'skipped';
  await logActivity(db, task.leadId, task.kind === 'call' ? 'call' : 'note', skipped ? `${task.title}: skipped` : `${what}${task.step ? ` (${task.step})` : ''}${note ? `. ${note}` : ''}`);

  if (task.kind === 'call' && outcome === 'connected') {
    // Spoke to them: the rest of the automatic sequence is no longer needed.
    await db
      .update(tasks)
      .set({ doneAt: new Date(), outcome: 'skipped' })
      .where(and(eq(tasks.leadId, task.leadId), isNull(tasks.doneAt), eq(tasks.priority, false)));
    const callback = futureDay(str(form, 'callbackDate'));
    if (callback) {
      await db.insert(tasks).values({
        leadId: task.leadId,
        ownerId: task.ownerId,
        kind: 'call',
        step: 'Promised callback',
        title: 'Promised callback',
        dueDate: callback,
        slot: 'day',
        priority: true,
        note,
      });
      await logActivity(db, task.leadId, 'note', `Callback promised for ${callback}`);
    }
  }
  revalidatePath('/today');
  revalidatePath(`/leads/${task.leadId}`);
}

export async function clockInAction() {
  const user = await requireUser();
  if (user.id) await clockIn(await getDb(), user.id);
  revalidatePath('/today');
}

export async function clockOutAction() {
  const user = await requireUser();
  if (user.id) await clockOut(await getDb(), user.id);
  revalidatePath('/today');
}

export type PasswordState = { ok: boolean; message: string } | undefined;

export async function changePasswordAction(_prev: PasswordState, form: FormData): Promise<PasswordState> {
  const user = await requireUser();
  if (!user.id) return { ok: false, message: 'The admin password is set in the server settings (APP_PASSWORD), not here.' };
  const current = String(form.get('current') ?? '');
  const next = String(form.get('next') ?? '');
  const confirm = String(form.get('confirm') ?? '');
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.id, user.id));
  if (!row || !(await checkPassword(current, row.passwordHash))) return { ok: false, message: 'Your current password is wrong.' };
  if (next.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (next === DEFAULT_PASSWORD) return { ok: false, message: 'Choose a password other than the starting one.' };
  if (next !== confirm) return { ok: false, message: 'The two new passwords are different.' };
  await db.update(users).set({ passwordHash: await hashPassword(next), mustChangePassword: false }).where(eq(users.id, user.id));
  revalidatePath('/', 'layout');
  return { ok: true, message: 'Password changed.' };
}

/** Admin only: puts a team member back on the starting password, to be changed at next login. */
export async function resetPasswordAction(form: FormData) {
  const user = await requireUser();
  if (user.role !== 'admin') return;
  const id = Number(str(form, 'userId'));
  if (!id) return;
  const db = await getDb();
  await db.update(users).set({ passwordHash: await hashPassword(DEFAULT_PASSWORD), mustChangePassword: true }).where(eq(users.id, id));
  revalidatePath('/account');
}

export async function assignOwnerAction(form: FormData) {
  const user = await requireUser();
  const id = Number(str(form, 'id'));
  const ownerId = Number(str(form, 'ownerId'));
  const db = await getDb();
  const [owner] = await db.select().from(users).where(and(eq(users.id, ownerId), eq(users.active, true)));
  const [lead] = id ? await db.select({ ownerId: leads.ownerId }).from(leads).where(eq(leads.id, id)) : [];
  if (!owner || !lead || !canReassign(user, lead)) return;
  await db.update(leads).set({ ownerId }).where(eq(leads.id, id));
  // Open tasks go with the lead.
  await db.update(tasks).set({ ownerId }).where(and(eq(tasks.leadId, id), isNull(tasks.doneAt)));
  await logActivity(db, id, 'note', `Owner changed to ${owner.name}`);
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/today');
}

/** Hands several leads to one person at once. */
export async function assignOwnerBulk(ids: number[], ownerId: number) {
  const db = await getDb();
  await db.update(leads).set({ ownerId }).where(inArray(leads.id, ids));
}
