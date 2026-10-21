import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { settings } from './db/schema';
import { istDay } from './tasks';

/**
 * Days INVECK paused everything that runs on its own (settings key 'pausedDays', India dates): no
 * scheduled run, checks or draw, no research, contact checks, LinkedIn lookups or drafts started by
 * opening a page, and a run already going stops. A run the admin starts with Find new prospects, a
 * draw by hand and the Sourcing tests still work.
 */
export async function pausedToday(db: Db, now = new Date()): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'pausedDays'));
  return Array.isArray(row?.value) && (row.value as unknown[]).includes(istDay(now));
}
