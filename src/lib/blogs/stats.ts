import 'server-only';
import { and, count, desc, eq, gte, inArray, isNotNull, lt, ne } from 'drizzle-orm';
import { getDb } from './db/client';
import { analyticsSnapshots, articles, auditLogs, contentJobs, publishedPosts, topicCandidates, topicRuns } from './db/schema';
import { lastBeats, workerIsStale } from './heartbeat';
import { getSetting } from './settings';
import { startOfDay, startOfWeek } from './time';

/**
 * Every figure comes from the database. Mock publications (is_mock) are counted apart so a
 * local test run can never inflate "published" numbers.
 */
export async function overviewStats(now = new Date()) {
  const db = await (await getDb());
  const { timezone } = await getSetting('queue');
  const dayStart = startOfDay(timezone, now);
  const weekStart = startOfWeek(timezone, now);
  const real = and(eq(publishedPosts.status, 'published'), eq(publishedPosts.isMock, false));

  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [publishedToday, publishedWeek, scheduled, awaiting, generating, failed, mockPublished] = await Promise.all([
    one(db.select({ n: count() }).from(publishedPosts).where(and(real, gte(publishedPosts.publishedAt, dayStart)))),
    one(db.select({ n: count() }).from(publishedPosts).where(and(real, gte(publishedPosts.publishedAt, weekStart)))),
    one(db.select({ n: count() }).from(publishedPosts).where(eq(publishedPosts.status, 'scheduled'))),
    one(db.select({ n: count() }).from(topicCandidates).where(eq(topicCandidates.status, 'pending'))),
    one(db.select({ n: count() }).from(contentJobs).where(inArray(contentJobs.status, ['queued', 'running', 'retrying']))),
    one(db.select({ n: count() }).from(contentJobs).where(inArray(contentJobs.status, ['failed', 'blocked']))),
    one(db.select({ n: count() }).from(publishedPosts).where(and(eq(publishedPosts.status, 'published'), eq(publishedPosts.isMock, true)))),
  ]);

  const searchRows = await db
    .select({ impressions: analyticsSnapshots.impressions, clicks: analyticsSnapshots.clicks })
    .from(analyticsSnapshots)
    .where(and(eq(analyticsSnapshots.source, 'search_console'), isNotNull(analyticsSnapshots.impressions), gte(analyticsSnapshots.date, new Date(now.getTime() - 28 * 864e5).toISOString().slice(0, 10))));
  const search = searchRows.length
    ? { impressions: searchRows.reduce((a, r) => a + (r.impressions ?? 0), 0), clicks: searchRows.reduce((a, r) => a + (r.clicks ?? 0), 0) }
    : null;

  const recentActivity = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(10);
  const attention = await db
    .select({ id: contentJobs.id, status: contentJobs.status, stage: contentJobs.stage, error: contentJobs.error, updatedAt: contentJobs.updatedAt })
    .from(contentJobs)
    .where(and(inArray(contentJobs.status, ['failed', 'blocked']), ne(contentJobs.status, 'cancelled')))
    .orderBy(desc(contentJobs.updatedAt))
    .limit(5);
  // Work that only a background worker will pick up: jobs waiting or retrying, discovery runs waiting, posts that are due.
  const waiting = await Promise.all([
    db.select({ n: count() }).from(contentJobs).where(inArray(contentJobs.status, ['queued', 'retrying'])),
    db.select({ n: count() }).from(topicRuns).where(eq(topicRuns.status, 'queued')),
    db.select({ n: count() }).from(publishedPosts).where(and(inArray(publishedPosts.status, ['scheduled', 'delayed']), lt(publishedPosts.scheduledFor, now))),
  ]);
  const pendingWork = waiting.reduce((a, r) => a + (r[0]?.n ?? 0), 0);
  const workerStale = workerIsStale(pendingWork, await lastBeats(db), now);
  const delayed = await db.select({ n: count() }).from(publishedPosts).where(and(eq(publishedPosts.status, 'delayed'), lt(publishedPosts.scheduledFor, now)));

  return {
    timezone,
    publishedToday,
    publishedWeek,
    scheduled,
    awaiting,
    generating,
    failed: failed + (delayed[0]?.n ?? 0),
    pendingWork,
    workerStale,
    mockPublished,
    search,
    recentActivity,
    attention,
  };
}

export async function listArticles(statuses?: string[]) {
  return (await getDb())
    .select()
    .from(articles)
    .where(statuses?.length ? inArray(articles.status, statuses) : undefined)
    .orderBy(desc(articles.updatedAt))
    .limit(100);
}
