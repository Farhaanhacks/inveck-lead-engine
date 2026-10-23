import type { Db } from '@/lib/db';
import { allocationRules, allocationTargets } from '@/lib/db/schema';

/**
 * A database with no allocation configured: the draw then uses the older numbers (each associate's own on the Team page,
 * else Settings). Several tests were written against that, and it is still the behaviour until any allocation exists.
 */
export async function legacyAllocation(db: Db) {
  await db.delete(allocationRules);
  await db.delete(allocationTargets);
}
