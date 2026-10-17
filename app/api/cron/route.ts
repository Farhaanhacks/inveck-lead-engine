import { after } from 'next/server';
import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { driveRun } from '@/lib/run-driver';
import { startRun } from '@/lib/runs';
import { getSettings } from '@/lib/settings';

export const maxDuration = 300;

/**
 * The scheduled run (see vercel.json). Researches new leads every time, and also looks
 * for new prospects on the weekday chosen in Settings (or every weekday). Vercel sends CRON_SECRET as a
 * bearer token.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  const settings = await getSettings(db);
  // The schedule runs on India time; work out today's weekday there.
  const weekdayIst = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCDay();
  // 7 = every weekday: the schedule itself only runs Monday to Friday.
  const findProspects = settings.prospectDay === 7 ? weekdayIst >= 1 && weekdayIst <= 5 : settings.prospectDay === weekdayIst;
  const { run, created } = await startRun(db, { findProspects, trigger: 'schedule' });
  if (created) {
    const origin = new URL(request.url).origin;
    after(() => driveRun(run.id, origin));
  }
  return Response.json({ runId: run.id, started: created });
}
