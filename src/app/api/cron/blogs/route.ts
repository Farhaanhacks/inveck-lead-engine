import { NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/blogs/cron-auth';
import { getDb } from '@/lib/blogs/db/client';
import { runPendingDiscovery } from '@/lib/blogs/discovery/live';
import { beat } from '@/lib/blogs/heartbeat';
import { runDueJobs } from '@/lib/blogs/pipeline/live';
import { runPublishTick } from '@/lib/blogs/publishing/live';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The Blogs worker tick (see vercel.json): runs queued topic discovery, starts and resumes article jobs, and publishes what is due.
 * Called with `Authorization: Bearer <CRON_SECRET>`; safe to call overlapping or repeatedly. Each part is independent, so one
 * failing never stops the others.
 */
export async function GET(request: Request) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = await getDb();
  const out: Record<string, unknown> = {};
  for (const [name, work] of [
    ['discovery', runPendingDiscovery],
    ['jobs', runDueJobs],
    ['publish', runPublishTick],
  ] as const) {
    try {
      await beat(db, name);
      const results = await work();
      out[name] = { processed: results.length };
    } catch (e) {
      console.error(`blogs cron: ${name} failed`, e instanceof Error ? e.message : e);
      out[name] = { error: 'failed: see the server logs' };
    }
  }
  return NextResponse.json(out);
}
