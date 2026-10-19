import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { sourcingTests } from '../db/schema';
import { runSecret } from '../auth';
import { baseUrl, liveServices, RUN_MAX_DURATION } from '../run-driver';
import { errorMessage } from '../pipeline/text';
import { runSourcingTest } from './test-run';

// Headroom under maxDuration for the step already under way when time is up.
const BUDGET_MS = (RUN_MAX_DURATION - 60) * 1000;

/**
 * Works on a sourcing test. On Vercel each invocation has a time limit, so a test that hasn't found
 * the prospects wanted hands itself to a fresh invocation and carries on; elsewhere it simply keeps going.
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
    await db
      .update(sourcingTests)
      .set({ status: 'failed', error: `Could not carry on after the server's time limit: ${errorMessage(e)}. The report shows what it got to.`, finishedAt: new Date() })
      .where(eq(sourcingTests.id, id));
  }
}
