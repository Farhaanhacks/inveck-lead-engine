'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { blogActor } from '@/lib/blogs/auth';
import { approveTopic, editTopic, rejectTopic, topicEditSchema } from '@/lib/blogs/approvals';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/blogs/db/client';
import { domainProfiles } from '@/lib/blogs/db/schema';
import { INVECK_SLUG, profileIsReady } from '@/lib/blogs/seed';
import { missingPipelineKeys, runJobLive } from '@/lib/blogs/pipeline/live';

function go(kind: 'saved' | 'error', message: string, jobId?: string | null): never {
  redirect(`/blogs/approvals?${kind}=${encodeURIComponent(message)}${jobId ? `&job=${jobId}` : ''}`);
}
const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function approve(topicId: string, formData: FormData) {
  const admin = await blogActor();
  if (!idOk(topicId)) go('error', 'Unknown topic.');
  const comment = String(formData.get('comment') ?? '').trim() || undefined;
  // An article is only written once the Inveck profile says who it is for and in what voice.
  const [profile] = await (await getDb()).select().from(domainProfiles).where(eq(domainProfiles.slug, INVECK_SLUG));
  if (!profile || !profileIsReady(profile)) go('error', 'Set up the Inveck profile first (audience and tone) under Inveck Profile & Prompts. Nothing is written until then.');
  const r = await approveTopic((await getDb()), topicId, { id: admin.id, email: admin.email }, comment);
  revalidatePath('/blogs/approvals');
  // The job is already saved as queued; starting it now is a convenience. The cron tick would pick it up anyway.
  if (r.ok && !r.alreadyApproved && !missingPipelineKeys().length) after(() => runJobLive(r.jobId));
  if (!r.ok) go('error', r.reason === 'not_found' ? 'That topic no longer exists.' : `That topic is already ${r.status}.`);
  // Only reached after the approval and its job are committed in one transaction.
  go('saved', r.alreadyApproved ? 'Already approved. Its article job is unchanged.' : 'Approved. The article job is queued and starting now.', r.jobId);
}

export async function reject(topicId: string, formData: FormData) {
  const admin = await blogActor();
  if (!idOk(topicId)) go('error', 'Unknown topic.');
  const comment = String(formData.get('comment') ?? '').trim() || undefined;
  const r = await rejectTopic((await getDb()), topicId, { id: admin.id, email: admin.email }, comment);
  revalidatePath('/blogs/approvals');
  if (!r.ok) go('error', r.reason ?? 'Could not reject that topic.');
  go('saved', 'Rejected. No article will be written for it.');
}

export async function edit(topicId: string, formData: FormData) {
  const admin = await blogActor();
  if (!idOk(topicId)) go('error', 'Unknown topic.');
  const lines = String(formData.get('secondaryKeywords') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const parsed = topicEditSchema.safeParse({
    headline: formData.get('headline'),
    summary: formData.get('summary'),
    category: formData.get('category'),
    primaryKeyword: formData.get('primaryKeyword'),
    secondaryKeywords: lines,
    searchIntent: formData.get('searchIntent'),
    articleFormat: formData.get('articleFormat'),
    targetAudience: formData.get('targetAudience'),
  });
  if (!parsed.success) redirect(`/blogs/approvals/${topicId}/edit?error=${encodeURIComponent('Some values are missing or too long or short. Check the fields.')}`);
  const r = await editTopic((await getDb()), topicId, parsed.data, { id: admin.id, email: admin.email });
  revalidatePath('/blogs/approvals');
  if (!r.ok) redirect(`/blogs/approvals/${topicId}/edit?error=${encodeURIComponent(r.reason ?? 'Could not save.')}`);
  go('saved', 'Changes saved. The topic is still awaiting approval.');
}
