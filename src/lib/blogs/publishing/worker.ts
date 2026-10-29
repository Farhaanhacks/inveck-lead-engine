import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { authorBoxHtml, loadAuthors, pickAuthor, resolveAuthor } from '../authors';
import { CmsError, type CmsAdapter } from '../cms/types';
import { articleAssets, articles, auditLogs, imageStore, publishedPosts, topicCandidates } from '../db/schema';
import { IMAGE_URL_PREFIX } from '../image-url';
import type { AnyDb } from '../db/types';
import { addDays, startOfDay } from '../time';
import { dayIsFull, findSlot } from './slots';
import { takenTimes, type QueueSettings } from './schedule';

export const PUBLISH_LEASE_MINUTES = 10;
export const publishBackoffMs = (attempts: number) => Math.min(60 * 60_000, 60_000 * 3 ** Math.max(0, attempts - 1));

type PostRow = typeof publishedPosts.$inferSelect;
export type PublishOutcome = { postId: string; result: 'published' | 'retry' | 'failed' | 'delayed' | 'rescheduled' | 'skipped'; detail?: string };

/** Takes a due post. Exactly one worker wins; a crashed worker's claim expires after the lease. */
async function claim(db: AnyDb, id: string, now: Date): Promise<PostRow | null> {
  const lease = new Date(now.getTime() + PUBLISH_LEASE_MINUTES * 60_000);
  const [row] = await db
    .update(publishedPosts)
    .set({ status: 'publishing', nextAttemptAt: lease, updatedAt: now })
    .where(
      and(
        eq(publishedPosts.id, id),
        or(
          and(inArray(publishedPosts.status, ['scheduled', 'delayed']), lt(publishedPosts.scheduledFor, new Date(now.getTime() + 1)), or(sql`${publishedPosts.nextAttemptAt} is null`, lt(publishedPosts.nextAttemptAt, new Date(now.getTime() + 1)))),
          and(eq(publishedPosts.status, 'publishing'), lt(publishedPosts.nextAttemptAt, now)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export type ImageFetcher = (url: string) => Promise<{ bytes: Buffer; mimeType: string }>;

/** Featured images live in the blog's own table (see pipeline/live.ts); anything else is read over the network. */
const imageFetcherFor = (db: AnyDb): ImageFetcher => async (url) => {
  if (url.startsWith(IMAGE_URL_PREFIX)) {
    const key = decodeURIComponent(url.slice(IMAGE_URL_PREFIX.length));
    const [row] = await db.select().from(imageStore).where(eq(imageStore.key, key));
    if (!row) throw new CmsError('The stored featured image is missing', 'unavailable', false);
    return { bytes: row.bytes, mimeType: row.mimeType };
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new CmsError(`Could not read the stored image (${res.status})`, 'unavailable', true);
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') ?? 'image/webp' };
};

/**
 * Publishes every post that is due. Safe to run from several workers and to re-run after a crash: a post already created
 * in the CMS is found again instead of being created twice, and an article that is not ready is delayed, never published.
 */
export async function processDuePosts(db: AnyDb, adapter: CmsAdapter, q: QueueSettings, now = new Date(), opts: { limit?: number; fetchImage?: ImageFetcher } = {}): Promise<PublishOutcome[]> {
  const out: PublishOutcome[] = [];
  const busy = await db.select({ id: publishedPosts.id }).from(publishedPosts).where(and(eq(publishedPosts.status, 'publishing'), sql`${publishedPosts.nextAttemptAt} >= ${now.toISOString()}::timestamptz`));
  const room = Math.max(0, Math.min(opts.limit ?? 5, q.maxConcurrentJobs - busy.length));
  if (!room) return out;

  const due = await db
    .select({ id: publishedPosts.id })
    .from(publishedPosts)
    .where(or(and(inArray(publishedPosts.status, ['scheduled', 'delayed']), lt(publishedPosts.scheduledFor, new Date(now.getTime() + 1)), or(sql`${publishedPosts.nextAttemptAt} is null`, lt(publishedPosts.nextAttemptAt, new Date(now.getTime() + 1)))), and(eq(publishedPosts.status, 'publishing'), lt(publishedPosts.nextAttemptAt, now))))
    .orderBy(desc(publishedPosts.priority), asc(publishedPosts.scheduledFor))
    .limit(room);

  // One connection check per tick. A site that is down delays posts without using up their attempts.
  let conn: Awaited<ReturnType<CmsAdapter['testConnection']>> | null = null;

  for (const { id } of due) {
    const post = await claim(db, id, now);
    if (!post) { out.push({ postId: id, result: 'skipped' }); continue; }
    try {
      out.push(await publishOne(db, adapter, post, q, now, async () => (conn ??= await adapter.testConnection()), opts.fetchImage ?? imageFetcherFor(db)));
    } catch (e) {
      out.push(await recordFailure(db, post, e, now));
    }
  }
  return out;
}

async function publishOne(db: AnyDb, adapter: CmsAdapter, post: PostRow, q: QueueSettings, now: Date, connection: () => Promise<Awaited<ReturnType<CmsAdapter['testConnection']>>>, fetchImage: ImageFetcher): Promise<PublishOutcome> {
  const [a] = await db.select().from(articles).where(eq(articles.id, post.articleId));
  const [img] = await db.select().from(articleAssets).where(and(eq(articleAssets.articleId, post.articleId), eq(articleAssets.kind, 'featured_image')));
  const validation = (a?.validation ?? {}) as { passed?: boolean };

  // 1. Never publish something that is not ready. Put it in a visible delayed state instead.
  if (!a || a.status !== 'scheduled' || !validation.passed || !a.bodyHtml || !img?.url || !['generated', 'uploaded'].includes(img.status)) {
    const why = !a ? 'article missing' : a.status !== 'scheduled' ? `article is ${a.status}` : !validation.passed ? 'quality checks have not passed' : !img?.url ? 'featured image is missing' : 'article body is not rendered';
    await db.update(publishedPosts).set({ status: 'delayed', nextAttemptAt: new Date(now.getTime() + 15 * 60_000), lastError: { code: 'not_ready', message: `Not published: ${why}.`, at: now.toISOString() }, updatedAt: now }).where(eq(publishedPosts.id, post.id));
    return { postId: post.id, result: 'delayed', detail: why };
  }

  // 2. Daily limit: counts what is already out or waiting that day, not this post.
  const taken = await takenTimes(db, now, post.id);
  if (post.scheduledFor && dayIsFull(now, taken.filter((t) => t.getTime() <= now.getTime() + 864e5), q)) {
    const tomorrow = startOfDay(q.timezone, addDays(startOfDay(q.timezone, now), 1));
    const slot = findSlot(tomorrow, taken, q);
    if (slot) {
      await db.update(publishedPosts).set({ status: 'scheduled', scheduledFor: slot, nextAttemptAt: null, lastError: { code: 'daily_limit', message: `Daily limit of ${q.maxPerDay} reached; moved to the next free slot.`, at: now.toISOString() }, updatedAt: now }).where(eq(publishedPosts.id, post.id));
      return { postId: post.id, result: 'rescheduled', detail: 'daily limit' };
    }
  }

  // 3. The CMS must be reachable and authorised. This is a wait, not a failure.
  const status = await connection();
  if (status.state !== 'connected' && status.state !== 'mock') {
    await db.update(publishedPosts).set({ status: 'delayed', nextAttemptAt: new Date(now.getTime() + 5 * 60_000), lastError: { code: `cms_${status.state}`, message: status.detail, at: now.toISOString() }, updatedAt: now }).where(eq(publishedPosts.id, post.id));
    return { postId: post.id, result: 'delayed', detail: status.state };
  }

  // 4. Media, then the post. Each step records its result so a retry continues rather than repeats.
  let mediaId = img.cmsMediaId;
  if (!mediaId) {
    const file = await fetchImage(img.url!);
    const m = await adapter.uploadMedia({ bytes: file.bytes, filename: `${a.slug}.webp`, mimeType: file.mimeType, altText: img.altText ?? a.title, title: a.title });
    mediaId = m.mediaId;
    await db.update(articleAssets).set({ cmsMediaId: mediaId, status: 'uploaded', updatedAt: now }).where(eq(articleAssets.id, img.id));
  }

  // Byline: the article's assigned author (refreshed from the current list), or a random one for articles made before authors existed.
  const authors = await loadAuthors(db);
  let author = resolveAuthor((a.metadata as { author?: unknown }).author, authors);
  if (!author) {
    author = pickAuthor(authors);
    await db.update(articles).set({ metadata: { ...(a.metadata as object), author }, updatedAt: now }).where(eq(articles.id, a.id));
  }

  const existing = post.cmsPostId ? await adapter.getPost(post.cmsPostId) : await adapter.findExisting(a.id, a.slug);
  const result =
    existing && existing.status === 'publish'
      ? existing
      : await adapter.createPost({
          articleId: a.id,
          title: a.title,
          slug: a.slug,
          contentHtml: a.bodyHtml + (author ? authorBoxHtml(author) : ''),
          excerpt: a.excerpt ?? '',
          categoryNames: [a.category ?? 'Uncategorized'],
          tags: a.tags as string[],
          featuredMediaId: mediaId,
          authorWpId: author?.wpUserId ?? undefined,
          status: 'publish',
          seo: { title: a.seoTitle ?? undefined, description: a.metaDescription ?? undefined, focusKeyword: a.primaryKeyword ?? undefined },
        });
  if (!result.cmsPostId || !result.url) throw new CmsError('The CMS did not return a post id and URL, so publication is not confirmed.', 'unverified', false);

  await db.transaction(async (tx) => {
    await tx.update(publishedPosts).set({ status: 'published', cmsPostId: result.cmsPostId, publicUrl: result.url, publishedAt: now, nextAttemptAt: null, lastError: null, syncDetails: { ...result.notes, confirmedAt: now.toISOString(), adopted: !!existing }, updatedAt: now }).where(eq(publishedPosts.id, post.id));
    await tx.update(articles).set({ status: 'published', updatedAt: now }).where(eq(articles.id, a.id));
    if (a.topicId) await tx.update(topicCandidates).set({ status: 'published', updatedAt: now }).where(eq(topicCandidates.id, a.topicId));
    await tx.insert(auditLogs).values({ actor: 'system', action: post.isMock ? 'publishing.mock_published' : 'publishing.published', entityType: 'article', entityId: a.id, details: { postId: post.id, cmsPostId: result.cmsPostId, url: result.url, mock: post.isMock, author: author?.name ?? null } });
  });
  return { postId: post.id, result: 'published' };
}

async function recordFailure(db: AnyDb, post: PostRow, e: unknown, now: Date): Promise<PublishOutcome> {
  const message = e instanceof Error ? e.message : String(e);
  const transient = e instanceof CmsError ? e.transient : false;
  const attempts = post.attempts + 1;
  console.error('publish failed', { postId: post.id, attempts, message });
  const error = { code: e instanceof CmsError ? e.code : 'unexpected', message, at: now.toISOString(), attempts };
  if (!transient || attempts >= post.maxAttempts) {
    await db.update(publishedPosts).set({ status: 'failed', attempts, nextAttemptAt: null, lastError: error, updatedAt: now }).where(eq(publishedPosts.id, post.id));
    // The article stays available: back to ready so it can be rescheduled after the cause is fixed.
    await db.update(articles).set({ status: 'ready', updatedAt: now }).where(and(eq(articles.id, post.articleId), eq(articles.status, 'scheduled')));
    await db.insert(auditLogs).values({ actor: 'system', action: 'publishing.failed', entityType: 'published_post', entityId: post.id, details: error });
    return { postId: post.id, result: 'failed', detail: message };
  }
  await db.update(publishedPosts).set({ status: 'scheduled', attempts, nextAttemptAt: new Date(now.getTime() + publishBackoffMs(attempts)), lastError: error, updatedAt: now }).where(eq(publishedPosts.id, post.id));
  return { postId: post.id, result: 'retry', detail: message };
}

/** Puts a failed post back in the queue for another go (the article must still be ready). */
export async function retryPost(db: AnyDb, postId: string, now = new Date()): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(publishedPosts).where(and(eq(publishedPosts.id, postId), eq(publishedPosts.status, 'failed'))).for('update');
    if (!p) return { ok: false, reason: 'Only a failed post can be retried.' };
    const [live] = await tx.select({ id: publishedPosts.id }).from(publishedPosts).where(and(eq(publishedPosts.articleId, p.articleId), inArray(publishedPosts.status, ['scheduled', 'publishing', 'delayed', 'published'])));
    if (live) return { ok: false, reason: 'This article already has an active publication.' };
    await tx.update(publishedPosts).set({ status: 'scheduled', attempts: 0, nextAttemptAt: null, lastError: null, scheduledFor: now, updatedAt: now }).where(eq(publishedPosts.id, postId));
    await tx.update(articles).set({ status: 'scheduled', updatedAt: now }).where(eq(articles.id, p.articleId));
    return { ok: true };
  });
}
