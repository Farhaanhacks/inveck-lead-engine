import 'server-only';
import { getDb } from './db';
import { apiKeys, getSettings } from './settings';
import { dbEnrichmentCache } from './enrichment-cache';
import { dbSearchMeter, researchCreditsLeft, searchBudgetLeft } from './search-budget';
import { activeRun, claimStalledRun, executeRun, logEvent, markRunPaused, MAX_RESUMES, startRun } from './runs';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { leads, runEvents, runs } from './db/schema';
import { runSecret } from './auth';
import type { Services } from './pipeline/services';
import { errorMessage } from './pipeline/text';
import { pausedToday } from './pause';

/** Seconds a run invocation may take; route files export the same value as `maxDuration`. */
export const RUN_MAX_DURATION = 300;
// Leave headroom under maxDuration so a batch that's already started can finish.
const BUDGET_MS = (RUN_MAX_DURATION - 90) * 1000;

export async function liveServices(): Promise<Services> {
  const db = await getDb();
  // Lookups (places, LinkedIn pages) are cached in the database, so each is made once.
  return { fetch: globalThis.fetch.bind(globalThis), keys: apiKeys(), settings: await getSettings(db), cache: dbEnrichmentCache(db), meter: dbSearchMeter(db) };
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
 * do the run hands itself to a fresh invocation; elsewhere it simply keeps going. Vercel
 * ends a long chain of invocations each calling the next (after a few); the run then
 * waits, and the next fresh request (a page opened, a scheduled check) picks it up again.
 */
export async function driveRun(runId: number, origin: string) {
  const db = await getDb();
  // Paused today: a run that started on its own stops here (one the admin started goes on).
  if (await pausedToday(db)) {
    const [run] = await db.select({ trigger: runs.trigger, status: runs.status }).from(runs).where(eq(runs.id, runId));
    if (run?.status === 'running' && run.trigger !== 'manual') {
      await db.update(runs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(runs.id, runId));
      await logEvent(db, runId, 'Stopped: everything that runs on its own is paused today', 'warn');
      return;
    }
  }
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
    await markRunPaused(db, runId);
    await logEvent(db, runId, 'Paused for a moment (the server limits how many times a run can hand itself on): it carries on at the next scheduled check, or when the app is opened', 'warn');
  }
}

const PICKED_UP = 'Picked up again after a pause';

/**
 * The run now running, when its invocations stopped (the next couldn't be called, or one died): carried
 * on from this request, which starts a fresh chain. True when one was picked up.
 */
export async function resumeStalledRun(origin?: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (await pausedToday(db)) return false;
    const run = await claimStalledRun(db);
    if (!run) return false;
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), like(runEvents.message, `${PICKED_UP}%`)));
    if (Number(n) >= MAX_RESUMES) {
      await db.update(runs).set({ status: 'failed', error: `Stopped: it stalled ${MAX_RESUMES} times`, finishedAt: new Date() }).where(eq(runs.id, run.id));
      return false;
    }
    await logEvent(db, run.id, PICKED_UP);
    const base = baseUrl(origin);
    after(() => driveRun(run.id, base));
    return true;
  } catch (e) {
    console.error(`Picking up a stalled run: ${errorMessage(e)}`);
    return false;
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
    if (await resumeStalledRun(origin)) return;
    const db = await getDb();
    if (await pausedToday(db)) return;
    const [{ waiting }] = await db
      .select({ waiting: sql<number>`count(*)::int` })
      .from(leads)
      .where(eq(leads.status, 'New'));
    if (!waiting || (await activeRun(db))) return;
    // The day's Google search budget, or its research limit, is used: they wait for the next day.
    if ((await searchBudgetLeft(db, await getSettings(db))) < 30 || (await researchCreditsLeft(db)) < 30) return;
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
  if (await resumeStalledRun(origin)) return;
  const { waiting } = await refetchProgress();
  if (!waiting) return;
  const db = await getDb();
  if (await pausedToday(db)) return;
  if (await activeRun(db)) return;
  if ((await searchBudgetLeft(db, await getSettings(db))) < 30 || (await researchCreditsLeft(db)) < 30) return;
  // Not again straight after a run that just ended or was stopped.
  const [last] = await db.select().from(runs).orderBy(desc(runs.id)).limit(1);
  if (last && Date.now() - new Date(last.finishedAt ?? last.startedAt).getTime() < 10 * 60 * 1000) return;
  const { run, created } = await startRun(db, { findProspects: false, trigger: 'auto' });
  if (created) after(() => driveRun(run.id, baseUrl(origin)));
}
