import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { settings } from './db/schema';

/** Holidays the admin marked in Settings, kept as a list of India dates (YYYY-MM-DD) under one settings key. */
const KEY = 'holidays';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date written as YYYY-MM-DD. */
export const validDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export async function getHolidays(db: Db): Promise<Set<string>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  return new Set((Array.isArray(row?.value) ? (row.value as unknown[]) : []).filter((d): d is string => typeof d === 'string' && validDay(d)));
}

export async function saveHolidays(db: Db, days: Iterable<string>): Promise<void> {
  const value = [...new Set(days)].filter(validDay).sort();
  await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}
