'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import type { LeadStatus } from '@/lib/db/schema';
import { mayActOn } from '@/lib/access';
import { applyStage } from '@/lib/stages';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function refresh(id: number) {
  revalidatePath('/followups');
  revalidatePath('/today');
  revalidatePath('/pipeline');
  revalidatePath('/tracker');
  revalidatePath('/leads');
  revalidatePath(`/leads/${id}`);
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
