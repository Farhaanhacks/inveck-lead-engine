import type { GoogleAuth } from './google-auth';

export type PageEngagement = { path: string; date: string; sessions: number; engagedSessions: number; engagementSeconds: number };
export type PageReturning = { path: string; returningUsers: number };

export interface EngagementProvider {
  readonly name: string;
  pageEngagement(startDate: string, endDate: string): Promise<PageEngagement[]>;
  returningUsers(startDate: string, endDate: string): Promise<PageReturning[]>;
  testAccess(): Promise<{ ok: boolean; detail: string }>;
}

type Report = { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] };

/** Google Analytics 4 Data API (runReport), read-only. The service account must be added to the GA4 property as a Viewer. */
export class Ga4Provider implements EngagementProvider {
  readonly name = 'ga4';
  constructor(private readonly auth: GoogleAuth, private readonly propertyId: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async report(body: Record<string, unknown>): Promise<Report> {
    const res = await this.fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(this.propertyId)}:runReport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.auth.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, limit: 10000 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Google Analytics returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return (await res.json()) as Report;
  }

  async pageEngagement(startDate: string, endDate: string): Promise<PageEngagement[]> {
    const r = await this.report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }, { name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'userEngagementDuration' }],
    });
    return (r.rows ?? []).map((row) => {
      const d = row.dimensionValues[1].value; // yyyymmdd
      return { path: row.dimensionValues[0].value, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: Number(row.metricValues[0].value), engagedSessions: Number(row.metricValues[1].value), engagementSeconds: Math.round(Number(row.metricValues[2].value)) };
    });
  }

  async returningUsers(startDate: string, endDate: string): Promise<PageReturning[]> {
    const r = await this.report({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }, { name: 'newVsReturning' }],
      metrics: [{ name: 'activeUsers' }],
    });
    return (r.rows ?? []).filter((row) => row.dimensionValues[1].value === 'returning').map((row) => ({ path: row.dimensionValues[0].value, returningUsers: Number(row.metricValues[0].value) }));
  }

  async testAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.report({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] });
      return { ok: true, detail: `Can read GA4 property ${this.propertyId}.` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
