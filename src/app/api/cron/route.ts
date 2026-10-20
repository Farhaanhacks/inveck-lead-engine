import { after } from 'next/server';
import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { driveRun } from '@/lib/run-driver';
import { startRun } from '@/lib/runs';
import { getSettings } from '@/lib/settings';
import { getHolidays } from '@/lib/holidays';
import { istDay } from '@/lib/tasks';

export const maxDuration = 300;

/**
 * The scheduled run at 6:00 am India time, Monday to Friday (see vercel.json). Researches new leads
 * every time, and on a working day (not a holiday marked in Settings) finds new prospects, people
 * first, for what the 8:00 am draw is short of, unless Settings turns the search off. Vercel sends
 * CRON_SECRET as a bearer token.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  const settings = await getSettings(db);
  // The schedule runs on India time; work out today's weekday there.
  const weekdayIst = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCDay();
  const workingDay = weekdayIst >= 1 && weekdayIst <= 5 && !(await getHolidays(db)).has(istDay());
  const findProspects = workingDay && settings.morningSearch;
  const { run, created } = await startRun(db, { findProspects, trigger: 'schedule' });
  if (created) {
    const origin = new URL(request.url).origin;
    after(() => driveRun(run.id, origin));
  }
  return Response.json({ runId: run.id, started: created });
}
