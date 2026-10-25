import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, runs, settings, sourcingTests, users } from '@/lib/db/schema';
import { settingsSchema, saveSettings } from '@/lib/settings';
import { saveHolidays } from '@/lib/holidays';
import { runSourcingTest } from '@/lib/sourcing/test-run';
import { assignSampleLeads, cardLead, quotaFor, startScheduledSample, type MorningSampleReport, type MorningSampleStart } from '@/lib/sourcing/sample-run';
import { istDay } from '@/lib/tasks';
import { MANUFACTURING } from '@/lib/db/seed';
import type { FakeLog } from './fake-apis';
import { morningServices } from './morning-world';
import { legacyAllocation } from './legacy-allocation';

/** INVECK's daily run from Tuesday 27 October 2026: a Morning Sample for that day's lists at 6 am, given out on its own. */

let db: Db;
let log: FakeLog;
const quota = { manufacturingPerAssociate: 1, logisticsPerAssociate: 1 };
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  await legacyAllocation(db);
  log = { calls: [], verified: [], finder: [], apollo: [] };
  const team = await db.select().from(users).where(eq(users.role, 'bda')).orderBy(users.id);
  await db.update(users).set({ active: false }).where(inArray(users.id, team.filter((u) => !['Puja', 'Parimal'].includes(u.name)).map((u) => u.id)));
  await saveSettings(db, settingsSchema.parse(quota));
});

const reportOf = async (id: number) => (await db.select().from(sourcingTests).where(eq(sourcingTests.id, id)))[0].report as MorningSampleReport;
const person = async (name: string) => (await db.select().from(users).where(eq(users.name, name)))[0];

describe('the daily run', () => {
  it('none on Monday 26 October; from Tuesday at 6 am India time, for that day, once a day, not from 2 pm', async () => {
    for (const t of ['06:00', '07:30', '12:00']) expect(await startScheduledSample(db, ist('2026-10-26', t))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-10-27', '05:59'))).toBeNull();
    const id = await startScheduledSample(db, ist('2026-10-27', '06:00'));
    expect(id).toBeGreaterThan(0);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id!));
    expect(row).toMatchObject({ mode: 'morning', status: 'running', report: { fresh: false, assign: true, day: '2026-10-27' } });
    // Every later check that day starts nothing more.
    expect(await startScheduledSample(db, ist('2026-10-27', '06:10'))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-10-27', '09:00'))).toBeNull();
    // The next day has its own, up to 2 pm.
    expect(await startScheduledSample(db, ist('2026-10-28', '14:00'))).toBeNull();
    const wednesday = await startScheduledSample(db, ist('2026-10-28', '13:59'));
    expect(wednesday).toBeGreaterThan(id!);
    expect(((await db.select().from(sourcingTests).where(eq(sourcingTests.id, wednesday!)))[0].report as MorningSampleStart).day).toBe('2026-10-28');
  });

  it('not on a weekend, a holiday, a paused day, or with the morning search off in Settings', async () => {
    expect(await startScheduledSample(db, ist('2026-10-31', '06:10'))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-11-01', '06:10'))).toBeNull();
    await saveHolidays(db, ['2026-11-02']);
    expect(await startScheduledSample(db, ist('2026-11-02', '06:10'))).toBeNull();
    await db.delete(settings).where(eq(settings.key, 'pausedDays'));
    await db.insert(settings).values({ key: 'pausedDays', value: ['2026-11-03'] });
    expect(await startScheduledSample(db, ist('2026-11-03', '06:10'))).toBeNull();
    await saveSettings(db, settingsSchema.parse({ ...quota, morningSearch: false }));
    expect(await startScheduledSample(db, ist('2026-11-04', '06:10'))).toBeNull();
    await saveSettings(db, settingsSchema.parse(quota));
    expect(await startScheduledSample(db, ist('2026-11-04', '06:10'))).toBeGreaterThan(0);
    expect(await db.select().from(sourcingTests)).toHaveLength(1);
  });

  it("is for that day's lists, leaving out what anyone already has for it, and gives its leads out when it finishes", async () => {
    const puja = await person('Puja');
    await db.insert(leads).values({ company: 'Already Given Co', segment: MANUFACTURING, status: 'Approved', ownerId: puja.id, drawnOn: '2026-10-27' });
    const id = (await startScheduledSample(db, ist('2026-10-27', '06:05')))!;
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row).toMatchObject({ status: 'done', error: '' });
    const r = await reportOf(id);
    expect(r.day).toBe('2026-10-27');
    expect(quotaFor(r, puja.id)[MANUFACTURING]).toBe(0);
    expect(r.start[MANUFACTURING].need).toBe(1);
    expect(r.assigned?.day).toBe('2026-10-27');
    // Nobody over their list for the day.
    const given = await db.select().from(leads).where(eq(leads.drawnOn, '2026-10-27'));
    for (const owner of new Set(given.map((l) => l.ownerId))) for (const s of [MANUFACTURING, '3PL & Logistics']) expect(given.filter((l) => l.ownerId === owner && l.segment === s).length).toBeLessThanOrEqual(1);
    expect(given.filter((l) => l.ownerId === puja.id && l.segment === MANUFACTURING).map((l) => l.company)).toEqual(['Already Given Co']);
  });
});

describe('giving out a sample', () => {
  it("never gives anyone more than their list for the day: what the draw already gave counts, and the rest waits in the pool", async () => {
    const start: MorningSampleStart = { mode: 'morning', phase: 'init', fresh: false };
    const [test] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, report: start }).returning();
    await runSourcingTest(db, morningServices(log), test.id, Number.POSITIVE_INFINITY);
    const r = await reportOf(test.id);
    expect(r.phase).toBe('done');
    const puja = await person('Puja');
    const hand = r.hands.find((h) => h.userId === puja.id)!;
    const pujaMfg = hand.cards.filter((c) => cardLead(r, c)?.lead.segment === MANUFACTURING);
    expect(pujaMfg.length).toBe(1);
    // The draw gave Puja her one Manufacturing lead for that morning before the sample's were given out.
    const day = r.day > istDay() ? r.day : istDay();
    await db.insert(leads).values({ company: 'Drawn Co', segment: MANUFACTURING, status: 'Approved', ownerId: puja.id, drawnOn: day });
    const assigned = (await assignSampleLeads(db, test.id))!;
    expect(assigned.pooled).toBe(1);
    const mine = await db.select().from(leads).where(and(eq(leads.ownerId, puja.id), eq(leads.drawnOn, day)));
    expect(mine.filter((l) => l.segment === MANUFACTURING).map((l) => l.company)).toEqual(['Drawn Co']);
    // Her sample lead is in the pipeline, approved and nobody's, for the next draw.
    const card = pujaMfg[0];
    const leadId = card.from === 'sample' ? (await reportOf(test.id)).companies.find((c) => c.key === card.key)?.pushed : card.key;
    const [waiting] = await db.select().from(leads).where(eq(leads.id, leadId!));
    expect(waiting).toMatchObject({ status: 'Approved', ownerId: null });
    // Everyone else got theirs as dealt.
    expect(assigned.given.reduce((a, g) => a + g.leads, 0)).toBe(r.hands.reduce((a, h) => a + h.cards.length, 0) - 1);
  });
});

describe('the 6 am job', () => {
  it('starts no run on Monday 26 October: from then on the daily sample takes its place', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-26', '06:00'));
    process.env.CRON_SECRET = 'vercel-cron-secret-value';
    try {
      const { GET } = await import('@/app/api/cron/route');
      const res = await GET(new Request('https://x/api/cron', { headers: { authorization: 'Bearer vercel-cron-secret-value' } }));
      expect(await res.json()).toMatchObject({ started: null, resumed: { tests: false } });
      expect(await db.select().from(runs)).toHaveLength(0);
      expect(await db.select().from(sourcingTests)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      delete process.env.CRON_SECRET;
    }
  });
});
