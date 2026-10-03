import 'server-only';
import { getDb } from './db';
import { apiKeys, getSettings } from './settings';
import { dbEnrichmentCache } from './enrichment-cache';
import { activeRun, executeRun, startRun } from './runs';
import { desc, eq, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { leads, runs } from './db/schema';
import { runSecret } from './auth';
import type { Services } from './pipeline/services';
import { errorMessage } from './pipeline/text';

/** Seconds a run invocation may take; route files export the same value as `maxDuration`. */
export const RUN_MAX_DURATION = 300;
// Leave headroom under maxDuration so a batch that's already started can finish.
const BUDGET_MS = (RUN_MAX_DURATION - 90) * 1000;

export async function liveServices(): Promise<Services> {
  const db = await getDb();
  // Paid lookups (Apollo) are cached in the database, so a person is never paid for twice.
  return { fetch: globalThis.fetch.bind(globalThis), keys: apiKeys(), settings: await getSettings(db), cache: dbEnrichmentCache(db) };
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

/**
 * The safety net behind "everything in Leads gets researched": if companies are waiting and
 * nothing is running, start research in the background. Pages call this when they load.
 * A run that started in the last 5 minutes and left companies waiting (e.g. a missing API
 * key) isn't retried on every page view.
 */
export async function ensureResearch(origin: string): Promise<void> {
  try {
    const db = await getDb();
    const [{ waiting }] = await db
      .select({ waiting: sql<number>`count(*)::int` })
      .from(leads)
      .where(eq(leads.status, 'New'));
    if (!waiting || (await activeRun(db))) return;
    const [last] = await db.select().from(runs).orderBy(desc(runs.id)).limit(1);
    if (last && Date.now() - new Date(last.startedAt).getTime() < 5 * 60 * 1000) return;
    const { run, created } = await startRun(db, { findProspects: false, trigger: 'auto' });
    if (created) after(() => driveRun(run.id, origin));
  } catch {}
}

/** This deployment's address, from the current request. */
export async function requestOrigin(): Promise<string> {
  const { headers } = await import('next/headers');
  const h = await headers();
  return `${h.get('x-forwarded-proto') || 'http'}://${h.get('host')}`;
}

/** Companies whose contacts are waiting to be found again after the contacts reset. */
export async function refetchProgress(): Promise<{ waiting: number; resetAt: string | null; recent: boolean }> {
  const db = await getDb();
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.refetchPending, true));
  const reset = await db.execute(sql`SELECT value FROM settings WHERE key = 'contactsResetV1'`);
  const value = (Array.isArray(reset) ? reset[0] : (reset as { rows: { value: unknown }[] }).rows[0])?.value as { at?: string } | undefined;
  const resetAt = value?.at ?? null;
  // The "done" note shows for three days after the reset.
  return { waiting: Number(row?.n ?? 0), resetAt, recent: !!resetAt && Date.now() - new Date(resetAt).getTime() < 3 * 86_400_000 };
}

/** Starts a run when contacts are waiting to be found again and nothing is running, so it doesn't wait for 6 am. */
export async function startRefetchIfWaiting(origin?: string) {
  const { waiting } = await refetchProgress();
  if (!waiting) return;
  const db = await getDb();
  if (await activeRun(db)) return;
  // Not again straight after a run that just ended or was stopped.
  const [last] = await db.select().from(runs).orderBy(desc(runs.id)).limit(1);
  if (last && Date.now() - new Date(last.finishedAt ?? last.startedAt).getTime() < 10 * 60 * 1000) return;
  const { run, created } = await startRun(db, { findProspects: false, trigger: 'auto' });
  if (created) after(() => driveRun(run.id, baseUrl(origin)));
}
