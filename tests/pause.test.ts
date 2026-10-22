import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { sql, eq } from 'drizzle-orm';
import { leads, settings } from '@/lib/db/schema';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { MANUFACTURING } from '@/lib/db/seed';
import { pausedToday } from '@/lib/pause';
import { runDailyDraw, topUpDraw } from '@/lib/draw';
import { verifyContacts } from '@/lib/verify-contacts';
import { settingsSchema } from '@/lib/settings';
import type { Services } from '@/lib/pipeline/services';

/** A day INVECK paused: nothing that runs on its own runs (Thursday 22 October 2026 on the live database). */

let db: Db;
// Thursday 22 October 2026, 8:30 am India time.
const thursday = new Date('2026-10-22T03:00:00Z');

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

describe('a paused day', () => {
  it('is only the days set, India time; a new database has none', async () => {
    expect(await pausedToday(db, thursday)).toBe(false);
    await db.insert(settings).values({ key: 'pausedDays', value: ['2026-10-22'] });
    expect(await pausedToday(db, thursday)).toBe(true);
    // Friday 00:10 India time is no longer Thursday.
    expect(await pausedToday(db, new Date('2026-10-22T18:40:00Z'))).toBe(false);
  });

  it('has no draw unless the admin draws by hand, and no LinkedIn checks', async () => {
    // A Wednesday far from the day the tests run (a new database counts today's draw as done), 8:30 am India time.
    const day = new Date('2030-01-09T03:00:00Z');
    await db.insert(settings).values({ key: 'pausedDays', value: ['2030-01-09'] });
    await db.insert(leads).values({ company: 'Ready Co', segment: MANUFACTURING, status: 'Approved', qualified: true, contactName: 'Asha Kulkarni', contactVerifiedAt: new Date(), researchSummary: 'Makes forgings.' });
    expect(await runDailyDraw(db, { now: day })).toBeNull();
    expect(await topUpDraw(db, { now: day })).toBeNull();
    expect(await runDailyDraw(db, { now: day, force: true })).not.toBeNull();

    let calls = 0;
    const svc = { fetch: (async () => (calls++, new Response('{}'))) as typeof fetch, keys: { serper: 'k' }, settings: settingsSchema.parse({}) } as unknown as Services;
    // verifyContacts reads today's date: pause today as well.
    const { istDay } = await import('@/lib/tasks');
    await db.update(settings).set({ value: ['2030-01-09', istDay()] }).where((await import('drizzle-orm')).eq(settings.key, 'pausedDays'));
    const tally = await verifyContacts(db, svc, { limit: 50 });
    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(0);
    expect(calls).toBe(0);
  });

  it('Friday 23 October is added to the live database\'s paused days, once', async () => {
    const friday = new Date('2026-10-23T00:30:00Z');
    const step = SCHEMA_STATEMENTS.filter((st) => st.includes('pauseFriday23V1'));
    expect(step).toHaveLength(2);
    // A new database has no paused days: nothing is added.
    for (const st of step) await db.execute(sql.raw(st));
    expect(await db.select().from(settings).where(eq(settings.key, 'pausedDays'))).toEqual([]);
    // The live database: Thursday paused already; Friday added, and only once.
    await db.delete(settings).where(eq(settings.key, 'pauseFriday23V1'));
    await db.insert(settings).values({ key: 'pausedDays', value: ['2026-10-22'] });
    for (let i = 0; i < 2; i++) for (const st of step) await db.execute(sql.raw(st));
    const [row] = await db.select().from(settings).where(eq(settings.key, 'pausedDays'));
    expect(row.value).toEqual(['2026-10-22', '2026-10-23']);
    expect(await pausedToday(db, friday)).toBe(true);
    expect(await pausedToday(db, new Date('2026-10-26T00:30:00Z'))).toBe(false);
  });
});

