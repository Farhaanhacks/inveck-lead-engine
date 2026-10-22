import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { syncInboundDemos } from '@/lib/inbound-demo';
import { safeEqual } from '@/lib/safe-equal';

export const maxDuration = 300;

/**
 * Syncs the inbound demo Google Sheet (a daily safety net, see vercel.json; Today also syncs it every few minutes while
 * someone has it open). Secured like the other scheduled routes: only the Vercel cron secret gets in. Safe to run again.
 */
export async function GET(request: Request) {
  // Vercel's own cron sends the run secret. An outside timer (every five minutes, which Vercel's free plan can't schedule) uses its
  // own INBOUND_SYNC_SECRET instead, so the main secret never leaves Vercel. That one only starts this read-only sync.
  const given = request.headers.get('authorization') ?? '';
  const own = process.env.INBOUND_SYNC_SECRET?.trim() ?? '';
  const allowed = given === `Bearer ${await runSecret()}` || (own.length >= 24 && safeEqual(given, `Bearer ${own}`));
  if (!allowed) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const r = await syncInboundDemos(await getDb());
  return Response.json({ read: r.read, created: r.created, meetings: r.meetings, merged: r.merged, skipped: r.skipped.length, noMeeting: r.noMeeting.length, blocked: r.blocked.length, mismatches: r.mismatches, error: r.error });
}
