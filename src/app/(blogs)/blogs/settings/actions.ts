'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { audit } from '@/lib/blogs/audit';
import { blogActor } from '@/lib/blogs/auth';
import { putSetting, queueConfigSchema, scoringWeightsSchema } from '@/lib/blogs/settings';
import { isValidTimeZone } from '@/lib/blogs/time';

function back(path: string, key: 'saved' | 'error', message: string): never {
  redirect(`${path}?${key}=${encodeURIComponent(message)}`);
}

export async function saveQueueConfig(formData: FormData) {
  const admin = await blogActor();
  const num = (k: string) => Number(formData.get(k));
  const parsed = queueConfigSchema.safeParse({
    timezone: String(formData.get('timezone') ?? ''),
    targetPerDay: num('targetPerDay'),
    maxPerDay: num('maxPerDay'),
    windows: [{ start: String(formData.get('windowStart') ?? ''), end: String(formData.get('windowEnd') ?? '') }],
    minIntervalMinutes: num('minIntervalMinutes'),
    maxConcurrentJobs: num('maxConcurrentJobs'),
    autoSlotApproved: formData.get('autoSlotApproved') === 'on',
  });
  if (!parsed.success) back('/blogs/queue', 'error', 'Check the queue values and try again.');
  const q = parsed.data;
  if (!isValidTimeZone(q.timezone)) back('/blogs/queue', 'error', `"${q.timezone}" is not a valid timezone (use e.g. Asia/Kolkata).`);
  if (q.targetPerDay > q.maxPerDay) back('/blogs/queue', 'error', 'The target per day cannot exceed the hard daily limit.');
  if (q.windows[0].start >= q.windows[0].end) back('/blogs/queue', 'error', 'The publishing window must close after it opens.');
  await putSetting('queue', q);
  await audit(admin.email, 'settings.queue_updated', 'settings', 'queue', q);
  revalidatePath('/', 'layout');
  back('/blogs/queue', 'saved', 'Queue rules saved.');
}

export async function saveScoringWeights(formData: FormData) {
  const admin = await blogActor();
  const n = (k: string) => Number(formData.get(k));
  const parsed = scoringWeightsSchema.safeParse({
    trendMomentum: n('trendMomentum'),
    searchDemand: n('searchDemand'),
    competitionGap: n('competitionGap'),
    relevance: n('relevance'),
    engagementPotential: n('engagementPotential'),
  });
  if (!parsed.success) back('/blogs/settings', 'error', 'Weights must be numbers between 0 and 100 that add up to 100.');
  await putSetting('scoringWeights', parsed.data);
  await audit(admin.email, 'settings.scoring_weights_updated', 'settings', 'scoringWeights', parsed.data);
  revalidatePath('/blogs/settings');
  back('/blogs/settings', 'saved', 'Scoring weights saved.');
}

/** Saves the author list. Rows with an empty name are dropped; at least one author must remain. */
export async function saveAuthorsAction(formData: FormData) {
  const admin = await blogActor();
  const { authorSchema, saveAuthors } = await import('@/lib/blogs/authors');
  const { getDb } = await import('@/lib/blogs/db/client');
  const ids = formData.getAll('id').map(String);
  const rows = ids.map((id, i) => ({
    id: id || String(formData.getAll('name')[i] ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: String(formData.getAll('name')[i] ?? ''),
    designation: String(formData.getAll('designation')[i] ?? ''),
    linkedin: String(formData.getAll('linkedin')[i] ?? ''),
    wpUserId: String(formData.getAll('wpUserId')[i] ?? '').trim() || null,
    remove: formData.getAll('remove').map(String).includes(String(i)),
  })).filter((r) => r.name.trim() && !r.remove);
  const parsed = rows.map((r) => authorSchema.safeParse(r));
  const bad = parsed.findIndex((p) => !p.success);
  if (bad >= 0) back('/blogs/settings', 'error', `Author "${rows[bad].name}": ${parsed[bad].error!.issues[0].message}`);
  if (!rows.length) back('/blogs/settings', 'error', 'Keep at least one author.');
  const authors = parsed.map((p) => p.data!);
  await saveAuthors((await getDb()), authors);
  await audit(admin.email, 'settings.authors_updated', 'settings', 'authors', { authors: authors.map((a) => a.name) });
  revalidatePath('/blogs/settings');
  back('/blogs/settings', 'saved', `Saved ${authors.length} author${authors.length === 1 ? '' : 's'}.`);
}
