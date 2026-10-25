import { after } from 'next/server';
import { runSecret } from '@/lib/auth';
import { bestEffort } from '@/lib/best-effort';
import { getDb } from '@/lib/db';
import { syncInboundDemos } from '@/lib/inbound-demo';
import { pausedToday } from '@/lib/pause';
import { safeEqual } from '@/lib/safe-equal';
import { driveSourcingTest, resumeStalledTests } from '@/lib/sourcing/drive';
import { startScheduledSample } from '@/lib/sourcing/sample-run';

export const maxDuration = 300;

/**
 * Syncs the inbound demo Google Sheet (a daily safety net, see vercel.json; Today also syncs it every few minutes while
 * someone has it open). Secured like the other scheduled routes: only the Vercel cron secret gets in. Safe to run again.
 * Being called every five minutes, it is also a wake-up for the daily Morning Sample: starts it once it is due and carries
 * on one that stalled (nothing when nothing is due or stalled).
 */
export async function GET(request: Request) {
  // Vercel's own cron sends the run secret. An outside timer (every five minutes, which Vercel's free plan can't schedule) uses its
  // own INBOUND_SYNC_SECRET instead, so the main secret never leaves Vercel. That one only starts this read-only sync and the
  // wake-up below (which starts nothing that isn't due).
  const given = request.headers.get('authorization') ?? '';
  const own = process.env.INBOUND_SYNC_SECRET?.trim() ?? '';
  const allowed = given === `Bearer ${await runSecret()}` || (own.length >= 24 && safeEqual(given, `Bearer ${own}`));
  if (!allowed) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  const origin = new URL(request.url).origin;
  const sample = (await pausedToday(db))
    ? null
    : await bestEffort('the daily sample', async () => {
        const started = await startScheduledSample(db);
        if (started) after(() => driveSourcingTest(started, origin));
        return { started, resumed: await resumeStalledTests(origin) };
      }, null);
  const r = await syncInboundDemos(db);
  return Response.json({ read: r.read, created: r.created, meetings: r.meetings, merged: r.merged, skipped: r.skipped.length, noMeeting: r.noMeeting.length, blocked: r.blocked.length, mismatches: r.mismatches, error: r.error, sample });
}
