import { and, eq, isNotNull } from 'drizzle-orm';
import { analyticsSnapshots, publishedPosts } from '../db/schema';
import type { AnyDb } from '../db/types';
import type { EngagementProvider } from './ga4';
import type { SearchPerformanceProvider } from './search-console';

export type SyncDeps = { search?: SearchPerformanceProvider | null; engagement?: EngagementProvider | null; now?: Date; windowDays?: number };
export type SyncResult = {
  articles: number;
  searchRows: number;
  engagementRows: number;
  unmatched: number;
  errors: { provider: string; message: string }[];
  skipped: string[];
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDaysUtc = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);

/** "articlebasket.com/business/some-post" for any form of the same page address. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}
const pathKey = (path: string) => path.split('?')[0].replace(/\/+$/, '').toLowerCase();

/**
 * Pulls recent Search Console and GA4 figures for published articles and stores them by day.
 * Only real publications are matched (mock posts have no real URL). A day with no row from the provider stays absent:
 * "no data" is never written as zero. The window is re-fetched every run and upserted, so late revisions are picked up.
 */
export async function syncAnalytics(db: AnyDb, deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now ?? new Date();
  const result: SyncResult = { articles: 0, searchRows: 0, engagementRows: 0, unmatched: 0, errors: [], skipped: [] };
  const posts = await db
    .select({ articleId: publishedPosts.articleId, url: publishedPosts.publicUrl })
    .from(publishedPosts)
    .where(and(eq(publishedPosts.status, 'published'), eq(publishedPosts.isMock, false), isNotNull(publishedPosts.publicUrl)));
  const byPage = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const p of posts) {
    const k = pageKey(p.url!);
    if (!k) continue;
    byPage.set(k, p.articleId);
    byPath.set(k.slice(k.indexOf('/')), p.articleId);
  }
  result.articles = byPage.size;
  if (!byPage.size) {
    result.skipped.push('No published articles yet.');
    return result;
  }
  const windowDays = deps.windowDays ?? 7;

  const upsert = async (v: typeof analyticsSnapshots.$inferInsert) => {
    await db
      .insert(analyticsSnapshots)
      .values(v)
      .onConflictDoUpdate({ target: [analyticsSnapshots.articleId, analyticsSnapshots.date, analyticsSnapshots.source], set: { impressions: v.impressions ?? null, clicks: v.clicks ?? null, ctr: v.ctr ?? null, avgPosition: v.avgPosition ?? null, sessions: v.sessions ?? null, engagedSessions: v.engagedSessions ?? null, engagementSeconds: v.engagementSeconds ?? null, returningVisitors: v.returningVisitors ?? null, extra: v.extra ?? {} } });
  };

  if (deps.search) {
    try {
      // Search Console is about two days behind.
      const end = ymd(addDaysUtc(now, -2));
      const start = ymd(addDaysUtc(now, -2 - (windowDays - 1)));
      for (const r of await deps.search.query({ startDate: start, endDate: end, dimensions: ['page', 'date'] })) {
        const id = pageKey(r.keys[0]) ? byPage.get(pageKey(r.keys[0])!) : undefined;
        if (!id) { result.unmatched++; continue; }
        await upsert({ articleId: id, date: r.keys[1], source: 'search_console', impressions: r.impressions, clicks: r.clicks, ctr: String(r.ctr), avgPosition: String(r.position) });
        result.searchRows++;
      }
      const perArticle = new Map<string, { query: string; clicks: number; impressions: number; position: number }[]>();
      for (const r of await deps.search.query({ startDate: start, endDate: end, dimensions: ['page', 'query'] })) {
        const id = pageKey(r.keys[0]) ? byPage.get(pageKey(r.keys[0])!) : undefined;
        if (id) perArticle.set(id, [...(perArticle.get(id) ?? []), { query: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position }]);
      }
      for (const [articleId, qs] of perArticle) {
        const top = qs.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 10);
        await upsert({ articleId, date: end, source: 'search_console_queries', extra: { topQueries: top, window: [start, end] } });
      }
    } catch (e) {
      result.errors.push({ provider: 'search_console', message: e instanceof Error ? e.message : String(e) });
    }
  } else result.skipped.push('Search Console is not connected.');

  if (deps.engagement) {
    try {
      const end = ymd(addDaysUtc(now, -1));
      const start = ymd(addDaysUtc(now, -1 - (windowDays - 1)));
      for (const r of await deps.engagement.pageEngagement(start, end)) {
        const id = byPath.get(pathKey(r.path));
        if (!id) { result.unmatched++; continue; }
        await upsert({ articleId: id, date: r.date, source: 'ga4', sessions: r.sessions, engagedSessions: r.engagedSessions, engagementSeconds: r.engagementSeconds });
        result.engagementRows++;
      }
      for (const r of await deps.engagement.returningUsers(start, end)) {
        const id = byPath.get(pathKey(r.path));
        if (id) await upsert({ articleId: id, date: end, source: 'ga4_returning', returningVisitors: r.returningUsers, extra: { window: [start, end] } });
      }
    } catch (e) {
      result.errors.push({ provider: 'ga4', message: e instanceof Error ? e.message : String(e) });
    }
  } else result.skipped.push('Google Analytics is not connected.');

  return result;
}
