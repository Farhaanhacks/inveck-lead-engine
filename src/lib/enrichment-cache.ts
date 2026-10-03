import { eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { enrichmentCache } from './db/schema';
import type { EnrichmentCache } from './pipeline/services';

/** The database-backed cache of paid lookups, shared by every run. */
export function dbEnrichmentCache(db: Db): EnrichmentCache {
  return {
    async get(key) {
      const [row] = await db.select({ value: enrichmentCache.value }).from(enrichmentCache).where(eq(enrichmentCache.key, key));
      return row?.value ?? null;
    },
    async set(key, value) {
      await db
        .insert(enrichmentCache)
        .values({ key, provider: key.split(':')[0], value, fetchedAt: new Date() })
        .onConflictDoUpdate({ target: enrichmentCache.key, set: { value, fetchedAt: sql`now()` } });
    },
  };
}
