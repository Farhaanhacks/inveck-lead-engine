import { combine, type ArticleRow, type Coverage } from './report';

/** Shown wherever a figure is unavailable. Never a zero. */
export const NO_DATA = '—';

export const fmtInt = (n: number | null) => (n === null ? NO_DATA : Math.round(n).toLocaleString('en-IN'));
export const fmtPct = (n: number | null) => (n === null ? NO_DATA : `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`);
export const fmtPos = (n: number | null) => (n === null ? NO_DATA : n.toFixed(1));

export type SearchView =
  | { state: 'no_articles' }
  | { state: 'no_rows'; articles: number }
  | {
      state: 'ok';
      articles: number;
      withData: number;
      coverage: Coverage;
      totals: { clicks: string; impressions: string; ctr: string; position: string };
      rows: {
        articleId: string;
        title: string;
        url: string;
        publishedAt: Date;
        days: number;
        clicks: string;
        impressions: string;
        ctr: string;
        position: string;
        queries: { query: string; detail: string }[];
      }[];
    };

/** Search Console figures for display. Articles without rows keep "—" and sort after those with data. */
export function searchConsoleView(rows: ArticleRow[], coverage: Coverage): SearchView {
  if (!rows.length) return { state: 'no_articles' };
  const withData = rows.filter((r) => r.searchDays > 0);
  if (!withData.length) return { state: 'no_rows', articles: rows.length };
  const t = combine(withData);
  return {
    state: 'ok',
    articles: rows.length,
    withData: withData.length,
    coverage,
    totals: { clicks: fmtInt(t.clicks), impressions: fmtInt(t.impressions), ctr: fmtPct(t.ctr), position: fmtPos(t.position) },
    rows: [...rows]
      .sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || (b.impressions ?? -1) - (a.impressions ?? -1) || b.publishedAt.getTime() - a.publishedAt.getTime())
      .map((r) => ({
        articleId: r.articleId,
        title: r.title,
        url: r.url,
        publishedAt: r.publishedAt,
        days: r.searchDays,
        clicks: fmtInt(r.clicks),
        impressions: fmtInt(r.impressions),
        ctr: fmtPct(r.ctr),
        position: fmtPos(r.position),
        queries: r.topQueries.map((q) => ({ query: q.query, detail: `${fmtInt(q.clicks)} clicks · ${fmtInt(q.impressions)} impr. · pos ${fmtPos(q.position)}` })),
      })),
  };
}
