import 'server-only';
import { after } from 'next/server';
import { getDb } from '../db';
import { runSecret } from '../auth';
import { baseUrl, liveServices, RUN_MAX_DURATION } from '../run-driver';
import { errorMessage } from '../pipeline/text';
import { claimStalledTests, markTestPaused, runSourcingTest } from './test-run';

// Headroom under maxDuration for the step already under way when time is up.
const BUDGET_MS = (RUN_MAX_DURATION - 60) * 1000;

/**
 * Works on a sourcing test. On Vercel each invocation has a time limit, so a test that hasn't found
 * the prospects wanted hands itself to a fresh invocation and carries on; elsewhere it simply keeps going.
 * Vercel ends a long chain of invocations each calling the next (after a few): the test then waits, and
 * the page open on it picks it up again (see resumeStalledTests).
 */
export async function driveSourcingTest(id: number, origin: string) {
  const db = await getDb();
  const onVercel = !!process.env.VERCEL;
  const result = await runSourcingTest(db, await liveServices(), id, onVercel ? BUDGET_MS : Number.POSITIVE_INFINITY);
  if (result !== 'continue') return;
  try {
    const res = await fetch(`${baseUrl(origin)}/api/sourcing/${id}/continue`, { method: 'POST', headers: { 'x-run-secret': await runSecret() } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(`Sourcing test ${id}: could not continue: ${errorMessage(e)}`);
    await markTestPaused(db, id);
  }
}

/**
 * Sourcing tests running whose invocations stopped (the next couldn't be called, or one died): carried on
 * from this request, which starts a fresh chain. True when one was picked up.
 */
export async function resumeStalledTests(origin?: string): Promise<boolean> {
  try {
    const db = await getDb();
    const tests = await claimStalledTests(db);
    const base = baseUrl(origin);
    for (const t of tests) after(() => driveSourcingTest(t.id, base));
    return tests.length > 0;
  } catch (e) {
    console.error(`Picking up a stalled sourcing test: ${errorMessage(e)}`);
    return false;
  }
}
