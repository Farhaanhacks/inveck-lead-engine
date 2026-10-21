import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, settings } from '@/lib/db/schema';
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
});
