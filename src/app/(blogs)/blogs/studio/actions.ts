'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { blogActor } from '@/lib/blogs/auth';
import { getDb } from '@/lib/blogs/db/client';
import { cancelJob, releaseReview, retryImage, retryJob } from '@/lib/blogs/pipeline/job';
import { missingPipelineKeys, runJobLive } from '@/lib/blogs/pipeline/live';

function go(path: string, kind: 'saved' | 'error', message: string): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}
const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function cancel(jobId: string) {
  const admin = await blogActor();
  if (!idOk(jobId)) go('/blogs/studio', 'error', 'Unknown job.');
  const r = await cancelJob((await getDb()), jobId, { id: admin.id, email: admin.email });
  revalidatePath('/blogs/studio');
  go('/blogs/studio', r.ok ? 'saved' : 'error', r.ok ? 'Cancelled. A step that is already running stops at its next checkpoint.' : r.reason ?? 'Could not cancel.');
}

export async function retry(jobId: string) {
  const admin = await blogActor();
  if (!idOk(jobId)) go('/blogs/studio', 'error', 'Unknown job.');
  const r = await retryJob((await getDb()), jobId, { id: admin.id, email: admin.email });
  revalidatePath('/blogs/studio');
  if (!r.ok) go('/blogs/studio', 'error', r.reason ?? 'Could not retry.');
  if (!missingPipelineKeys().length) after(() => runJobLive(jobId));
  go('/blogs/studio', 'saved', 'Queued again. It resumes from the step that stopped; its state shows below.');
}

export async function release(articleId: string, formData: FormData) {
  const admin = await blogActor();
  if (!idOk(articleId)) go('/blogs/studio', 'error', 'Unknown article.');
  const comment = String(formData.get('comment') ?? '').trim();
  if (comment.length < 5) go(`/blogs/studio/${articleId}`, 'error', 'Add a short note explaining your review (at least 5 characters).');
  const r = await releaseReview((await getDb()), articleId, { id: admin.id, email: admin.email }, comment);
  revalidatePath('/blogs/studio');
  if (!r.ok) go(`/blogs/studio/${articleId}`, 'error', r.reason ?? 'Could not release.');
  const db = await getDb();
  const { eq } = await import('drizzle-orm');
  const { contentJobs } = await import('@/lib/blogs/db/schema');
  const [job] = await db.select({ id: contentJobs.id }).from(contentJobs).where(eq(contentJobs.articleId, articleId));
  if (job && !missingPipelineKeys().length) after(() => runJobLive(job.id));
  go(`/blogs/studio/${articleId}`, 'saved', 'Released. The image step is starting; its state shows below.');
}

/** Runs a waiting job right now instead of waiting for the scheduler's next tick. */
export async function runNow(jobId: string) {
  await blogActor();
  if (!idOk(jobId)) go('/blogs/studio', 'error', 'Unknown job.');
  if (missingPipelineKeys().length) go('/blogs/studio', 'error', 'Provider keys are not configured.');
  after(() => runJobLive(jobId, { force: true }));
  revalidatePath('/blogs/studio');
  go('/blogs/studio', 'saved', 'Starting now. Its state below updates by itself.');
}

/** Re-runs the quality checks on the saved draft. No rewrite, so the writing model is not called. */
export async function recheck(jobId: string) {
  const admin = await blogActor();
  if (!idOk(jobId)) go('/blogs/studio', 'error', 'Unknown job.');
  const r = await retryJob((await getDb()), jobId, { id: admin.id, email: admin.email }, 'recheck');
  revalidatePath('/blogs/studio');
  if (!r.ok) go('/blogs/studio', 'error', r.reason ?? 'Could not re-check.');
  if (!missingPipelineKeys().length) after(() => runJobLive(jobId));
  go('/blogs/studio', 'saved', 'Re-check queued for the saved draft (no rewrite). Its state shows below.');
}

export async function retryImageAction(articleId: string) {
  const admin = await blogActor();
  if (!idOk(articleId)) go('/blogs/studio', 'error', 'Unknown article.');
  const r = await retryImage((await getDb()), articleId, { id: admin.id, email: admin.email });
  revalidatePath(`/blogs/studio/${articleId}`);
  if (!r.ok) go(`/blogs/studio/${articleId}`, 'error', r.reason ?? 'Could not retry the image.');
  const db = await getDb();
  const { eq } = await import('drizzle-orm');
  const { contentJobs } = await import('@/lib/blogs/db/schema');
  const [job] = await db.select({ id: contentJobs.id }).from(contentJobs).where(eq(contentJobs.articleId, articleId));
  if (job && !missingPipelineKeys().length) after(() => runJobLive(job.id));
  go(`/blogs/studio/${articleId}`, 'saved', 'Image queued again. Its state shows below.');
}

/** Changes the article's author. Published posts keep the author they went out with until they are published again. */
export async function setAuthor(articleId: string, formData: FormData) {
  const admin = await blogActor();
  if (!idOk(articleId)) go('/blogs/studio', 'error', 'Unknown article.');
  const db = await getDb();
  const { eq } = await import('drizzle-orm');
  const { articles } = await import('@/lib/blogs/db/schema');
  const { loadAuthors } = await import('@/lib/blogs/authors');
  const { audit } = await import('@/lib/blogs/audit');
  const author = (await loadAuthors(db)).find((a) => a.id === String(formData.get('authorId') ?? ''));
  if (!author) go(`/blogs/studio/${articleId}`, 'error', 'Choose one of the listed authors.');
  const [a] = await db.select({ metadata: articles.metadata }).from(articles).where(eq(articles.id, articleId));
  if (!a) go('/blogs/studio', 'error', 'Unknown article.');
  await db.update(articles).set({ metadata: { ...(a!.metadata as object), author }, updatedAt: new Date() }).where(eq(articles.id, articleId));
  await audit(admin.email, 'article.author_changed', 'article', articleId, { author: author!.name });
  revalidatePath(`/blogs/studio/${articleId}`);
  go(`/blogs/studio/${articleId}`, 'saved', `Author set to ${author!.name}.`);
}
