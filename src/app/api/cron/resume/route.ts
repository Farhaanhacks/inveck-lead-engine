import { runSecret } from '@/lib/auth';
import { resumeStalledRun } from '@/lib/run-driver';
import { noteWake, wakeDailyRun } from '@/lib/sourcing/wake';
import { getDb } from '@/lib/db';
import { pausedToday } from '@/lib/pause';

export const maxDuration = 300;

/**
 * Scheduled checks every 10 minutes from 6:10 to 11:00 am India time (see vercel.json): Vercel ends a long chain of
 * invocations each calling the next, so a run that stalled is picked up again from here, a fresh request.
 * Does nothing when nothing has stalled. Also starts a scheduled Morning Sample Run once it is due (see
 * SCHEDULED_SAMPLES and DAILY_SAMPLE). Vercel sends CRON_SECRET as a bearer token.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  await noteWake(db, 'vercel', 'a 10-minute check').catch(() => {});
  if (await pausedToday(db)) return Response.json({ paused: true });
  const origin = new URL(request.url).origin;
  const { started, resumed: tests } = await wakeDailyRun(db, origin);
  const run = await resumeStalledRun(origin);
  return Response.json({ started, resumed: { run, tests } });
}
