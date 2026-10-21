'use server';

import { getDb } from '@/lib/db';
import { mayActOn } from '@/lib/access';
import { saveLinkedinActivity } from '@/lib/linkedin-activity';
import { requireUser } from '@/lib/users';

/** Saves one contact's LinkedIn status and remarks from Today. Only the company's owner (or an administrator) can. */
export async function saveLinkedinActivityAction(leadId: number, personId: number, status: string, remarks: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!(await mayActOn(Number(leadId)))) return { ok: false, error: 'Only the person this company belongs to can update it.' };
  const r = await saveLinkedinActivity(await getDb(), { leadId: Number(leadId), personId: Number(personId), status, remarks, userId: user.id });
  return r.ok ? { ok: true } : r;
}
