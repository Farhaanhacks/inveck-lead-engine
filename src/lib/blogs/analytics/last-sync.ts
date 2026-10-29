import { eq } from 'drizzle-orm';
import { appSettings } from '../db/schema';
import type { AnyDb } from '../db/types';
import type { SyncResult } from './sync';

export const LAST_SYNC_KEY = 'analytics:last_sync';

/** What the dashboard shows about the most recent scheduled sync. `failure` is set when the run stopped before finishing. */
export type LastSync = SyncResult & { at: string; failure: string | null };

/**
 * Provider messages can echo parts of a response. Strip anything that looks like key material or a token before it is
 * logged, stored or shown, and keep it short.
 */
export function redact(message: string): string {
  return message
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '[redacted key]')
    .replace(/"private_key(_id)?"\s*:\s*"[^"]*"?/g, '"private_key$1":"[redacted]"')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bya29\.[\w.-]+/g, '[redacted token]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]')
    .slice(0, 300);
}

export function safeResult(r: SyncResult): SyncResult {
  return { ...r, errors: r.errors.map((e) => ({ provider: e.provider, message: redact(e.message) })) };
}

export async function recordSync(db: AnyDb, entry: LastSync) {
  await db.insert(appSettings).values({ key: LAST_SYNC_KEY, value: entry }).onConflictDoUpdate({ target: appSettings.key, set: { value: entry, updatedAt: new Date() } });
}

export async function loadLastSync(db: AnyDb): Promise<LastSync | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, LAST_SYNC_KEY)).limit(1);
  return row ? (row.value as LastSync) : null;
}
