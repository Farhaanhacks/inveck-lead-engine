import { eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { settings } from './db/schema';
import type { SearchMeter, Services } from './pipeline/services';
import { istDay } from './tasks';

/**
 * The day's Google search budget (Settings, 1,500 credits by default): every search the app makes is
 * counted against it per India day, and the work that searches stops before it runs out, in order of
 * importance: research of companies already found first, then the 8 am contact checks, then finding
 * more companies. Whatever is left waits for the next day; nothing fails because of it.
 */

const key = (day: string) => `searches:${day}`;

/** Counts every search the app makes into the day's total. */
export function dbSearchMeter(db: Db): SearchMeter {
  return {
    async spend(credits) {
      const k = key(istDay());
      await db
        .insert(settings)
        .values({ key: k, value: credits })
        .onConflictDoUpdate({ target: settings.key, set: { value: sql`to_jsonb(coalesce((${settings.value} #>> '{}')::int, 0) + ${credits}::int)` } });
    },
  };
}

/** Credits spent on a day (India time). */
export async function searchesUsed(db: Db, day = istDay()): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key(day)));
  return Number(row?.value ?? 0) || 0;
}

/** What is left of the day's budget. */
export async function searchBudgetLeft(db: Db, s: Pick<Services['settings'], 'dailySearchBudget'>, day = istDay()): Promise<number> {
  return s.dailySearchBudget - (await searchesUsed(db, day));
}

/** What research of one company found people first costs, at most (its own pages' evidence, news, a lookup or two); and of any other company. */
export const RESEARCH_CREDITS = { peopleFirst: 8, other: 40 } as const;
/** Kept back for the 8 am contact checks. */
export const CHECKS_RESERVE = 100;
