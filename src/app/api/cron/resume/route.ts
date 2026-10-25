import { after } from 'next/server';
import { runSecret } from '@/lib/auth';
import { resumeStalledRun } from '@/lib/run-driver';
import { driveSourcingTest, resumeStalledTests } from '@/lib/sourcing/drive';
import { startScheduledSample } from '@/lib/sourcing/sample-run';
import { getDb } from '@/lib/db';
import { pausedToday } from '@/lib/pause';

export const maxDuration = 300;

/**
 * Scheduled checks between the 6 am run and the 8 am draw (see vercel.json): Vercel ends a long chain of
 * invocations each calling the next, so a run that stalled is picked up again from here, a fresh request.
 * Does nothing when nothing has stalled. Also starts a scheduled Morning Sample Run once it is due (see
 * SCHEDULED_SAMPLES). Vercel sends CRON_SECRET as a bearer token.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  if (await pausedToday(db)) return Response.json({ paused: true });
  const origin = new URL(request.url).origin;
  const started = await startScheduledSample(db);
  if (started) after(() => driveSourcingTest(started, origin));
  const run = await resumeStalledRun(origin);
  const tests = await resumeStalledTests(origin);
  return Response.json({ started, resumed: { run, tests } });
}
