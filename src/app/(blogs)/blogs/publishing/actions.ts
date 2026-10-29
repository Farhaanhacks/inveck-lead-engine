'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { blogActor } from '@/lib/blogs/auth';
import { getCmsAdapter } from '@/lib/blogs/cms';
import { getDb } from '@/lib/blogs/db/client';
import { cancelPost, reschedulePost, schedulePublication, type ScheduleRequest } from '@/lib/blogs/publishing/schedule';
import { loadQueueSettings, runPublishTick } from '@/lib/blogs/publishing/live';
import { retryPost } from '@/lib/blogs/publishing/worker';
import { putSetting } from '@/lib/blogs/settings';
import { formatInZone, zonedTimeToUtc } from '@/lib/blogs/time';

function go(path: string, kind: 'saved' | 'error', message: string): never {
  // returnTo may already carry a query (the calendar's view and date), so append rather than start a new one.
  const base = path.replace(/([?&])(saved|error)=[^&]*/g, '').replace(/[?&]$/, '');
  redirect(`${base}${base.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(message)}`);
}
const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/** "2026-10-20T09:30" typed in the dashboard's timezone, as a UTC instant. */
function parseLocal(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  return zonedTimeToUtc(timeZone, y, mo, d, h, mi);
}

export async function schedule(articleId: string, formData: FormData) {
  const admin = await blogActor();
  const back = `/blogs/studio/${articleId}`;
  if (!idOk(articleId)) go('/blogs/studio', 'error', 'Unknown article.');
  const q = await loadQueueSettings();
  const mode = String(formData.get('mode'));
  const priority = Number(formData.get('priority') ?? 0) || 0;
  let req: ScheduleRequest;
  if (mode === 'immediate') req = { mode, priority };
  else if (mode === 'queue') req = { mode, priority };
  else if (mode === 'scheduled') {
    const at = parseLocal(String(formData.get('at') ?? ''), q.timezone);
    if (!at) go(back, 'error', 'Pick a date and time.');
    req = { mode, at: at!, priority };
  } else go(back, 'error', 'Choose a publishing mode.');
  const adapter = getCmsAdapter();
  const r = await schedulePublication((await getDb()), adapter, articleId, req!, q, { id: admin.id, email: admin.email });
  revalidatePath('/', 'layout');
  if (!r.ok) go(back, 'error', r.reason);
  const mock = adapter.isMock ? ' Mock mode: it will be simulated, not published.' : '';
  go(back, 'saved', mode === 'immediate' ? `Queued to publish now. It goes out on the next worker run.${mock}` : `Scheduled for ${formatInZone(r.scheduledFor, q.timezone)}.${mock}`);
}

export async function reschedule(postId: string, returnTo: string, formData: FormData) {
  const admin = await blogActor();
  if (!idOk(postId)) go(returnTo, 'error', 'Unknown post.');
  const q = await loadQueueSettings();
  const next = String(formData.get('mode')) === 'queue' ? ({ slot: true } as const) : (() => { const at = parseLocal(String(formData.get('at') ?? ''), q.timezone); return at ? { at } : null; })();
  if (!next) go(returnTo, 'error', 'Pick a date and time.');
  const r = await reschedulePost((await getDb()), postId, next!, q, { id: admin.id, email: admin.email });
  revalidatePath('/', 'layout');
  if (!r.ok) go(returnTo, 'error', r.reason);
  go(returnTo, 'saved', `Rescheduled to ${formatInZone(r.scheduledFor, q.timezone)}.`);
}

export async function cancelSchedule(postId: string, returnTo: string) {
  const admin = await blogActor();
  if (!idOk(postId)) go(returnTo, 'error', 'Unknown post.');
  const r = await cancelPost((await getDb()), postId, { id: admin.id, email: admin.email });
  revalidatePath('/', 'layout');
  go(returnTo, r.ok ? 'saved' : 'error', r.ok ? 'Cancelled. The article is ready to schedule again.' : r.reason ?? 'Could not cancel.');
}

export async function retryPublish(postId: string, returnTo: string) {
  await blogActor();
  if (!idOk(postId)) go(returnTo, 'error', 'Unknown post.');
  const r = await retryPost((await getDb()), postId);
  revalidatePath('/', 'layout');
  go(returnTo, r.ok ? 'saved' : 'error', r.ok ? 'Queued to retry. It publishes on the next worker run.' : r.reason ?? 'Could not retry.');
}

/** Runs the publish worker once, right now (the same code the scheduler calls). */
export async function runPublishNow(returnTo: string) {
  await blogActor();
  const results = await runPublishTick();
  revalidatePath('/', 'layout');
  const done = results.filter((r) => r.result === 'published').length;
  const failed = results.filter((r) => r.result === 'failed').length;
  const delayed = results.filter((r) => r.result === 'delayed' || r.result === 'retry').length;
  const verb = getCmsAdapter().isMock ? 'simulated (mock)' : 'published';
  go(returnTo, failed ? 'error' : 'saved', results.length ? `Checked ${results.length} due post(s): ${done} ${verb}${delayed ? `, ${delayed} delayed or retrying` : ''}${failed ? `, ${failed} failed` : ''}. Details are in the list.` : 'Nothing is due right now.');
}

export async function testCmsConnection() {
  await blogActor();
  const status = await getCmsAdapter().testConnection();
  await putSetting('cmsStatus', status);
  revalidatePath('/blogs/settings');
  go('/blogs/settings', status.state === 'connected' || status.state === 'mock' ? 'saved' : 'error', `CMS: ${status.state.replace('_', ' ')}. ${status.detail}`);
}
