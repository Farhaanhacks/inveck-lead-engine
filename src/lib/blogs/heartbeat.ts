import { like } from 'drizzle-orm';
import { appSettings } from './db/schema';
import type { AnyDb } from './db/types';

export const WORKERS = ['discovery', 'jobs', 'publish', 'analytics'] as const;
export type Worker = (typeof WORKERS)[number];

/** Each scheduler tick records that it ran, so the dashboard can say when the background worker has stopped. */
export async function beat(db: AnyDb, worker: Worker, at = new Date()) {
  await db.insert(appSettings).values({ key: `heartbeat:${worker}`, value: { at: at.toISOString() } }).onConflictDoUpdate({ target: appSettings.key, set: { value: { at: at.toISOString() }, updatedAt: at } });
}

export async function lastBeats(db: AnyDb): Promise<Record<string, Date>> {
  const rows = await db.select().from(appSettings).where(like(appSettings.key, 'heartbeat:%'));
  return Object.fromEntries(rows.map((r) => [r.key.slice('heartbeat:'.length), new Date((r.value as { at: string }).at)]));
}

export const WORKER_STALE_MS = 3 * 60_000;

/** True when there is work waiting but no worker tick has run recently. */
export function workerIsStale(pendingWork: number, beats: Record<string, Date>, now = new Date()): boolean {
  if (!pendingWork) return false;
  const latest = Math.max(0, ...['jobs', 'publish', 'discovery'].map((w) => beats[w]?.getTime() ?? 0));
  return now.getTime() - latest > WORKER_STALE_MS;
}
