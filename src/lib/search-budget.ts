import { eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { settings } from './db/schema';
import type { SearchMeter, Services } from './pipeline/services';
import { istDay } from './tasks';

/**
 * Every search the app makes is counted per India day (the Dashboard shows the day's credits). There is no
 * daily limit unless one is set in Settings; with one, the work that searches stops before it runs out, in
 * order of importance: research of companies already found first, then the 8 am contact checks, then
 * finding more companies. Whatever is left waits for the next day; nothing fails because of it.
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

/** What is left of the day's budget (no end when there's no daily limit). */
export async function searchBudgetLeft(db: Db, s: Pick<Services['settings'], 'dailySearchBudget'>, day = istDay()): Promise<number> {
  if (!s.dailySearchBudget) return Number.POSITIVE_INFINITY;
  return s.dailySearchBudget - (await searchesUsed(db, day));
}

/**
 * What researching one company costs, roughly: the full search for its people on LinkedIn (one designation
 * at a time) and its LinkedIn page, evidence and news. The same for a company found people first.
 */
export const RESEARCH_CREDITS = { peopleFirst: 40, other: 40 } as const;
/** Kept back for the 8 am contact checks. */
export const CHECKS_RESERVE = 100;
