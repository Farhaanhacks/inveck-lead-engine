import { after } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { settings } from '../db/schema';
import { driveSourcingTest, resumeStalledTests } from './drive';
import { startScheduledSample } from './sample-run';

/**
 * What wakes the daily Morning Sample (see DAILY_SAMPLE): Vercel's scheduled jobs, the outside timer (cron-job.org,
 * through /api/cron/inbound-demos) or a page opened (Dashboard, Sourcing, Today). Each wake-up is noted (settings key
 * 'wakeUps'), so the Sourcing page shows when each last came: the way to see the scheduled jobs and the timer fire.
 */
export type WakeSource = 'vercel' | 'timer' | 'page';
export type WakeUps = Partial<Record<WakeSource, { at: string; by: string }>>;
const KEY = 'wakeUps';

/** Notes a wake-up (each source keeps only its latest). */
export async function noteWake(db: Db, source: WakeSource, by: string, now = new Date()): Promise<void> {
  const value = { [source]: { at: now.toISOString(), by } };
  await db
    .insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`${settings.value} || excluded.value` } });
}

export async function wakeUps(db: Db): Promise<WakeUps> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  return (row?.value as WakeUps | undefined) ?? {};
}

/** Starts the day's sample once it is due and carries on one that paused (nothing when neither). */
export async function wakeDailyRun(db: Db, origin: string): Promise<{ started: number | null; resumed: boolean }> {
  const started = await startScheduledSample(db);
  if (started) after(() => driveSourcingTest(started, origin));
  const resumed = await resumeStalledTests(origin);
  return { started, resumed };
}
