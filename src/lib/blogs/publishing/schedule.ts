import { and, count, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import type { CmsAdapter } from '../cms/types';
import { articleAssets, articles, auditLogs, publishedPosts } from '../db/schema';
import type { AnyDb } from '../db/types';
import { startOfDay } from '../time';
import { dayIsFull, findSlot, type SlotConfig } from './slots';

export type QueueSettings = SlotConfig & { targetPerDay: number; maxConcurrentJobs: number; autoSlotApproved: boolean };
export type Actor = { id: number; email: string };

/** Posts that occupy a slot: waiting, being published, or published (including mock ones, so local tests respect the same limits). */
const LIVE = ['scheduled', 'publishing', 'delayed', 'published'] as const;

export type ScheduleRequest =
  | { mode: 'immediate'; priority?: number }
  | { mode: 'scheduled'; at: Date; priority?: number }
  | { mode: 'queue'; priority?: number };

export type ScheduleResult = { ok: true; postId: string; scheduledFor: Date } | { ok: false; reason: string };

export async function takenTimes(db: AnyDb, since: Date, excludePostId?: string): Promise<Date[]> {
  const rows = await db
    .select({ id: publishedPosts.id, s: publishedPosts.scheduledFor, p: publishedPosts.publishedAt, status: publishedPosts.status })
    .from(publishedPosts)
    .where(and(inArray(publishedPosts.status, [...LIVE]), excludePostId ? ne(publishedPosts.id, excludePostId) : undefined));
  return rows.map((r) => (r.status === 'published' ? r.p : r.s)).filter((d): d is Date => !!d && d.getTime() >= since.getTime() - 36 * 3600_000);
}

/**
 * Puts a validated article on the schedule. Refuses anything that has not passed validation or has no stored image,
 * and never exceeds the daily limit.
 */
export async function schedulePublication(db: AnyDb, adapter: Pick<CmsAdapter, 'name' | 'isMock'>, articleId: string, req: ScheduleRequest, q: QueueSettings, actor: Actor, now = new Date()): Promise<ScheduleResult> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(articles).where(eq(articles.id, articleId)).for('update');
    if (!a) return { ok: false, reason: 'Article not found.' } as const;
    if (a.status !== 'ready') return { ok: false, reason: `Only a ready article can be scheduled; this one is ${a.status}.` } as const;
    const validation = a.validation as { passed?: boolean };
    if (!validation.passed) return { ok: false, reason: 'The article has not passed its quality checks.' } as const;
    const [img] = await tx.select().from(articleAssets).where(and(eq(articleAssets.articleId, articleId), eq(articleAssets.kind, 'featured_image')));
    if (!img || !['generated', 'uploaded'].includes(img.status) || !img.url) return { ok: false, reason: 'The featured image is missing. Generate it before scheduling.' } as const;

    const existing = await tx.select({ id: publishedPosts.id }).from(publishedPosts).where(and(eq(publishedPosts.articleId, articleId), inArray(publishedPosts.status, [...LIVE])));
    if (existing.length) return { ok: false, reason: 'This article is already scheduled or published.' } as const;

    const taken = await takenTimes(tx as unknown as AnyDb, now);
    let when: Date;
    if (req.mode === 'immediate') {
      when = now;
    } else if (req.mode === 'scheduled') {
      if (req.at.getTime() < now.getTime() - 60_000) return { ok: false, reason: 'That time has already passed.' } as const;
      if (req.at.getTime() > now.getTime() + 366 * 864e5) return { ok: false, reason: 'Choose a date within the next year.' } as const;
      when = req.at;
    } else {
      const slot = findSlot(now, taken, q);
      if (!slot) return { ok: false, reason: 'No free slot in the next 60 days. Raise the daily limit or widen the publishing window.' } as const;
      when = slot;
    }
    if (dayIsFull(when, taken, q)) return { ok: false, reason: `That day already has ${q.maxPerDay} articles, the daily limit.` } as const;

    const [{ n }] = await tx.select({ n: count() }).from(publishedPosts).where(eq(publishedPosts.articleId, articleId));
    const [post] = await tx
      .insert(publishedPosts)
      .values({ articleId, adapter: adapter.name, isMock: adapter.isMock, status: 'scheduled', scheduledFor: when, priority: req.priority ?? 0, idempotencyKey: `article:${articleId}:publish:${n + 1}` })
      .returning({ id: publishedPosts.id });
    await tx.update(articles).set({ status: 'scheduled', updatedAt: now }).where(eq(articles.id, articleId));
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'publishing.scheduled', entityType: 'article', entityId: articleId, details: { postId: post.id, mode: req.mode, scheduledFor: when.toISOString(), adapter: adapter.name } });
    return { ok: true, postId: post.id, scheduledFor: when } as const;
  });
}

export async function reschedulePost(db: AnyDb, postId: string, to: { at: Date } | { slot: true }, q: QueueSettings, actor: Actor, now = new Date()): Promise<ScheduleResult> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(publishedPosts).where(eq(publishedPosts.id, postId)).for('update');
    if (!p || !['scheduled', 'delayed'].includes(p.status)) return { ok: false, reason: 'Only a waiting post can be rescheduled.' } as const;
    const taken = await takenTimes(tx as unknown as AnyDb, now, postId);
    let when: Date;
    if ('slot' in to) {
      const slot = findSlot(now, taken, q);
      if (!slot) return { ok: false, reason: 'No free slot in the next 60 days.' } as const;
      when = slot;
    } else {
      if (to.at.getTime() < now.getTime() - 60_000) return { ok: false, reason: 'That time has already passed.' } as const;
      when = to.at;
    }
    if (dayIsFull(when, taken, q)) return { ok: false, reason: `That day already has ${q.maxPerDay} articles, the daily limit.` } as const;
    await tx.update(publishedPosts).set({ scheduledFor: when, status: 'scheduled', nextAttemptAt: null, attempts: 0, lastError: null, updatedAt: now }).where(eq(publishedPosts.id, postId));
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'publishing.rescheduled', entityType: 'published_post', entityId: postId, details: { from: p.scheduledFor?.toISOString() ?? null, to: when.toISOString() } });
    return { ok: true, postId, scheduledFor: when } as const;
  });
}

/** Cancels a post that has not been published. The article goes back to ready so it can be scheduled again. */
export async function cancelPost(db: AnyDb, postId: string, actor: Actor, now = new Date()): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const [p] = await tx
      .update(publishedPosts)
      .set({ status: 'cancelled', nextAttemptAt: null, updatedAt: now })
      .where(and(eq(publishedPosts.id, postId), inArray(publishedPosts.status, ['scheduled', 'delayed', 'failed'])))
      .returning();
    if (!p) return { ok: false, reason: 'Only a waiting or failed post can be cancelled. A post being published right now cannot be stopped.' };
    await tx.update(articles).set({ status: 'ready', updatedAt: now }).where(and(eq(articles.id, p.articleId), inArray(articles.status, ['scheduled', 'failed'])));
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'publishing.cancelled', entityType: 'published_post', entityId: postId, details: { articleId: p.articleId } });
    return { ok: true };
  });
}

/** How many real (non-mock) articles were published on the local day containing `at`. */
export async function publishedCountOnDay(db: AnyDb, timeZone: string, at: Date): Promise<number> {
  const start = startOfDay(timeZone, at);
  const end = new Date(startOfDay(timeZone, new Date(start.getTime() + 36 * 3600_000)).getTime());
  const [{ n }] = await db.select({ n: count() }).from(publishedPosts).where(and(eq(publishedPosts.status, 'published'), gte(publishedPosts.publishedAt, start), lt(publishedPosts.publishedAt, end)));
  return n;
}
