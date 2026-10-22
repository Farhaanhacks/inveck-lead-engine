import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { syncInboundDemos } from '@/lib/inbound-demo';

export const maxDuration = 300;

/**
 * Syncs the inbound demo Google Sheet (a daily safety net, see vercel.json; Today also syncs it every few minutes while
 * someone has it open). Secured like the other scheduled routes: only the Vercel cron secret gets in. Safe to run again.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const r = await syncInboundDemos(await getDb());
  return Response.json({ read: r.read, created: r.created, meetings: r.meetings, merged: r.merged, skipped: r.skipped.length, noMeeting: r.noMeeting.length, blocked: r.blocked.length, mismatches: r.mismatches, error: r.error });
}
