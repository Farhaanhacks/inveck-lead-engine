import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { runs, sourcingTests } from '@/lib/db/schema';
import { activeRun, claimStalledRun, markRunPaused, startRun } from '@/lib/runs';
import { activeSourcingTest, canCarryOn, claimStalledTests, markTestPaused, reopenTest } from '@/lib/sourcing/test-run';
import { RESUME_AFTER_MS } from '@/lib/invocations';

/**
 * Vercel ends a long chain of invocations each calling the next (508 INFINITE_LOOP_DETECTED after a few).
 * A run or test that stalls that way waits, and the next fresh request picks it up again, once.
 */

let db: Db;
const ago = (ms: number) => new Date(Date.now() - ms);
const MIN = 60_000;

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

describe('a run whose chain of invocations stopped', () => {
  it('is picked up again once nothing can still be working on it, by one caller only', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    // Still working (a heartbeat a minute ago): left alone.
    await db.update(runs).set({ heartbeatAt: ago(MIN) }).where(eq(runs.id, run.id));
    expect(await claimStalledRun(db)).toBeNull();
    // Nothing has worked on it for longer than an invocation can last: claimed, and only once.
    await db.update(runs).set({ heartbeatAt: ago(RESUME_AFTER_MS + 1000) }).where(eq(runs.id, run.id));
    const [a, b] = await Promise.all([claimStalledRun(db), claimStalledRun(db)]);
    expect([a, b].filter(Boolean).map((r) => r!.id)).toEqual([run.id]);
    expect(await claimStalledRun(db)).toBeNull();
  });

  it('is ready at once when its next invocation could not be called', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    expect(await claimStalledRun(db)).toBeNull();
    await markRunPaused(db, run.id);
    expect((await claimStalledRun(db))?.id).toBe(run.id);
  });

  it('stays the running one for 45 minutes, so it can be picked up; after that it is closed', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    await db.update(runs).set({ heartbeatAt: ago(20 * MIN) }).where(eq(runs.id, run.id));
    expect((await activeRun(db))?.id).toBe(run.id);
    // A new run isn't started over it.
    expect((await startRun(db, { findProspects: false, trigger: 'auto' })).created).toBe(false);
    await db.update(runs).set({ heartbeatAt: ago(50 * MIN) }).where(eq(runs.id, run.id));
    expect(await claimStalledRun(db)).toBeNull();
    expect(await activeRun(db)).toBeUndefined();
    expect((await db.select().from(runs).where(eq(runs.id, run.id)))[0].status).toBe('failed');
  });

  it('a finished run is never picked up', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'schedule' });
    await db.update(runs).set({ status: 'done', heartbeatAt: ago(10 * MIN) }).where(eq(runs.id, run.id));
    expect(await claimStalledRun(db)).toBeNull();
  });
});

describe('a sourcing test or sample whose chain of invocations stopped', () => {
  const insert = async (values: Partial<typeof sourcingTests.$inferInsert> = {}) =>
    (await db.insert(sourcingTests).values({ segment: 'Manufacturing', mode: 'morning', companies: 0, ...values }).returning())[0];

  it('waits, then the page open on it picks it up again, once', async () => {
    const t = await insert();
    expect(await claimStalledTests(db)).toEqual([]);
    await markTestPaused(db, t.id);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, t.id));
    expect(row.status).toBe('running');
    expect(row.progress).toMatch(/carries on by itself while this page is open/);
    expect((await claimStalledTests(db)).map((x) => x.id)).toEqual([t.id]);
    expect(await claimStalledTests(db)).toEqual([]);
  });

  it('is never given up on while anything can still wake it: two hours later it is picked up, not closed', async () => {
    const twoHours = new Date(Date.now() - 2 * 3600_000);
    const t = await insert({ startedAt: twoHours, updatedAt: twoHours });
    expect(await activeSourcingTest(db, 'morning')).toMatchObject({ id: t.id, status: 'running' });
    expect((await claimStalledTests(db)).map((x) => x.id)).toEqual([t.id]);
    // Only after six hours with nothing waking it is it closed as stopped (and it can still carry on from there).
    const sevenHours = new Date(Date.now() - 7 * 3600_000);
    await db.update(sourcingTests).set({ updatedAt: sevenHours }).where(eq(sourcingTests.id, t.id));
    expect(await activeSourcingTest(db, 'morning')).toBeNull();
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, t.id));
    expect(row.status).toBe('failed');
    expect(canCarryOn(row)).toBe(true);
  });

  it('one stopped for the server\'s time can carry on from where it got to; one that failed on its own cannot', async () => {
    const stopped = await insert({ status: 'failed', error: "Could not carry on after the server's time limit: 508 Infinite loop detected INFINITE_LOOP_DETECTED. The report shows what it got to." });
    const timedOut = await insert({ status: 'failed', error: "Stopped before finishing (the server's time limit). The report shows what it got to." });
    const google = await insert({ status: 'failed', error: 'Google search failed: 400 Query pattern not allowed for free accounts.' });
    expect([stopped, timedOut, google].map(canCarryOn)).toEqual([true, true, false]);
    expect(await reopenTest(db, google.id)).toBe(false);
    expect(await reopenTest(db, stopped.id)).toBe(true);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, stopped.id));
    expect(row).toMatchObject({ status: 'running', error: '', finishedAt: null });
    // Once only.
    expect(await reopenTest(db, stopped.id)).toBe(false);
  });
});
