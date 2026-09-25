import 'server-only';
import { getDb } from './db';
import { apiKeys, getSettings } from './settings';
import { executeRun } from './runs';
import { runSecret } from './auth';
import type { Services } from './pipeline/services';
import { errorMessage } from './pipeline/text';

/** Seconds a run invocation may take; route files export the same value as `maxDuration`. */
export const RUN_MAX_DURATION = 300;
// Leave headroom under maxDuration so a batch that's already started can finish.
const BUDGET_MS = (RUN_MAX_DURATION - 90) * 1000;

export async function liveServices(): Promise<Services> {
  const db = await getDb();
  return { fetch: globalThis.fetch.bind(globalThis), keys: apiKeys(), settings: await getSettings(db) };
}

/** The app's own URL, for a run to call its next invocation. */
export function baseUrl(requestOrigin?: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (requestOrigin) return requestOrigin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

/**
 * Works on a run. On Vercel each invocation has a time limit, so when there's more to
 * do the run hands itself to a fresh invocation; elsewhere it simply keeps going.
 */
export async function driveRun(runId: number, origin: string) {
  const db = await getDb();
  const onVercel = !!process.env.VERCEL;
  const result = await executeRun(db, runId, await liveServices(), onVercel ? BUDGET_MS : Number.POSITIVE_INFINITY);
  if (result !== 'continue') return;
  try {
    const res = await fetch(`${baseUrl(origin)}/api/runs/${runId}/continue`, {
      method: 'POST',
      headers: { 'x-run-secret': await runSecret() },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(`Run ${runId}: could not continue: ${errorMessage(e)}`);
  }
}
