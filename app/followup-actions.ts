'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, tasks, type LeadStatus } from '@/lib/db/schema';
import { mayActOn } from '@/lib/access';
import { logActivity } from '@/lib/activity';
import { applyStage } from '@/lib/stages';
import { followUpAgainPlan } from '@/lib/followups';
import { requireUser } from '@/lib/users';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function refresh(id: number) {
  revalidatePath('/followups');
  revalidatePath('/today');
  revalidatePath('/pipeline');
  revalidatePath('/tracker');
  revalidatePath('/leads');
  revalidatePath(`/leads/${id}`);
}

/**
 * Another round for a lead nobody has replied to yet: a call, a WhatsApp and an email on its owner's
 * Today (today, or the next working day). Never twice: nothing is added while steps are still open.
 */
export async function followUpAgainAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!(await mayActOn(id))) return;
  const user = await requireUser();
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead?.ownerId) return;
  const open = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.leadId, id), isNull(tasks.doneAt))).limit(1);
  if (open.length) return;
  await db.insert(tasks).values(followUpAgainPlan().map((t) => ({ ...t, leadId: id, ownerId: lead.ownerId! })));
  await logActivity(db, id, 'note', `Another follow-up round planned by ${user.name}: call, WhatsApp and email`);
  refresh(id);
}

/** Moves a lead on from the funnel: they replied, a meeting is booked, they became a client, or it is lost. */
const FUNNEL_MOVES: LeadStatus[] = ['Replied', 'Meeting Booked', 'Won', 'Lost'];

export async function moveFromFunnelAction(form: FormData) {
  const id = Number(str(form, 'id'));
  const stage = str(form, 'stage') as LeadStatus;
  if (!FUNNEL_MOVES.includes(stage) || !(await mayActOn(id))) return;
  const db = await getDb();
  await applyStage(db, [id], stage);
  refresh(id);
  if (stage === 'Won') revalidatePath('/targets');
}
