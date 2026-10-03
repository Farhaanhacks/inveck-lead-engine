'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { escalate, newContactNamed, unansweredCalls, type Escalation } from '@/lib/escalate';
import { redraftForContact } from '@/lib/pipeline/redraft';
import { liveServices } from '@/lib/run-driver';
import { and, eq, gt, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { attendance, leads, people, tasks, users, type LeadStatus, type TaskKind } from '@/lib/db/schema';
import { moveAfterOutreach, stageAfterOutreach, undoOutreachStage } from '@/lib/stages';
import { logActivity } from '@/lib/activity';
import { clockIn, clockOut } from '@/lib/attendance';
import { canReassign } from '@/lib/assign';
import { runDailyDraw, topUpDraw } from '@/lib/draw';
import { CALL_FEEDBACK, NOT_INTERESTED, validTrackerValue, type TrackerField } from '@/lib/tracker';
import { mayActOn } from '@/lib/access';
import { checkPassword, DEFAULT_PASSWORD, hashPassword, MIN_PASSWORD_LENGTH, requireUser } from '@/lib/users';
import { dayCounts, DAILY_LINKEDIN_LIMIT, istDay, markCompanyDay, MAX_CALL_ATTEMPTS, nextWorkingDay } from '@/lib/tasks';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

const OUTCOMES: Record<TaskKind, string[]> = {
  call: ['connected', 'no_answer', 'busy', 'wrong_number', 'skipped'],
  whatsapp: ['sent', 'skipped'],
  linkedin: ['sent', 'skipped'],
  email: ['done', 'skipped'],
};

const WRONG_PREFIX = 'Wrong number: ';

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
  // Only the owner logs their own work, so the daily numbers are always theirs.
  if (task.ownerId !== user.id) return;
  if (!OUTCOMES[task.kind].includes(outcome)) return;
  const feedback = str(form, 'feedback');
  if (task.kind === 'call' && outcome === 'connected' && (!note || !(CALL_FEEDBACK as readonly string[]).includes(feedback))) return;
  if (task.kind === 'linkedin' && outcome === 'sent') {
    if ((await dayCounts(db, task.ownerId)).linkedinSent >= DAILY_LINKEDIN_LIMIT) return;
  }

  const now = new Date();
  // A wrong number is taken off the lead (and kept on the task, so Undo can put it back).
  const [lead] = await db.select({ phone: leads.contactPhone }).from(leads).where(eq(leads.id, task.leadId));
  const wrong = task.kind === 'call' && outcome === 'wrong_number' && !!lead?.phone;
  await db
    .update(tasks)
    .set({ doneAt: now, outcome, note: wrong ? `${WRONG_PREFIX}${lead!.phone}` : note || task.note })
    .where(and(eq(tasks.id, id), isNull(tasks.doneAt)));
  if (!task.priority) await catchUp(db, task, now);
  // Keep the tracker's outcome columns in step with what was logged.
  if (task.kind === 'call' && outcome === 'connected') {
    await db
      .update(leads)
      .set({ callRemark: note, ...((CALL_FEEDBACK as readonly string[]).includes(feedback) ? { callFeedback: feedback } : {}) })
      .where(eq(leads.id, task.leadId));
  }
  if (task.kind === 'call' && outcome === 'wrong_number') await db.update(leads).set({ callFeedback: 'Wrong number' }).where(eq(leads.id, task.leadId));
  if (task.kind === 'email' && outcome === 'done') {
    await db.update(leads).set({ mailOutcome: 'Sent' }).where(and(eq(leads.id, task.leadId), inArray(leads.mailOutcome, ['', 'Not sent'])));
  }
  if (task.kind === 'linkedin' && outcome === 'sent') {
    await db.update(leads).set({ linkedinOutcome: 'Request sent' }).where(and(eq(leads.id, task.leadId), inArray(leads.linkedinOutcome, ['', 'Not sent'])));
  }
  if (wrong) {
    await db.update(leads).set({ contactPhone: '' }).where(eq(leads.id, task.leadId));
    await logActivity(db, task.leadId, 'note', `Number ${lead!.phone} marked wrong and removed. Find the right one with ContactOut.`);
  }

  const what =
    task.kind === 'call'
      ? OUTCOME_TEXT[outcome]
      : task.kind === 'whatsapp'
        ? 'WhatsApp message sent'
        : task.kind === 'linkedin'
          ? 'LinkedIn connection request sent'
          : 'Email sent';
  const skipped = outcome === 'skipped';
  await logActivity(db, task.leadId, task.kind === 'call' && !skipped ? 'call' : 'note', skipped ? `${task.title}: skipped` : `${what}${task.step ? ` (${task.step})` : ''}${note ? `. ${note}` : ''}`);

  // The P2 flow: enough unanswered calls, or the wrong person, and the next person at the company takes over.
  let escalated: Escalation | null = null;
  if (task.kind === 'call' && ['no_answer', 'busy', 'wrong_number'].includes(outcome)) {
    const [l] = await db.select({ id: leads.id, contactSince: leads.contactSince }).from(leads).where(eq(leads.id, task.leadId));
    if (l && (await unansweredCalls(db, l)) >= MAX_CALL_ATTEMPTS) escalated = await escalate(db, task.leadId, 'no_answer', now);
    else if (outcome !== 'wrong_number') await remindToCallAgain(db, task);
  }

  if (task.kind === 'call' && outcome === 'connected') {
    // Not interested: nothing more to send, today or later. Otherwise today's WhatsApp, email and LinkedIn
    // still go out, and the later follow-up rounds stop: the conversation has started.
    const dropped = (NOT_INTERESTED as readonly string[]).includes(feedback);
    await db
      .update(tasks)
      .set({ doneAt: now, outcome: 'closed' })
      .where(and(eq(tasks.leadId, task.leadId), isNull(tasks.doneAt), eq(tasks.priority, false), dropped ? undefined : gt(tasks.dueDate, istDay())));
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
      await planAlongside(db, task.leadId, task.ownerId, callback, 'Promised callback');
      await logActivity(db, task.leadId, 'note', `Callback promised for ${callback}`);
    }
  }
  if (task.kind === 'call' && outcome === 'connected' && feedback === 'Not the right person') escalated = await escalate(db, task.leadId, 'wrong_person', now);
  if (escalated?.switched) after(async () => redraftForContact(await getDb(), await liveServices(), task.leadId));

  // The pipeline follows what was logged: Contacted, a conversation, a meeting, or lost.
  const [current] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, task.leadId));
  const target = current && stageAfterOutreach(current.status, task.kind, outcome, feedback);
  if (target) {
    const from = await moveAfterOutreach(db, task.leadId, target, now);
    if (from) await db.update(tasks).set({ stageFrom: `${from}>${target}` }).where(eq(tasks.id, task.id));
  }
  await markCompanyDay(db, task.leadId, task.ownerId);
  revalidatePath('/today');
  revalidatePath('/team');
  revalidatePath('/pipeline');
  revalidatePath('/leads');
  revalidatePath(`/leads/${task.leadId}`);
}

/**
 * One message per channel catches the person up: logging a WhatsApp, email or call also ticks off the
 * other ones of that kind still open for the company from earlier rounds, so a missed day never leaves
 * a backlog to send twice. This evening's round still comes in the evening.
 */
async function catchUp(db: Awaited<ReturnType<typeof getDb>>, task: typeof tasks.$inferSelect, now: Date) {
  const today = istDay();
  const open = await db
    .select({ id: tasks.id, dueDate: tasks.dueDate, slot: tasks.slot })
    .from(tasks)
    .where(and(eq(tasks.leadId, task.leadId), eq(tasks.kind, task.kind), isNull(tasks.doneAt), eq(tasks.priority, false), lte(tasks.dueDate, today)));
  const laterToday = (t: { dueDate: string; slot: string }) => t.dueDate === today && t.slot === 'evening' && !(task.dueDate === today && task.slot === 'evening');
  const ids = open.filter((t) => t.id !== task.id && !laterToday(t)).map((t) => t.id);
  // Same time as the logged task, so Undo can bring them back together.
  if (ids.length) await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(inArray(tasks.id, ids), isNull(tasks.doneAt)));
}

const RETRY_NOTE = 'auto-retry:';

/**
 * Every day a company is on the list it gets the full set: a callback or a call-again day also
 * gets a WhatsApp and an email, unless that day already has them.
 */
async function planAlongside(db: Awaited<ReturnType<typeof getDb>>, leadId: number, ownerId: number, day: string, step: string) {
  const planned = await db.select({ kind: tasks.kind }).from(tasks).where(and(eq(tasks.leadId, leadId), eq(tasks.dueDate, day), isNull(tasks.doneAt)));
  for (const kind of ['whatsapp', 'email'] as const) {
    if (planned.some((p) => p.kind === kind)) continue;
    await db.insert(tasks).values({ leadId, ownerId, kind, step, title: `${step}: ${kind === 'email' ? 'email' : 'WhatsApp'}`, dueDate: day, slot: 'day' });
  }
}

/** No answer: make sure the person is called again on the next working day, unless a call is already planned by then. */
async function remindToCallAgain(db: Awaited<ReturnType<typeof getDb>>, task: typeof tasks.$inferSelect) {
  const next = nextWorkingDay();
  const calls = await db.select().from(tasks).where(and(eq(tasks.leadId, task.leadId), eq(tasks.kind, 'call')));
  if (calls.some((c) => !c.doneAt && c.dueDate <= next)) return;
  await db.insert(tasks).values({
    leadId: task.leadId,
    ownerId: task.ownerId,
    kind: 'call',
    step: 'Call again',
    title: 'Call again: no answer last time',
    dueDate: next,
    slot: 'day',
    note: `${RETRY_NOTE}${task.id}`,
  });
  await planAlongside(db, task.leadId, task.ownerId, next, 'Call again');
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

/** Admin only: wipes a team member's logged tasks and attendance (testing before go-live). Their sequences are planned again. */
export async function resetTodayLogAction(form: FormData) {
  const user = await requireUser();
  if (user.role !== 'admin') return;
  const id = Number(str(form, 'userId'));
  if (!id) return;
  const db = await getDb();
  // Put back numbers that test clicks marked wrong, before the log that remembers them goes.
  const wrong = await db.select({ leadId: tasks.leadId, note: tasks.note }).from(tasks).where(and(eq(tasks.ownerId, id), eq(tasks.outcome, 'wrong_number')));
  for (const w of wrong) {
    if (w.note.startsWith(WRONG_PREFIX)) {
      await db.update(leads).set({ contactPhone: w.note.slice(WRONG_PREFIX.length) }).where(and(eq(leads.id, w.leadId), eq(leads.contactPhone, '')));
    }
  }
  // Stages that test clicks moved go back, latest first.
  const moved = await db.select().from(tasks).where(and(eq(tasks.ownerId, id), ne(tasks.stageFrom, '')));
  for (const t of moved.sort((x, y) => (y.doneAt?.getTime() ?? 0) - (x.doneAt?.getTime() ?? 0))) {
    const [from, to] = t.stageFrom.split('>') as [LeadStatus, LeadStatus];
    if (t.doneAt) await undoOutreachStage(db, t.leadId, from, to, t.doneAt);
  }
  await db.delete(tasks).where(eq(tasks.ownerId, id));
  await db.delete(attendance).where(eq(attendance.userId, id));
  // The tracker's outcome columns start empty again too.
  await db.update(leads).set({ callFeedback: '', callRemark: '', mailOutcome: '', linkedinOutcome: '' }).where(eq(leads.ownerId, id));
  revalidatePath('/today');
  revalidatePath('/tracker');
}

/**
 * Puts a logged item back on today's list. Works on today's items only. Undoing a connected call
 * also brings back the rest of that lead's sequence and removes the callback it set; undoing a
 * wrong number puts the number back on the lead.
 */
export async function undoTaskAction(form: FormData) {
  const user = await requireUser();
  const id = Number(str(form, 'id'));
  const db = await getDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task?.doneAt || task.ownerId !== user.id || task.outcome === 'closed') return;
  if (istDay(task.doneAt) !== istDay()) return;
  const wasWrong = task.outcome === 'wrong_number' && task.note.startsWith(WRONG_PREFIX);
  await db
    .update(tasks)
    .set({ doneAt: null, outcome: '', note: wasWrong ? '' : task.note })
    .where(eq(tasks.id, id));
  if (wasWrong) {
    const phone = task.note.slice(WRONG_PREFIX.length);
    await db.update(leads).set({ contactPhone: phone }).where(and(eq(leads.id, task.leadId), eq(leads.contactPhone, '')));
  }
  if (task.kind === 'call' && (task.outcome === 'no_answer' || task.outcome === 'busy')) {
    await db.delete(tasks).where(and(eq(tasks.note, `${RETRY_NOTE}${task.id}`), isNull(tasks.doneAt)));
    // and the WhatsApp and email planned alongside it
    await db.delete(tasks).where(and(eq(tasks.leadId, task.leadId), eq(tasks.step, 'Call again'), isNull(tasks.doneAt), gte(tasks.createdAt, task.doneAt)));
  }
  // Whatever was ticked off along with it (the rest of the sequence after a connected call, or earlier rounds caught up) comes back too.
  await db.update(tasks).set({ doneAt: null, outcome: '' }).where(and(eq(tasks.leadId, task.leadId), eq(tasks.outcome, 'closed'), eq(tasks.doneAt, task.doneAt)));
  if (task.kind === 'call' && task.outcome === 'connected') {
    await db.delete(tasks).where(and(eq(tasks.leadId, task.leadId), eq(tasks.priority, true), isNull(tasks.doneAt), gte(tasks.createdAt, task.doneAt)));
    await db.delete(tasks).where(and(eq(tasks.leadId, task.leadId), eq(tasks.step, 'Promised callback'), isNull(tasks.doneAt), gte(tasks.createdAt, task.doneAt)));
  }
  if (task.stageFrom) {
    const [from, to] = task.stageFrom.split('>') as [LeadStatus, LeadStatus];
    await undoOutreachStage(db, task.leadId, from, to, task.doneAt);
    await db.update(tasks).set({ stageFrom: '' }).where(eq(tasks.id, id));
  }
  await markCompanyDay(db, task.leadId, task.ownerId);
  revalidatePath('/pipeline');
  await logActivity(db, task.leadId, 'note', `Undone: ${task.title}${task.step && !task.title.startsWith(task.step) ? ` (${task.step})` : ''}`);
  revalidatePath('/today');
  revalidatePath(`/leads/${task.leadId}`);
}

/** A cell on the tracker sheet: call outcome, mail outcome, LinkedIn outcome or remark. */
export async function updateTrackerFieldAction(id: number, field: TrackerField, value: string): Promise<{ ok: boolean }> {
  if (!['callFeedback', 'contactChannel', 'mailOutcome', 'linkedinOutcome', 'remark', 'callRemark'].includes(field)) return { ok: false };
  const clean = String(value ?? '').trim();
  if (!validTrackerValue(field, clean) || !(await mayActOn(id))) return { ok: false };
  const db = await getDb();
  await db.update(leads).set({ [field]: clean, updatedAt: new Date() }).where(eq(leads.id, id));
  if (field === 'contactChannel') {
    await logActivity(db, id, 'note', clean ? `Point of contact: ${clean}` : 'Point of contact back to automatic (from what was logged)');
  } else if (field !== 'remark' && field !== 'callRemark' && clean) {
    const label = field === 'callFeedback' ? 'Call outcome' : field === 'mailOutcome' ? 'Mail outcome' : 'LinkedIn outcome';
    await logActivity(db, id, 'note', `${label}: ${clean}`);
  }
  revalidatePath('/tracker');
  revalidatePath(`/leads/${id}`);
  return { ok: true };
}

/** Corrects the point of contact from Today: name, designation, number, email, LinkedIn. */
export async function updateContactAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!(await mayActOn(id))) return;
  const v = {
    contactName: str(form, 'contactName').slice(0, 200),
    contactTitle: str(form, 'contactTitle').slice(0, 200),
    contactPhone: str(form, 'contactPhone').slice(0, 40),
    contactEmail: str(form, 'contactEmail').slice(0, 200).toLowerCase(),
    contactLinkedin: str(form, 'contactLinkedin').slice(0, 300),
  };
  if (v.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail)) return;
  const db = await getDb();
  const [before] = await db.select().from(leads).where(eq(leads.id, id));
  if (!before) return;
  // A different person: the previous person's number, email and LinkedIn don't carry over unless retyped.
  if (before.contactName && v.contactName.toLowerCase() !== before.contactName.toLowerCase()) {
    for (const k of ['contactPhone', 'contactEmail', 'contactLinkedin'] as const) if (v[k] === before[k]) v[k] = '';
  }
  const emailChanged = v.contactEmail !== before.contactEmail;
  const newPerson = v.contactName.toLowerCase() !== before.contactName.toLowerCase();
  await db
    .update(leads)
    // The team vouches for a contact they enter: it counts as confirmed.
    .set({ ...v, contactVerifiedAt: v.contactName ? new Date() : null, ...(newPerson ? { contactTier: '', contactCheckedAt: null } : {}), ...(emailChanged ? { emailStatus: v.contactEmail ? 'entered by the team' : '' } : {}), updatedAt: new Date() })
    .where(eq(leads.id, id));
  // Keep the people list in step: update the main contact, or add them if they're new.
  const [primary] = await db.select().from(people).where(and(eq(people.leadId, id), eq(people.isPrimary, true)));
  const person = { name: v.contactName, title: v.contactTitle, phone: v.contactPhone, email: v.contactEmail, linkedin: v.contactLinkedin };
  if (primary && primary.name.toLowerCase() === v.contactName.toLowerCase()) {
    await db.update(people).set({ ...person, ...(emailChanged ? { emailStatus: v.contactEmail ? 'entered by the team' : '' } : {}) }).where(eq(people.id, primary.id));
  } else if (v.contactName) {
    await db.update(people).set({ isPrimary: false }).where(eq(people.leadId, id));
    await db.insert(people).values({ ...person, leadId: id, emailStatus: v.contactEmail ? 'entered by the team' : '', source: 'Sales team', isPrimary: true });
  }
  // Someone new: their own count of unanswered calls, a fresh plan if the lead was waiting for them, and an email written to them.
  if (newPerson && v.contactName) {
    await newContactNamed(db, id);
    after(async () => redraftForContact(await getDb(), await liveServices(), id));
  }
  const changed = (['contactName', 'contactTitle', 'contactPhone', 'contactEmail', 'contactLinkedin'] as const).filter((k) => v[k] !== before[k]);
  if (changed.length) {
    const label = { contactName: 'name', contactTitle: 'designation', contactPhone: 'number', contactEmail: 'email', contactLinkedin: 'LinkedIn' };
    await logActivity(db, id, 'contact', `Point of contact updated (${changed.map((k) => label[k]).join(', ')}): ${[v.contactName, v.contactTitle, v.contactPhone, v.contactEmail].filter(Boolean).join(' · ')}`);
  }
  // A new email address means the email steps can run: plan them if the sequence had none.
  if (emailChanged && v.contactEmail && !before.contactEmail) {
    const open = await db.select().from(tasks).where(and(eq(tasks.leadId, id), isNull(tasks.doneAt)));
    if (open.length && !open.some((t) => t.kind === 'email')) {
      const calls = open.filter((t) => t.kind === 'call' && !t.priority);
      for (const c of calls) {
        await db.insert(tasks).values({ leadId: id, ownerId: c.ownerId, kind: 'email', step: c.step, title: `${c.step}: email`, dueDate: c.dueDate, slot: c.slot });
      }
    }
  }
  revalidatePath('/today');
  revalidatePath('/tracker');
  revalidatePath(`/leads/${id}`);
}

/** Runs today's morning draw straight away (administrators), or tops up a short one from companies added since. */
export async function drawNowAction() {
  const user = await requireUser();
  if (user.role !== 'admin') return;
  const db = await getDb();
  if (!(await runDailyDraw(db, { force: true }))) await topUpDraw(db);
  for (const p of ['/team', '/today', '/tracker', '/leads']) revalidatePath(p);
}

const QUICK_FIELDS = { contactPhone: 'number', contactEmail: 'email', contactLinkedin: 'LinkedIn' } as const;

/** Saves a number, email or LinkedIn link the team member found themselves, straight from a Today row. */
export async function saveFoundDetailAction(form: FormData) {
  const id = Number(str(form, 'id'));
  const field = str(form, 'field') as keyof typeof QUICK_FIELDS;
  if (!(field in QUICK_FIELDS) || !(await mayActOn(id))) return;
  let value = str(form, 'value').slice(0, field === 'contactLinkedin' ? 300 : 200);
  if (field === 'contactEmail') {
    value = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return;
  }
  if (field === 'contactPhone' && value.replace(/\D/g, '').length < 6) return;
  if (field === 'contactLinkedin' && !/^https?:\/\//i.test(value)) value = `https://${value}`;
  if (!value) return;
  const db = await getDb();
  const extra = field === 'contactEmail' ? { emailStatus: 'entered by the team' } : {};
  await db.update(leads).set({ [field]: value, ...extra, updatedAt: new Date() }).where(eq(leads.id, id));
  const personField = { contactPhone: 'phone', contactEmail: 'email', contactLinkedin: 'linkedin' } as const;
  await db.update(people).set({ [personField[field]]: value, ...extra }).where(and(eq(people.leadId, id), eq(people.isPrimary, true)));
  await logActivity(db, id, 'contact', `Point of contact's ${QUICK_FIELDS[field]} added by the team: ${value}`);
  revalidatePath('/today');
  revalidatePath('/tracker');
  revalidatePath(`/leads/${id}`);
}
