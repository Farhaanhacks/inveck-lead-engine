'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { audit } from '@/lib/blogs/audit';
import { blogActor } from '@/lib/blogs/auth';
import { getDb } from '@/lib/blogs/db/client';
import { domainProfiles, topicRuns } from '@/lib/blogs/db/schema';
import { runConfigSchema } from '@/lib/blogs/discovery/engine';
import { missingDiscoveryKeys, runDiscovery } from '@/lib/blogs/discovery/live';
import { retryRun } from '@/lib/blogs/discovery/run';
import { eq } from 'drizzle-orm';
import { INVECK_SLUG, profileIsReady } from '@/lib/blogs/seed';

function go(kind: 'saved' | 'error', message: string): never {
  redirect(`/blogs/topics?${kind}=${encodeURIComponent(message)}`);
}

export async function startDiscovery(formData: FormData) {
  const admin = await blogActor();
  const missing = missingDiscoveryKeys();
  if (missing.length) go('error', `Cannot run discovery: ${missing.join(' and ')} not configured.`);

  const parsed = runConfigSchema.safeParse({
    domainSlugs: [INVECK_SLUG],
    geography: String(formData.get('geography') ?? 'Global'),
    focus: String(formData.get('focus') ?? ''),
    windowDays: Number(formData.get('windowDays') ?? 7),
    count: Number(formData.get('count') ?? 5),
  });
  if (!parsed.success) go('error', 'Check the fields and try again.');
  const cfg = parsed.data;

  // One profile: Inveck. Nothing is researched until it says who the articles are for and in what tone.
  const [profile] = await (await getDb()).select().from(domainProfiles).where(eq(domainProfiles.slug, INVECK_SLUG));
  if (!profile || !profileIsReady(profile)) go('error', 'Set up the Inveck profile first (audience and tone) under Settings & Prompts.');
  const chosen = [profile];

  const [run] = await (await getDb())
    .insert(topicRuns)
    .values({ status: 'queued', domainIds: chosen.map((d) => d.id), config: cfg, requestedBy: admin.id })
    .returning({ id: topicRuns.id });
  await audit(admin.email, 'discovery.started', 'topic_run', run.id, cfg);

  // Starts right away, after the response is sent. If this process dies, /api/cron/discovery re-claims the run once its lease expires.
  after(() => runDiscovery(run.id));
  revalidatePath('/blogs/topics');
  go('saved', 'Discovery queued. Its progress shows below and updates by itself.');
}

export async function retryDiscovery(runId: string) {
  const admin = await blogActor();
  if (missingDiscoveryKeys().length) go('error', 'Provider keys are not configured.');
  const ok = await retryRun((await getDb()), runId);
  if (!ok) go('error', 'Only a failed run can be retried.');
  await audit(admin.email, 'discovery.retried', 'topic_run', runId);
  after(() => runDiscovery(runId));
  revalidatePath('/blogs/topics');
  go('saved', 'Run queued again. Its progress shows below.');
}
