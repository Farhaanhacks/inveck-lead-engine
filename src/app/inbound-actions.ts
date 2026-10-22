'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/access';
import { syncInboundDemos } from '@/lib/inbound-demo';
import { logInboundActivity, setInboundStatus } from '@/lib/inbound-leads';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export type SyncSummary = { ok: boolean; message: string; lines: string[] };

/** 🔄 Sync now: reads the inbound demo sheet (read-only) and reports what it did. Administrators only. */
export async function syncNowAction(): Promise<SyncSummary> {
  await requireAdmin();
  try {
    const r = await syncInboundDemos(await getDb());
    revalidatePath('/inbound');
    revalidatePath('/settings');
    if (r.error) return { ok: false, message: r.error, lines: [] };
    const lines = [
      `${r.read} rows read from the sheet`,
      `${r.created} new inbound lead${r.created === 1 ? '' : 's'}`,
      `${r.meetings} Teams meeting${r.meetings === 1 ? '' : 's'} booked`,
      ...(r.merged ? [`${r.merged} repeat submission${r.merged === 1 ? '' : 's'} added to existing leads`] : []),
      ...(r.skipped.length ? [`${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} not imported (test, formula or no email)`] : []),
      ...r.noMeeting.map((n) => `No meeting for ${n.who}: ${n.reason}`),
      ...r.blocked.map((b) => `Waiting, ${b.who}: ${b.reason}`),
    ];
    return { ok: true, message: `Synced ${new Date(r.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })} IST`, lines };
  } catch (e) {
    return { ok: false, message: `The sync failed: ${e instanceof Error ? e.message : 'unknown error'}`, lines: [] };
  }
}

export async function setInboundStatusAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  if (!Number.isInteger(id)) return;
  await setInboundStatus(await getDb(), id, str(form, 'status'), user.name);
  revalidatePath('/inbound');
  revalidatePath(`/inbound/${id}`);
}

export async function logInboundActivityAction(form: FormData) {
  const user = await requireAdmin();
  const id = Number(str(form, 'id'));
  if (!Number.isInteger(id)) return;
  await logInboundActivity(await getDb(), id, str(form, 'kind'), str(form, 'text'), user.name);
  revalidatePath('/inbound');
  revalidatePath(`/inbound/${id}`);
}
