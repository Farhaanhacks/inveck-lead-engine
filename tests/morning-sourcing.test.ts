import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, people, prospectSearches, runs, settings, users } from '@/lib/db/schema';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { DEFAULT_ICPS, LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { drawPool, morningStartsOn, runDailyDraw } from '@/lib/draw';
import { saveHolidays } from '@/lib/holidays';
import { executeRun, startRun } from '@/lib/runs';
import { settingsSchema, saveSettings } from '@/lib/settings';
import { istDay } from '@/lib/tasks';
import { beforeLastRound, MORNING_LIMITS, morningHealth, morningPlan, PEOPLE_FIRST_SOURCE, searchesThisMorning, type MorningSourcing } from '@/lib/sourcing/morning';
import type { FakeLog } from './fake-apis';
import { morningServices } from './morning-world';

/**
 * The 6 am run, people first: plant heads and other P1/P2 titles on LinkedIn, their companies'
 * LinkedIn pages, then research, then the 8 am draw. Google is a small made-up world: the "forging"
 * searches find three people, the "warehousing" ones one.
 */

let db: Db;
let log: FakeLog;

const services = (searched: string[] = []) => morningServices(log, searched);

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  log = { calls: [], verified: [], finder: [], apollo: [] };
  // One associate, one lead a day in each segment: the draw needs one of each.
  const team = await db.select().from(users).where(eq(users.role, 'bda')).orderBy(users.id);
  await db.update(users).set({ active: false }).where(inArray(users.id, team.slice(1).map((u) => u.id)));
  await saveSettings(db, settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1 }));
  // Already a lead: never added again.
  await db.insert(leads).values({ company: 'Known Gears', segment: MANUFACTURING, status: 'Disqualified' });
});

describe('the 6 am run, people first', () => {
  it('finds what the draw is short of, researches it, and the 8 am draw hands it out', async () => {
    const searched: string[] = [];
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    expect(await executeRun(db, run.id, services(searched), Number.POSITIVE_INFINITY)).toBe('done');

    const all = await db.select().from(leads);
    const by = Object.fromEntries(all.map((l) => [l.company, l]));
    // One company, one lead, with the person found as its contact, confirmed on LinkedIn.
    expect(by['Forgeline Components']).toMatchObject({
      segment: MANUFACTURING,
      status: 'Approved',
      contactName: 'Rahul Patil',
      contactTitle: 'Plant Head',
      city: 'Pune',
      website: expect.stringContaining('forgeline.in'),
      companyLinkedin: 'https://www.linkedin.com/company/forgeline-components',
    });
    expect(by['Forgeline Components'].source.startsWith(PEOPLE_FIRST_SOURCE)).toBe(true);
    expect(by['Forgeline Components'].contactVerifiedAt).not.toBeNull();
    expect(by['Forgeline Components'].emailBody).toBeTruthy();
    // Everyone found there is kept, on the lists.
    const found = await db.select().from(people).where(eq(people.leadId, by['Forgeline Components'].id));
    expect(found.map((p) => p.name)).toEqual(expect.arrayContaining(['Rahul Patil', 'Sunita Rao']));

    expect(by['Swift Warehousing Solutions']).toMatchObject({ segment: LOGISTICS, status: 'Approved', contactName: 'Deepak Nair' });
    // Too small on its LinkedIn page: never a lead. Already known: not added twice.
    expect(by['Tiny Tools']).toBeUndefined();
    expect(all.filter((l) => l.company === 'Known Gears')).toHaveLength(1);
    // Nothing for CA firms: they come from their sheet.
    expect(all.some((l) => /ca firm/i.test(l.segment))).toBe(false);

    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(finished.status).toBe('done');
    expect(finished.stats.prospectsAdded).toBe(2);
    const sourcing = finished.sourcing as MorningSourcing;
    // The draw needed one of each; it asked for a little more, for research to rule some out.
    expect(sourcing.history.filter((h) => h.round === 1).map((h) => [h.segment, h.wanted, h.added])).toEqual([
      [MANUFACTURING, 2, 1],
      [LOGISTICS, 2, 1],
    ]);
    // The draw is full after research, so it didn't search again.
    expect(sourcing.round).toBe(1);
    // Every search is remembered for the next runs.
    const remembered = await db.select().from(prospectSearches).where(eq(prospectSearches.runId, run.id));
    expect(remembered.length).toBeGreaterThan(0);
    expect(remembered.length).toBeLessThanOrEqual(sourcing.searches);

    expect((await drawPool(db)).bySegment).toEqual({ [MANUFACTURING]: 1, [LOGISTICS]: 1 });
    // The Dashboard's morning card shows it.
    const health = await morningHealth(db, settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1 }), new Set(), new Date(finished.startedAt));
    expect(health.run).toMatchObject({ id: run.id, status: 'done', added: 2, approved: 2, rounds: 1 });
    expect(health.segments.map((s) => [s.segment, s.need, s.ready, s.found, s.wanted])).toEqual([
      [MANUFACTURING, 1, 1, 1, 2],
      [LOGISTICS, 1, 1, 1, 2],
    ]);
    expect(health.searchesToday).toBe(sourcing.searches);
    // This small world ran out of new people before the search had what it wanted: a sign the market is thin.
    expect(health.thin).toEqual([expect.stringMatching(/^Manufacturing: 1 of the last 1 rounds stopped short/), expect.stringMatching(/^3PL & Logistics: 1 of the last 1 rounds/)]);

    // Tomorrow's draw (a new database counts today's as done).
    const draw = await runDailyDraw(db, { force: true, now: new Date(Date.now() + 86_400_000) });
    expect(draw?.drawn).toBe(2);
  });

  it("doesn't search when the draw already has enough waiting", async () => {
    await db.insert(leads).values(
      [MANUFACTURING, LOGISTICS].map((segment) => ({ company: `Ready ${segment}`, segment, status: 'Approved' as const, qualified: true, contactName: 'Asha Kulkarni', contactVerifiedAt: new Date() })),
    );
    const searched: string[] = [];
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    await executeRun(db, run.id, services(searched), Number.POSITIVE_INFINITY);
    expect(searched).toEqual([]);
    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(finished.stats.prospectsAdded).toBe(0);
  });

  it('never makes a search an earlier run made, and never adds a company twice', async () => {
    const first: string[] = [];
    const a = (await startRun(db, { findProspects: true, trigger: 'schedule' })).run;
    await executeRun(db, a.id, services(first), Number.POSITIVE_INFINITY);
    // The team took today's leads: the draw is short again tomorrow.
    await db.update(leads).set({ ownerId: 1 }).where(eq(leads.status, 'Approved'));
    const second: string[] = [];
    const b = (await startRun(db, { findProspects: true, trigger: 'schedule' })).run;
    await executeRun(db, b.id, services(second), Number.POSITIVE_INFINITY);
    expect(second.length).toBeGreaterThan(0);
    expect(second.filter((q) => first.includes(q))).toEqual([]);
    const names = (await db.select({ company: leads.company }).from(leads)).map((l) => l.company);
    expect(names.filter((n) => n === 'Forgeline Components')).toHaveLength(1);
  });

  it('carries on in a new invocation when out of time', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    // No time at all: each invocation still gets one step of the search further, saving where it got to.
    let steps = 0;
    for (; steps < 500; steps++) {
      expect(await executeRun(db, run.id, services(), 0)).toBe('continue');
      const [r] = await db.select().from(runs).where(eq(runs.id, run.id));
      if (r.prospectsDone) break;
    }
    expect(steps).toBeGreaterThan(1);
    expect(steps).toBeLessThan(500);
    // Then research, with time to finish.
    expect(await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY)).toBe('done');
    const names = (await db.select({ company: leads.company, status: leads.status }).from(leads)).filter((l) => l.company !== 'Known Gears');
    expect(names.map((l) => l.company).sort()).toEqual(['Forgeline Components', 'Swift Warehousing Solutions']);
    expect(names.every((l) => l.status === 'Approved')).toBe(true);
  });
});

describe('stopping the 6 am run', () => {
  it('ends the search where it is when the admin presses Stop', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, run.id));
    const searched: string[] = [];
    await executeRun(db, run.id, services(searched), Number.POSITIVE_INFINITY);
    const [r] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(r.status).toBe('cancelled');
    expect(searched).toEqual([]);
  });
});

describe('the search plan', () => {
  it('searches P1 titles, plant heads first, each with an industry word and a town, never twice', () => {
    const icp = DEFAULT_ICPS.find((i) => i.segment === MANUFACTURING)!;
    const plan = morningPlan(MANUFACTURING, icp, 7);
    expect(plan[0].title).toBe('Plant Head');
    expect(new Set(plan.map((q) => q.q)).size).toBe(plan.length);
    expect(plan.every((q) => q.q.startsWith('site:linkedin.com/in ') && q.keyword && q.place)).toBe(true);
    // A bare level ("General Manager", "DGM") isn't searched.
    expect(plan.some((q) => /"(General Manager|DGM)"/.test(q.q))).toBe(false);
    // Another run, another order.
    expect(morningPlan(MANUFACTURING, icp, 8).slice(0, 20).map((q) => q.q)).not.toEqual(plan.slice(0, 20).map((q) => q.q));
  });

  it('starts no new round after 7:30 am India time', () => {
    expect(beforeLastRound(new Date('2026-10-21T01:30:00Z'))).toBe(true); // 7:00 IST
    expect(beforeLastRound(new Date('2026-10-21T02:05:00Z'))).toBe(false); // 7:35 IST
    expect(MORNING_LIMITS.dailySearches).toBe(3000);
  });
});

describe('holidays', () => {
  it('the morning draw skips a holiday marked in Settings', async () => {
    await db.insert(leads).values({ company: 'Ready Co', segment: MANUFACTURING, status: 'Approved', qualified: true, contactName: 'Asha Kulkarni', contactVerifiedAt: new Date() });
    // A Wednesday, 8:30 am India time, far from the day the tests run (a new database counts today's draw as done).
    const morning = new Date('2030-01-09T03:00:00Z');
    await saveHolidays(db, [istDay(morning)]);
    expect(await runDailyDraw(db, { now: morning })).toBeNull();
    await saveHolidays(db, []);
    expect((await runDailyDraw(db, { now: morning }))?.drawn).toBe(1);
  });
});

describe('the day the morning search and draw start', () => {
  const setStart = (day: string) => db.insert(settings).values({ key: 'morningStartsOn', value: day }).onConflictDoUpdate({ target: settings.key, set: { value: day } });
  // Wednesday 9 and Thursday 10 January 2030, 8:30 am India time.
  const wed = new Date('2030-01-09T03:00:00Z');
  const thu = new Date('2030-01-10T03:00:00Z');

  it('is set on the live database only: a new one starts at once', async () => {
    expect(await morningStartsOn(db)).toBe('');
    // As on the live database, which already has its team: the go-live statement sets it.
    for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes("'morningStartsOn'"))) await db.execute(sql.raw(s));
    expect(await morningStartsOn(db)).toBe('2026-10-22');
  });

  it('before it, neither the 6 am search nor the 8 am draw runs; from it, both do', async () => {
    await setStart('2030-01-10');
    await db.insert(leads).values({ company: 'Ready Co', segment: MANUFACTURING, status: 'Approved', qualified: true, contactName: 'Asha Kulkarni', contactVerifiedAt: new Date() });
    const s = settingsSchema.parse({});
    expect(await searchesThisMorning(db, s, wed)).toBe(false);
    expect(await searchesThisMorning(db, s, thu)).toBe(true);
    expect(await runDailyDraw(db, { now: wed })).toBeNull();
    expect((await db.select().from(leads).where(eq(leads.company, 'Ready Co')))[0].ownerId).toBeNull();
    expect((await runDailyDraw(db, { now: thu }))?.drawn).toBe(1);
  });

  it('an admin can still draw by hand before it', async () => {
    await setStart('2030-01-10');
    await db.insert(leads).values({ company: 'Ready Co', segment: MANUFACTURING, status: 'Approved', qualified: true, contactName: 'Asha Kulkarni', contactVerifiedAt: new Date() });
    expect((await runDailyDraw(db, { now: wed, force: true }))?.drawn).toBe(1);
  });

  it('never searches at the weekend, on a holiday, or when turned off', async () => {
    const s = settingsSchema.parse({});
    expect(await searchesThisMorning(db, s, new Date('2030-01-12T00:30:00Z'))).toBe(false); // Saturday
    await saveHolidays(db, ['2030-01-10']);
    expect(await searchesThisMorning(db, s, thu)).toBe(false);
    await saveHolidays(db, []);
    expect(await searchesThisMorning(db, settingsSchema.parse({ morningSearch: false }), thu)).toBe(false);
  });

  it("the Dashboard card says when it starts", async () => {
    await setStart('2030-01-10');
    const h = await morningHealth(db, settingsSchema.parse({}), new Set(), wed);
    expect(h).toMatchObject({ off: 'not_started', startsOn: '2030-01-10', run: null });
  });
});
