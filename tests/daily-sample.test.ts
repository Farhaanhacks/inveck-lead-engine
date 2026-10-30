import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, runs, settings, sourcingTests, users } from '@/lib/db/schema';
import { settingsSchema, saveSettings } from '@/lib/settings';
import { saveHolidays } from '@/lib/holidays';
import { runSourcingTest } from '@/lib/sourcing/test-run';
import { assignSampleLeads, cardLead, quotaFor, startScheduledSample, TOP_UP_SAMPLES, type MorningSampleReport, type MorningSampleStart } from '@/lib/sourcing/sample-run';
import { istDay } from '@/lib/tasks';
import { MANUFACTURING } from '@/lib/db/seed';
import type { FakeLog } from './fake-apis';
import { morningServices } from './morning-world';
import { legacyAllocation } from './legacy-allocation';
import { noteWake, wakeUps } from '@/lib/sourcing/wake';

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
  it('none on Monday 26 October nor Tuesday 27 (stopped: its lists were filled the evening before); from Wednesday at 6 am India time, for that day, once a day, not from 2 pm', async () => {
    for (const t of ['06:00', '07:30', '12:00']) expect(await startScheduledSample(db, ist('2026-10-26', t))).toBeNull();
    for (const t of ['06:00', '06:05', '08:00', '13:00']) expect(await startScheduledSample(db, ist('2026-10-27', t))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-10-28', '05:59'))).toBeNull();
    const id = await startScheduledSample(db, ist('2026-10-28', '06:00'));
    expect(id).toBeGreaterThan(0);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id!));
    expect(row).toMatchObject({ mode: 'morning', status: 'running', report: { fresh: false, assign: true, day: '2026-10-28' } });
    // Every later check that day starts nothing more.
    expect(await startScheduledSample(db, ist('2026-10-28', '06:10'))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-10-28', '09:00'))).toBeNull();
    // The next day has its own, up to 2 pm.
    expect(await startScheduledSample(db, ist('2026-10-29', '14:00'))).toBeNull();
    const thursday = await startScheduledSample(db, ist('2026-10-29', '13:59'));
    expect(thursday).toBeGreaterThan(id!);
    expect(((await db.select().from(sourcingTests).where(eq(sourcingTests.id, thursday!)))[0].report as MorningSampleStart).day).toBe('2026-10-29');
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
    // That morning (its leads are given out for the day, or today when the day has passed).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-28', '06:05'));
    try {
      await dayRun();
    } finally {
      vi.useRealTimers();
    }
  });
  const dayRun = async () => {
    const puja = await person('Puja');
    await db.insert(leads).values({ company: 'Already Given Co', segment: MANUFACTURING, status: 'Approved', ownerId: puja.id, drawnOn: '2026-10-28' });
    const id = (await startScheduledSample(db, ist('2026-10-28', '06:05')))!;
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row).toMatchObject({ status: 'done', error: '' });
    const r = await reportOf(id);
    expect(r.day).toBe('2026-10-28');
    expect(quotaFor(r, puja.id)[MANUFACTURING]).toBe(0);
    expect(r.start[MANUFACTURING].need).toBe(1);
    expect(r.assigned?.day).toBe('2026-10-28');
    // Nobody over their list for the day.
    const given = await db.select().from(leads).where(eq(leads.drawnOn, '2026-10-28'));
    for (const owner of new Set(given.map((l) => l.ownerId))) for (const s of [MANUFACTURING, '3PL & Logistics']) expect(given.filter((l) => l.ownerId === owner && l.segment === s).length).toBeLessThanOrEqual(1);
    expect(given.filter((l) => l.ownerId === puja.id && l.segment === MANUFACTURING).map((l) => l.company)).toEqual(['Already Given Co']);
  };
});

describe('the one-off top-up (28 Oct, 10:15 pm)', () => {
  it("starts once from 10:15 pm India time, for Thursday 29 October's lists, after the 9 pm run has had its turn", async () => {
    // The 9 pm run for Thursday has run.
    await db.insert(settings).values({ key: 'scheduledSample:evening:2026-10-29', value: { claimedAt: ist('2026-10-28', '21:00').toISOString(), testId: 1 } });
    expect(await startScheduledSample(db, ist('2026-10-28', '22:10'))).toBeNull();
    const id = (await startScheduledSample(db, ist('2026-10-28', '22:16')))!;
    expect(id).toBeGreaterThan(0);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row.report).toMatchObject({ mode: 'morning', phase: 'init', fresh: false, assign: true, day: '2026-10-29' });
    // Once; and not more than three hours late.
    expect(await startScheduledSample(db, ist('2026-10-28', '22:30'))).toBeNull();
    // And again at 12:30 am on Thursday, for the same lists.
    expect(await startScheduledSample(db, ist('2026-10-29', '00:25'))).toBeNull();
    const again = (await startScheduledSample(db, ist('2026-10-29', '00:31')))!;
    expect(again).toBeGreaterThan(id);
    const [second] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, again));
    expect(second.report).toMatchObject({ mode: 'morning', assign: true, day: '2026-10-29' });
    expect(await startScheduledSample(db, ist('2026-10-29', '00:40'))).toBeNull();
    expect(TOP_UP_SAMPLES.filter(({ day }) => day === '2026-10-29').every(({ at }) => Date.parse(at) + 3 * 3600_000 < Date.parse(ist('2026-10-29', '06:00').toISOString()))).toBe(true);
  });

  it("30 Oct: starts once from 8:40 am India time, for Friday 30 October's lists, after the 6 am run", async () => {
    await db.insert(settings).values({ key: 'scheduledSample:daily:2026-10-30', value: { claimedAt: ist('2026-10-30', '06:00').toISOString(), testId: 1 } });
    expect(await startScheduledSample(db, ist('2026-10-30', '08:35'))).toBeNull();
    const id = (await startScheduledSample(db, ist('2026-10-30', '08:41')))!;
    expect(id).toBeGreaterThan(0);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row.report).toMatchObject({ mode: 'morning', phase: 'init', fresh: false, assign: true, day: '2026-10-30' });
    expect(await startScheduledSample(db, ist('2026-10-30', '09:00'))).toBeNull();
  });
});

describe('giving out a sample', () => {
  it("never gives anyone more than their list for the day: what the draw already gave counts, and the rest waits in the pool", async () => {
    const start: MorningSampleStart = { mode: 'morning', phase: 'init', fresh: false };
    const [test] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, report: start }).returning();
    await runSourcingTest(db, morningServices(log), test.id, Number.POSITIVE_INFINITY);
    const r = await reportOf(test.id);
    expect(r.phase).toBe('done');
    // Whoever was dealt a Manufacturing lead (the made-up world has too few for everyone since both segments' screens
    // are strict, so who gets it varies).
    const hand = r.hands.find((h) => h.cards.some((c) => cardLead(r, c)?.lead.segment === MANUFACTURING))!;
    const handMfg = hand.cards.filter((c) => cardLead(r, c)?.lead.segment === MANUFACTURING);
    expect(handMfg.length).toBe(1);
    // The draw gave them their one Manufacturing lead for that morning before the sample's were given out.
    const day = r.day > istDay() ? r.day : istDay();
    await db.insert(leads).values({ company: 'Drawn Co', segment: MANUFACTURING, status: 'Approved', ownerId: hand.userId, drawnOn: day });
    const assigned = (await assignSampleLeads(db, test.id))!;
    expect(assigned.pooled).toBe(1);
    const mine = await db.select().from(leads).where(and(eq(leads.ownerId, hand.userId), eq(leads.drawnOn, day)));
    expect(mine.filter((l) => l.segment === MANUFACTURING).map((l) => l.company)).toEqual(['Drawn Co']);
    // Their sample lead is in the pipeline, approved and nobody's, for the next draw.
    const card = handMfg[0];
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
      expect((await wakeUps(db)).vercel).toMatchObject({ by: 'the 6 am job', at: ist('2026-10-26', '06:00').toISOString() });
    } finally {
      vi.useRealTimers();
      delete process.env.CRON_SECRET;
    }
  });
});

describe('what wakes the daily run (26 Oct)', () => {
  it('keeps the latest wake-up of each kind, for the Sourcing page', async () => {
    expect(await wakeUps(db)).toEqual({});
    await noteWake(db, 'vercel', 'the 6 am job', ist('2026-10-27', '06:00'));
    await noteWake(db, 'timer', 'the outside timer', ist('2026-10-27', '06:05'));
    await noteWake(db, 'vercel', 'a 10-minute check', ist('2026-10-27', '06:10'));
    expect(await wakeUps(db)).toEqual({
      vercel: { by: 'a 10-minute check', at: ist('2026-10-27', '06:10').toISOString() },
      timer: { by: 'the outside timer', at: ist('2026-10-27', '06:05').toISOString() },
    });
  });

  it('the outside timer is noted as the timer, and on a working day from 6 am it starts the day\'s run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-28', '06:04'));
    process.env.CRON_SECRET = 'vercel-cron-secret-value';
    process.env.INBOUND_SYNC_SECRET = 'outside-timer-secret-0123456789';
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    try {
      const { GET } = await import('@/app/api/cron/inbound-demos/route');
      const call = (auth: string) => GET(new Request('https://x/api/cron/inbound-demos', { headers: { authorization: auth } }));
      const vercel = await call('Bearer vercel-cron-secret-value');
      expect(vercel.status).toBe(200);
      expect((await wakeUps(db)).vercel?.by).toBe('the daily inbound sync');
      // Vercel's call started it (in a test there's no request to drive it from; a later wake-up carries it on); the
      // timer's call doesn't start a second one.
      expect(await db.select().from(sourcingTests)).toHaveLength(1);
      const timer = await call('Bearer outside-timer-secret-0123456789');
      expect(timer.status).toBe(200);
      expect((await wakeUps(db)).timer).toMatchObject({ by: 'the outside timer', at: ist('2026-10-28', '06:04').toISOString() });
      expect(await db.select().from(sourcingTests)).toHaveLength(1);
      expect((await db.select().from(sourcingTests))[0].report).toMatchObject({ day: '2026-10-28', assign: true });
      expect((await call('Bearer wrong')).status).toBe(403);
    } finally {
      vi.useRealTimers();
      delete process.env.CRON_SECRET;
      delete process.env.INBOUND_SYNC_SECRET;
    }
  });

  it("Vercel's checks run every 10 minutes from 6:10 to 11:00 am India time on weekdays, each once a day", () => {
    const crons = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] }).crons;
    const checks = crons.filter((c) => c.path === '/api/cron/resume').map((c) => c.schedule);
    // Hobby plans run each job at most once a day: minute and hour are fixed numbers.
    expect(checks.every((c) => /^\d+ \d+ \* \* 1-5$/.test(c))).toBe(true);
    const ist = checks.map((c) => {
      const [m, h] = c.split(' ').map(Number);
      const t = h * 60 + m + 330;
      return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    });
    const want: string[] = [];
    for (let t = 6 * 60 + 10; t <= 11 * 60; t += 10) if (t !== 8 * 60) want.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    expect(ist).toEqual(want);
    // 8:00 is the draw, which wakes it too.
    expect(crons.find((c) => c.path === '/api/cron/draw')?.schedule).toBe('30 2 * * 1-5');
  });

  it('opening Today wakes it, as it starts the CA draw', () => {
    const today = readFileSync('src/app/(app)/today/page.tsx', 'utf8');
    expect(today).toContain("await noteWake(db, 'page', 'Today');");
    expect(today).toContain('await wakeDailyRun(db, await requestOrigin());');
  });
});

describe("Monday's evening run (26 Oct, 8 pm)", () => {
  it("starts on its own from 8 pm India time, once, for Tuesday's lists, given out when it finishes; no 6 am run on Tuesday", async () => {
    expect(await startScheduledSample(db, ist('2026-10-26', '19:59'))).toBeNull();
    const id = await startScheduledSample(db, ist('2026-10-26', '20:03'));
    expect(id).toBeGreaterThan(0);
    expect(await startScheduledSample(db, ist('2026-10-26', '20:08'))).toBeNull();
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id!));
    expect(row).toMatchObject({ mode: 'morning', status: 'running', report: { fresh: false, assign: true } });
    expect((row.report as MorningSampleStart).day).toBeUndefined();
    // Tuesday's lists were filled that evening: no 6 am run on Tuesday (the 8 am draw still runs).
    expect(await startScheduledSample(db, ist('2026-10-27', '06:02'))).toBeNull();
    expect(await db.select().from(sourcingTests)).toHaveLength(1);
  });
});

describe('the evening run (from Tuesday 27 Oct, 9 pm)', () => {
  it("starts on its own from 9 pm India time, once, for the next day's lists, given out when it finishes; that morning's 6 am run then fills only what is still missing", async () => {
    expect(await startScheduledSample(db, ist('2026-10-27', '20:59'))).toBeNull();
    const id = await startScheduledSample(db, ist('2026-10-27', '21:04'));
    expect(id).toBeGreaterThan(0);
    expect(await startScheduledSample(db, ist('2026-10-27', '21:09'))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-10-27', '23:55'))).toBeNull();
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id!));
    expect(row).toMatchObject({ mode: 'morning', status: 'running', report: { fresh: false, assign: true, day: '2026-10-28' } });
    // Wednesday's Manufacturing lists filled that night: the 6 am run is for that same day and leaves out what everyone has.
    const puja = await person('Puja');
    const parimal = await person('Parimal');
    await db.insert(leads).values([
      { company: 'Evening Mfg A', segment: MANUFACTURING, status: 'Approved', ownerId: puja.id, drawnOn: '2026-10-28' },
      { company: 'Evening Mfg B', segment: MANUFACTURING, status: 'Approved', ownerId: parimal.id, drawnOn: '2026-10-28' },
    ]);
    const morning = (await startScheduledSample(db, ist('2026-10-28', '06:02')))!;
    await runSourcingTest(db, morningServices(log), morning, Number.POSITIVE_INFINITY);
    const r = await reportOf(morning);
    expect(r.day).toBe('2026-10-28');
    expect(r.start[MANUFACTURING]).toMatchObject({ need: 0, wanted: 0 });
  });

  it('every evening before a working day: Wednesday and Thursday; Sunday for Monday, none on Friday or Saturday; not on Monday 26', async () => {
    const dayOf = async (id: number | null) => ((await db.select().from(sourcingTests).where(eq(sourcingTests.id, id!)))[0].report as MorningSampleStart).day;
    // Monday 26's 8 pm run is its own (SCHEDULED_SAMPLES); no evening run besides it.
    expect(await startScheduledSample(db, ist('2026-10-26', '23:30'))).toBeNull();
    expect(await dayOf(await startScheduledSample(db, ist('2026-10-28', '21:00')))).toBe('2026-10-29');
    expect(await dayOf(await startScheduledSample(db, ist('2026-10-29', '21:00')))).toBe('2026-10-30');
    expect(await startScheduledSample(db, ist('2026-10-30', '21:00'))).toBeNull();
    expect(await startScheduledSample(db, ist('2026-10-31', '21:00'))).toBeNull();
    expect(await dayOf(await startScheduledSample(db, ist('2026-11-01', '21:00')))).toBe('2026-11-02');
  });

  it('not before a holiday or a paused day, nor on a paused evening, nor with the morning search off', async () => {
    await saveHolidays(db, ['2026-10-28']);
    expect(await startScheduledSample(db, ist('2026-10-27', '21:00'))).toBeNull();
    await db.delete(settings).where(eq(settings.key, 'pausedDays'));
    await db.insert(settings).values({ key: 'pausedDays', value: ['2026-10-29'] });
    expect(await startScheduledSample(db, ist('2026-10-28', '21:00'))).toBeNull();
    await db.update(settings).set({ value: ['2026-11-01'] }).where(eq(settings.key, 'pausedDays'));
    expect(await startScheduledSample(db, ist('2026-11-01', '21:00'))).toBeNull();
    await saveSettings(db, settingsSchema.parse({ ...quota, morningSearch: false }));
    expect(await startScheduledSample(db, ist('2026-11-02', '21:00'))).toBeNull();
    await saveSettings(db, settingsSchema.parse(quota));
    expect(await startScheduledSample(db, ist('2026-11-02', '21:00'))).toBeGreaterThan(0);
    expect(await db.select().from(sourcingTests)).toHaveLength(1);
  });
});
