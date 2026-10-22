import { after } from 'next/server';
import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { driveRun, resumeStalledRun } from '@/lib/run-driver';
import { startRun } from '@/lib/runs';
import { getSettings } from '@/lib/settings';
import { searchesThisMorning } from '@/lib/sourcing/morning';
import { pausedToday } from '@/lib/pause';

export const maxDuration = 300;

/**
 * The scheduled run at 6:00 am India time, Monday to Friday (see vercel.json). Researches new leads
 * every time, and on a working day (not a holiday marked in Settings, not before the day the morning
 * search starts) finds new prospects, people first, for what the 8:00 am draw is short of, unless
 * Settings turns the search off. Vercel sends CRON_SECRET as a bearer token.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  // Paused today (Settings key pausedDays): no run at all.
  if (await pausedToday(db)) return Response.json({ paused: true });
  const origin = new URL(request.url).origin;
  // A run that stalled (its chain of invocations ended) carries on instead of a new one starting.
  if (await resumeStalledRun(origin)) return Response.json({ resumed: true });
  // Research runs every time; the search only on a working day from the day it starts (India time).
  const findProspects = await searchesThisMorning(db, await getSettings(db));
  const { run, created } = await startRun(db, { findProspects, trigger: 'schedule' });
  if (created) after(() => driveRun(run.id, origin));
  return Response.json({ runId: run.id, started: created });
}
