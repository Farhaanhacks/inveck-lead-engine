'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, tasks } from '@/lib/db/schema';
import { scheduleMeeting } from '@/lib/meetings';
import { requireUser } from '@/lib/users';
import { completeTaskAction } from './team-actions';

export type ScheduleMeetingState = { error: string; done?: boolean };

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/**
 * "Approve and Schedule": creates the Teams meeting in the owner's calendar and, only once it exists with its Teams
 * link, logs the connected call as Demo scheduled (which moves the lead to Meeting Booked). The call form's own
 * fields (what was discussed, the date of a callback...) come with the meeting's, so the call is logged exactly as
 * Save call would log it. Retrying after any failure is safe: a meeting already made is not made twice.
 */
export async function scheduleMeetingAction(form: FormData): Promise<ScheduleMeetingState> {
  const user = await requireUser();
  const db = await getDb();
  const id = Number(str(form, 'id'));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task || task.kind !== 'call') return { error: 'This call step no longer exists. Refresh the page.' };
  if (task.doneAt) return { error: 'This call was already logged. Refresh the page.' };
  if (task.ownerId !== user.id) return { error: 'Only the person this company belongs to can schedule its meeting.' };
  if (!str(form, 'note')) return { error: 'Write what was discussed first.' };
  const [lead] = await db.select().from(leads).where(eq(leads.id, task.leadId));
  if (!lead) return { error: 'This company no longer exists.' };

  const r = await scheduleMeeting(db, {
    lead,
    taskId: task.id,
    userId: user.id,
    title: str(form, 'meetingTitle'),
    date: str(form, 'meetingDate'),
    time: str(form, 'meetingTime'),
    minutes: Number(str(form, 'meetingMinutes')),
  });
  if (!r.ok) return { error: r.error };

  const call = new FormData();
  for (const [k, v] of form.entries()) if (!k.startsWith('meeting')) call.append(k, v);
  call.set('outcome', 'connected');
  call.set('feedback', 'Demo scheduled');
  await completeTaskAction(call);
  const [after] = await db.select({ doneAt: tasks.doneAt }).from(tasks).where(eq(tasks.id, id));
  revalidatePath('/today');
  revalidatePath(`/leads/${lead.id}`);
  if (!after?.doneAt) return { error: 'The meeting was scheduled, but the call could not be logged. Refresh the page and save the call again: the meeting will not be made twice.' };
  return { error: '', done: true };
}
