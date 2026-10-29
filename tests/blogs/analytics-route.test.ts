import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyDb } from '@/lib/blogs/db/types';
import { loadLastSync } from '@/lib/blogs/analytics/last-sync';
import { makeTestDb } from './helpers/testdb';

const SECRET = 'test-cron-secret-0123456789';
const state = vi.hoisted(() => ({ db: null as unknown as AnyDb, run: vi.fn() }));

vi.mock('@/lib/blogs/db/client', () => ({ getDb: () => state.db }));
vi.mock('@/lib/blogs/analytics/live', () => ({ runAnalyticsSync: state.run }));
vi.mock('@/lib/blogs/env', () => ({ env: () => ({ CRON_SECRET: SECRET }) }));

const { GET } = await import('@/app/api/cron/blogs/analytics/route');
const call = (auth?: string) => GET(new Request('http://localhost/api/cron/analytics', { headers: auth ? { authorization: auth } : {} }));

describe('/api/cron/analytics', () => {
  let t: Awaited<ReturnType<typeof makeTestDb>>;
  let logs: string[];
  beforeAll(async () => { t = await makeTestDb(); state.db = t.db; });
  afterAll(async () => { await t.close(); });
  beforeEach(() => {
    state.run.mockReset();
    logs = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });

  it('refuses requests without the cron secret and does not run the sync', async () => {
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('runs the sync with the Vercel Cron header and records the result', async () => {
    state.run.mockResolvedValue({ articles: 1, searchRows: 3, engagementRows: 0, unmatched: 0, errors: [], skipped: [] });
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ searchRows: 3 });
    expect(await loadLastSync(t.db)).toMatchObject({ searchRows: 3, failure: null });
  });

  it('returns 500 on an unexpected failure, logs a redacted message, and never echoes the secret', async () => {
    state.run.mockRejectedValue(new Error(`Google sign-in failed (400): -----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY----- Bearer ${SECRET}`));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('MIIsecret');
    expect(body).not.toContain('sign-in');
    const line = logs.find((l) => l.includes('analytics.sync_failed'));
    expect(line).toBeDefined();
    expect(line).toContain('Google sign-in failed');
    for (const l of logs) { expect(l).not.toContain('MIIsecret'); expect(l).not.toContain(SECRET); }
    const last = await loadLastSync(t.db);
    expect(last?.failure).toContain('[redacted key]');
    expect(last?.failure).not.toContain(SECRET);
  });

  it('logs provider errors from a finished run without key material', async () => {
    state.run.mockResolvedValue({ articles: 1, searchRows: 0, engagementRows: 0, unmatched: 0, skipped: [], errors: [{ provider: 'search_console', message: 'Search Console returned 401: {"private_key":"leak"}' }] });
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('leak');
    expect(logs.some((l) => l.includes('analytics.sync') && l.includes('"level":"warn"'))).toBe(true);
    for (const l of logs) expect(l).not.toContain('leak');
  });
});
