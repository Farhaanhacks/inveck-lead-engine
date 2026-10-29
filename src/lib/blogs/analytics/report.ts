import { and, eq, gte } from 'drizzle-orm';
import { analyticsSnapshots, articles, domainProfiles, publishedPosts, topicCandidates } from '../db/schema';
import type { AnyDb } from '../db/types';

/** null means "no data", which is different from zero. */
export type Metrics = {
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  position: number | null;
  sessions: number | null;
  engagedSessions: number | null;
  engagementSeconds: number | null;
  returning: number | null;
};

export type ArticleRow = Metrics & {
  articleId: string;
  title: string;
  domain: string;
  keyword: string | null;
  format: string | null;
  publishedAt: Date;
  ageDays: number;
  url: string;
  /** Days in the window with a Search Console row. 0 means none yet, and the search figures are null. */
  searchDays: number;
  topQueries: { query: string; clicks: number; impressions: number; position: number }[];
};

export type GroupRow = Metrics & { group: string; articles: number; withData: number };

const sum = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

const empty = (): Metrics => ({ impressions: null, clicks: null, ctr: null, position: null, sessions: null, engagedSessions: null, engagementSeconds: null, returning: null });

/** Combine several articles' figures. CTR and position are recomputed from the totals (position weighted by impressions), never averaged. */
export function combine(rows: Metrics[], weights: (number | null)[] = rows.map((r) => r.impressions)): Metrics {
  const impressions = sum(rows.map((r) => r.impressions));
  const clicks = sum(rows.map((r) => r.clicks));
  const posRows = rows.map((r, i) => ({ p: r.position, w: weights[i] })).filter((x): x is { p: number; w: number } => x.p !== null && x.w !== null && x.w > 0);
  const totalW = posRows.reduce((a, b) => a + b.w, 0);
  return {
    impressions,
    clicks,
    ctr: impressions && clicks !== null ? clicks / impressions : null,
    position: totalW ? posRows.reduce((a, b) => a + b.p * b.w, 0) / totalW : null,
    sessions: sum(rows.map((r) => r.sessions)),
    engagedSessions: sum(rows.map((r) => r.engagedSessions)),
    engagementSeconds: sum(rows.map((r) => r.engagementSeconds)),
    returning: sum(rows.map((r) => r.returning)),
  };
}

const hasData = (m: Metrics) => Object.values(m).some((v) => v !== null);

export function groupBy(rows: ArticleRow[], key: (r: ArticleRow) => string): GroupRow[] {
  const groups = new Map<string, ArticleRow[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups.entries()]
    .map(([group, list]) => ({ group, articles: list.length, withData: list.filter(hasData).length, ...combine(list) }))
    .sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || b.articles - a.articles);
}

export const ageBucket = (days: number) => (days <= 7 ? '0-7 days' : days <= 30 ? '8-30 days' : days <= 90 ? '31-90 days' : 'Over 90 days');
export const weekOf = (d: Date) => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
};

/** Article-level figures for the last `days` days, only for real (non-mock) publications. */
export type Coverage = { first: string | null; last: string | null };

export async function analyticsReport(db: AnyDb, now = new Date(), days = 28): Promise<{ rows: ArticleRow[]; since: string; searchCoverage: Coverage }> {
  const since = new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  const posts = await db
    .select({ articleId: articles.id, title: articles.title, keyword: articles.primaryKeyword, domain: domainProfiles.name, format: topicCandidates.articleFormat, publishedAt: publishedPosts.publishedAt, url: publishedPosts.publicUrl })
    .from(publishedPosts)
    .innerJoin(articles, eq(articles.id, publishedPosts.articleId))
    .innerJoin(domainProfiles, eq(domainProfiles.id, articles.domainId))
    .leftJoin(topicCandidates, eq(topicCandidates.id, articles.topicId))
    .where(and(eq(publishedPosts.status, 'published'), eq(publishedPosts.isMock, false)));
  const snaps = await db.select().from(analyticsSnapshots).where(gte(analyticsSnapshots.date, since));

  const rows: ArticleRow[] = posts.map((p) => {
    const mine = snaps.filter((s) => s.articleId === p.articleId);
    const sc = mine.filter((s) => s.source === 'search_console');
    const ga = mine.filter((s) => s.source === 'ga4');
    const ret = mine.filter((s) => s.source === 'ga4_returning');
    // One query snapshot per sync run; the newest one reflects the latest window.
    const q = mine.filter((s) => s.source === 'search_console_queries').sort((a, b) => b.date.localeCompare(a.date))[0];
    const imp = sc.length ? sc.reduce((a, s) => a + (s.impressions ?? 0), 0) : null;
    const clk = sc.length ? sc.reduce((a, s) => a + (s.clicks ?? 0), 0) : null;
    const w = sc.reduce((a, s) => a + (s.impressions ?? 0), 0);
    return {
      articleId: p.articleId,
      title: p.title,
      domain: p.domain,
      keyword: p.keyword,
      format: p.format,
      publishedAt: p.publishedAt!,
      ageDays: Math.floor((now.getTime() - p.publishedAt!.getTime()) / 864e5),
      url: p.url ?? '',
      searchDays: new Set(sc.map((s) => s.date)).size,
      impressions: imp,
      clicks: clk,
      ctr: imp ? (clk ?? 0) / imp : null,
      position: w ? sc.reduce((a, s) => a + Number(s.avgPosition ?? 0) * (s.impressions ?? 0), 0) / w : null,
      sessions: ga.length ? ga.reduce((a, s) => a + (s.sessions ?? 0), 0) : null,
      engagedSessions: ga.length ? ga.reduce((a, s) => a + (s.engagedSessions ?? 0), 0) : null,
      engagementSeconds: ga.length ? ga.reduce((a, s) => a + (s.engagementSeconds ?? 0), 0) : null,
      returning: ret.length ? ret.reduce((a, s) => a + (s.returningVisitors ?? 0), 0) : null,
      topQueries: ((q?.extra as { topQueries?: ArticleRow['topQueries'] } | undefined)?.topQueries ?? []).slice(0, 5),
    };
  });
  const eligible = new Set(posts.map((p) => p.articleId));
  const scDates = snaps.filter((s) => s.source === 'search_console' && eligible.has(s.articleId)).map((s) => s.date).sort();
  return { rows, since, searchCoverage: { first: scDates[0] ?? null, last: scDates.at(-1) ?? null } };
}

export { empty as emptyMetrics };
