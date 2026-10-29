import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyticsSnapshots, articles, publishedPosts } from '@/lib/blogs/db/schema';
import { loadLastSync, recordSync, redact, safeResult } from '@/lib/blogs/analytics/last-sync';
import { analyticsReport } from '@/lib/blogs/analytics/report';
import type { SearchPerformanceProvider, SearchQuery, SearchRow } from '@/lib/blogs/analytics/search-console';
import type { EngagementProvider } from '@/lib/blogs/analytics/ga4';
import { syncAnalytics } from '@/lib/blogs/analytics/sync';
import { NO_DATA, searchConsoleView } from '@/lib/blogs/analytics/view';
import { makeTestDb } from './helpers/testdb';

const NOW = new Date('2026-10-28T06:00:00Z');

describe('vercel.json cron', () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
  const jobs = (path: string) => (config.crons ?? []).filter((c: { path: string }) => c.path === path);

  it('runs the blog analytics sync exactly once a day, at a fixed time', () => {
    const [job] = jobs('/api/cron/blogs/analytics');
    expect(jobs('/api/cron/blogs/analytics')).toHaveLength(1);
    const [minute, hour, dom, month, dow] = job.schedule.split(' ');
    expect(job.schedule.split(' ')).toHaveLength(5);
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
  });

  it('runs the blog worker tick (discovery, article jobs, publishing) hourly through the day, each entry once a day (the Hobby plan allows nothing more often), and leaves the CRM crons as they were', () => {
    const ticks = jobs('/api/cron/blogs');
    expect(ticks.length).toBeGreaterThan(5);
    for (const c of ticks) expect(c.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(new Set(ticks.map((c: { schedule: string }) => c.schedule)).size).toBe(ticks.length);
    for (const path of ['/api/cron', '/api/cron/draw', '/api/cron/inbound-demos', '/api/cron/resume']) expect(jobs(path).length).toBeGreaterThan(0);
  });
});

class FakeSearch implements SearchPerformanceProvider {
  readonly name = 'fake-search';
  queries: SearchQuery[] = [];
  constructor(private byDims: Record<string, SearchRow[]> = {}, private fail?: Error) {}
  async query(q: SearchQuery) {
    this.queries.push(q);
    if (this.fail) throw this.fail;
    return this.byDims[q.dimensions.join(',')] ?? [];
  }
  async testAccess() { return { ok: true, detail: 'ok' }; }
}

class FakeEngagement implements EngagementProvider {
  readonly name = 'fake-ga4';
  async pageEngagement() { return [{ path: '/business/real-one', date: '2026-10-26', sessions: 12, engagedSessions: 8, engagementSeconds: 300 }]; }
  async returningUsers() { return [{ path: '/business/real-one/', returningUsers: 3 }]; }
  async testAccess() { return { ok: true, detail: 'ok' }; }
}

describe('Search Console analytics', () => {
  let t: Awaited<ReturnType<typeof makeTestDb>>;
  let n = 0;
  const article = async (title: string) => {
    n++;
    const [a] = await t.db.insert(articles).values({ domainId: t.domains[0].id, title, slug: `a-${n}`, status: 'published' }).returning();
    return a;
  };
  const post = async (title: string, over: { url?: string | null; isMock?: boolean; status?: string } = {}) => {
    const a = await article(title);
    await t.db.insert(publishedPosts).values({ articleId: a.id, adapter: over.isMock ? 'mock' : 'wordpress', isMock: over.isMock ?? false, status: over.status ?? 'published', publicUrl: over.url === undefined ? `https://articlebasket.com/business/a-${n}/` : over.url, publishedAt: new Date('2026-10-10T05:00:00Z'), idempotencyKey: `k-${n}` });
    return a;
  };
  const sc = (articleId: string, date: string, impressions: number, clicks: number, position: number) =>
    t.db.insert(analyticsSnapshots).values({ articleId, date, source: 'search_console', impressions, clicks, ctr: String(impressions ? clicks / impressions : 0), avgPosition: String(position) });

  beforeAll(async () => { t = await makeTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await t.db.delete(analyticsSnapshots);
    await t.db.delete(publishedPosts);
    await t.db.delete(articles);
  });

  describe('report and display data', () => {
    it('says there is nothing to measure when no real post is published', async () => {
      await post('Mock only', { isMock: true });
      await post('Not yet live', { status: 'scheduled' });
      const r = await analyticsReport(t.db, NOW);
      expect(r.rows).toHaveLength(0);
      expect(searchConsoleView(r.rows, r.searchCoverage)).toEqual({ state: 'no_articles' });
    });

    it('says there are no rows yet, rather than showing zeros, when Search Console has nothing', async () => {
      await post('Fresh post');
      const r = await analyticsReport(t.db, NOW);
      expect(r.rows[0]).toMatchObject({ impressions: null, clicks: null, ctr: null, position: null, searchDays: 0 });
      expect(r.searchCoverage).toEqual({ first: null, last: null });
      expect(searchConsoleView(r.rows, r.searchCoverage)).toEqual({ state: 'no_rows', articles: 1 });
    });

    it('totals clicks and impressions, recomputes CTR and weights position by impressions', async () => {
      const a = await post('Busy post');
      await sc(a.id, '2026-10-24', 100, 10, 4);
      await sc(a.id, '2026-10-25', 300, 5, 8);
      const r = await analyticsReport(t.db, NOW);
      expect(r.rows[0]).toMatchObject({ impressions: 400, clicks: 15, searchDays: 2 });
      expect(r.rows[0].ctr).toBeCloseTo(15 / 400);
      expect(r.rows[0].position).toBeCloseTo((4 * 100 + 8 * 300) / 400);
      expect(r.searchCoverage).toEqual({ first: '2026-10-24', last: '2026-10-25' });
    });

    it('shows a dash for articles without data and a real zero for articles with zero clicks', async () => {
      const seen = await post('Seen, never clicked');
      await post('Not seen yet');
      await sc(seen.id, '2026-10-25', 50, 0, 12);
      const r = await analyticsReport(t.db, NOW);
      const v = searchConsoleView(r.rows, r.searchCoverage);
      if (v.state !== 'ok') throw new Error(`expected ok, got ${v.state}`);
      expect(v).toMatchObject({ articles: 2, withData: 1, totals: { clicks: '0', impressions: '50', ctr: '0.00%', position: '12.0' } });
      expect(v.rows.map((x) => x.title)).toEqual(['Seen, never clicked', 'Not seen yet']);
      expect(v.rows[0]).toMatchObject({ clicks: '0', days: 1 });
      expect(v.rows[1]).toMatchObject({ clicks: NO_DATA, impressions: NO_DATA, ctr: NO_DATA, position: NO_DATA, days: 0 });
    });

    it('leaves out mock posts and their snapshots, and keeps GA4 figures out of the search totals', async () => {
      const real = await post('Real');
      const mock = await post('Mock', { isMock: true, url: null });
      await sc(real.id, '2026-10-25', 10, 1, 3);
      await sc(mock.id, '2026-10-25', 9999, 999, 1);
      await t.db.insert(analyticsSnapshots).values({ articleId: real.id, date: '2026-10-25', source: 'ga4', sessions: 40 });
      const r = await analyticsReport(t.db, NOW);
      expect(r.rows.map((x) => x.title)).toEqual(['Real']);
      expect(r.rows[0]).toMatchObject({ impressions: 10, clicks: 1, sessions: 40 });
      const v = searchConsoleView(r.rows, r.searchCoverage);
      expect(v.state === 'ok' && v.totals).toEqual({ clicks: '1', impressions: '10', ctr: '10.0%', position: '3.0' });
    });

    it('uses the newest top-query snapshot', async () => {
      const a = await post('Queried');
      await sc(a.id, '2026-10-25', 10, 1, 3);
      const q = (query: string) => [{ query, clicks: 1, impressions: 10, position: 3 }];
      await t.db.insert(analyticsSnapshots).values({ articleId: a.id, date: '2026-10-24', source: 'search_console_queries', extra: { topQueries: q('old') } });
      await t.db.insert(analyticsSnapshots).values({ articleId: a.id, date: '2026-10-26', source: 'search_console_queries', extra: { topQueries: q('new') } });
      const r = await analyticsReport(t.db, NOW);
      expect(r.rows[0].topQueries.map((x) => x.query)).toEqual(['new']);
      const v = searchConsoleView(r.rows, r.searchCoverage);
      expect(v.state === 'ok' && v.rows[0].queries).toEqual([{ query: 'new', detail: '1 clicks · 10 impr. · pos 3.0' }]);
    });
  });

  describe('sync', () => {
    it('skips cleanly when there are no real published posts', async () => {
      await post('Mock', { isMock: true, url: null });
      const search = new FakeSearch();
      const r = await syncAnalytics(t.db, { search, now: NOW });
      expect(r).toMatchObject({ articles: 0, searchRows: 0, skipped: ['No published articles yet.'] });
      expect(search.queries).toHaveLength(0);
    });

    it('stores matching pages by day, counts other pages as unmatched, and lags two days', async () => {
      const a = await post('Real one', { url: 'https://articlebasket.com/business/real-one/' });
      const search = new FakeSearch({
        'page,date': [
          { keys: ['https://www.articlebasket.com/business/real-one', '2026-10-25'], clicks: 2, impressions: 40, ctr: 0.05, position: 6 },
          { keys: ['https://articlebasket.com/someone-elses-page/', '2026-10-25'], clicks: 9, impressions: 90, ctr: 0.1, position: 2 },
        ],
        'page,query': [{ keys: ['https://articlebasket.com/business/real-one/', 'stock forecasting'], clicks: 2, impressions: 30, ctr: 0.07, position: 5 }],
      });
      const r = await syncAnalytics(t.db, { search, now: NOW });
      expect(r).toMatchObject({ articles: 1, searchRows: 1, unmatched: 1, errors: [] });
      expect(search.queries[0]).toMatchObject({ endDate: '2026-10-26', startDate: '2026-10-20' });
      const rows = await t.db.select().from(analyticsSnapshots);
      expect(rows.find((x) => x.source === 'search_console')).toMatchObject({ articleId: a.id, date: '2026-10-25', clicks: 2, impressions: 40 });
      expect(rows.find((x) => x.source === 'search_console_queries')).toMatchObject({ date: '2026-10-26' });
      // Running again is idempotent: the same day is updated, not duplicated.
      await syncAnalytics(t.db, { search, now: NOW });
      expect((await t.db.select().from(analyticsSnapshots)).filter((x) => x.source === 'search_console')).toHaveLength(1);
    });

    it('records a provider error instead of throwing, and stores GA4 under its own sources', async () => {
      await post('Real one', { url: 'https://articlebasket.com/business/real-one/' });
      const r = await syncAnalytics(t.db, { search: new FakeSearch({}, new Error('Search Console returned 403: User does not have sufficient permission')), engagement: new FakeEngagement(), now: NOW });
      expect(r.errors).toEqual([{ provider: 'search_console', message: expect.stringContaining('403') }]);
      expect(r.engagementRows).toBe(1);
      const sources = (await t.db.select().from(analyticsSnapshots)).map((x) => x.source).sort();
      expect(sources).toEqual(['ga4', 'ga4_returning']);
    });

    it('notes when Search Console is not connected', async () => {
      await post('Real one');
      const r = await syncAnalytics(t.db, { search: null, now: NOW });
      expect(r.skipped).toContain('Search Console is not connected.');
    });
  });

  describe('last sync record', () => {
    it('round-trips the latest run', async () => {
      await recordSync(t.db, { articles: 2, searchRows: 5, engagementRows: 0, unmatched: 1, errors: [], skipped: [], at: NOW.toISOString(), failure: null });
      await recordSync(t.db, { articles: 0, searchRows: 0, engagementRows: 0, unmatched: 0, errors: [], skipped: [], at: NOW.toISOString(), failure: 'boom' });
      expect(await loadLastSync(t.db)).toMatchObject({ failure: 'boom' });
    });
  });
});

describe('redact', () => {
  it('removes key material and tokens from provider messages', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEv...secret\n-----END PRIVATE KEY-----';
    const out = redact(`bad key ${key} {"private_key":"abc123"} Authorization: Bearer ya29.a0AfH6SMB tok eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl`);
    for (const secret of ['MIIEv', 'secret', 'abc123', 'a0AfH6SMB', 'eyJhbGciOi']) expect(out).not.toContain(secret);
    expect(out).toContain('bad key');
  });

  it('keeps messages short and redacts every error in a sync result', () => {
    expect(redact('x'.repeat(1000))).toHaveLength(300);
    expect(safeResult({ articles: 1, searchRows: 0, engagementRows: 0, unmatched: 0, skipped: [], errors: [{ provider: 'search_console', message: 'Bearer abc.def' }] }).errors[0].message).toBe('Bearer [redacted]');
  });
});
