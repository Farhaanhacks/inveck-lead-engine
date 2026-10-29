import type { GoogleAuth } from './google-auth';

export type SearchRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
export type SearchQuery = { startDate: string; endDate: string; dimensions: ('date' | 'page' | 'query')[]; rowLimit?: number };

export interface SearchPerformanceProvider {
  readonly name: string;
  query(q: SearchQuery): Promise<SearchRow[]>;
  testAccess(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Google Search Console, Search Analytics API (searchAnalytics.query), read-only scope.
 * The service account's email must be added as a user of the property in Search Console.
 * Search Console data lags by about two days and omits rows with no impressions, so missing rows mean "no data", not zero.
 */
export class SearchConsoleProvider implements SearchPerformanceProvider {
  readonly name = 'search_console';
  constructor(private readonly auth: GoogleAuth, private readonly siteUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`https://www.googleapis.com/webmasters/v3${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.auth.token()}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
  }

  async query(q: SearchQuery): Promise<SearchRow[]> {
    const rows: SearchRow[] = [];
    const page = Math.min(q.rowLimit ?? 5000, 5000);
    for (let startRow = 0; startRow < 20_000; startRow += page) {
      const res = await this.call(`/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`, {
        method: 'POST',
        body: JSON.stringify({ startDate: q.startDate, endDate: q.endDate, dimensions: q.dimensions, rowLimit: page, startRow, dataState: 'final' }),
      });
      if (!res.ok) throw new Error(`Search Console returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = (await res.json()) as { rows?: SearchRow[] };
      rows.push(...(data.rows ?? []));
      if ((data.rows?.length ?? 0) < page) break;
    }
    return rows;
  }

  async testAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.call('/sites');
      if (!res.ok) return { ok: false, detail: `Search Console returned ${res.status}.` };
      const data = (await res.json()) as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
      const mine = data.siteEntry?.find((s) => s.siteUrl === this.siteUrl);
      if (!mine) return { ok: false, detail: `Signed in, but ${this.siteUrl} is not among the properties this account can read. Add the service account's email as a user in Search Console.` };
      return { ok: true, detail: `Can read ${mine.siteUrl} (${mine.permissionLevel}).` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
