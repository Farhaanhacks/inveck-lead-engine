import { NextResponse } from 'next/server';
import { runAnalyticsSync } from '@/lib/blogs/analytics/live';
import { recordSync, redact, safeResult } from '@/lib/blogs/analytics/last-sync';
import { isCronAuthorized } from '@/lib/blogs/cron-auth';
import { getDb } from '@/lib/blogs/db/client';
import { beat } from '@/lib/blogs/heartbeat';
import { log } from '@/lib/blogs/log';
import { sendAlert } from '@/lib/blogs/alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Daily Search Console (and GA4, when configured) sync. Called by Vercel Cron with `Authorization: Bearer <CRON_SECRET>`. */
export async function GET(request: Request) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = await getDb();
  const at = new Date().toISOString();
  try {
    await beat(db, 'analytics');
    const result = safeResult(await runAnalyticsSync());
    await recordSync(db, { ...result, at, failure: null });
    log(result.errors.length ? 'warn' : 'info', 'analytics.sync', { ...result });
    if (result.errors.length) await sendAlert({ key: 'analytics-sync', title: 'Analytics sync had errors', detail: result.errors.map((e) => `${e.provider}: ${e.message}`).join('; ') });
    return NextResponse.json(result);
  } catch (e) {
    // Only a redacted message is logged or stored: never the key, a token or the raw provider response.
    const message = redact(e instanceof Error ? e.message : String(e));
    log('error', 'analytics.sync_failed', { message });
    await recordSync(db, { articles: 0, searchRows: 0, engagementRows: 0, unmatched: 0, errors: [], skipped: [], at, failure: message }).catch(() => {});
    await sendAlert({ key: 'analytics-sync', title: 'Analytics sync failed', detail: message });
    return NextResponse.json({ error: 'Analytics sync failed. See the server logs.' }, { status: 500 });
  }
}
