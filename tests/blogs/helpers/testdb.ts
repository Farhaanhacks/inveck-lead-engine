import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/blogs/db/schema';
import { BLOG_SCHEMA_STATEMENTS } from '@/lib/blogs/db/ddl';
import { domainConfigSchema } from '@/lib/blogs/domains/config';
import { DOMAIN_SEEDS } from './domain-seeds';
import type { AnyDb } from '@/lib/blogs/db/types';

/**
 * A throwaway in-memory Postgres with the real Blogs schema statements applied, so constraints and partial indexes behave as in
 * production. It holds the Inveck profile (ready: audience and tone set) and, only here, the generic fixture profiles the engine's own
 * tests were written against (including the stricter health and finance rules); the real app has the one Inveck profile.
 */
export async function makeTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as AnyDb;
  for (const statement of BLOG_SCHEMA_STATEMENTS) await db.execute(sql.raw(statement));
  const domains = await db
    .insert(schema.domainProfiles)
    .values([
      ...DOMAIN_SEEDS,
      { slug: 'inveck', name: 'Inveck', audience: 'Operations and finance leaders', geography: 'Global', locale: 'en', tone: 'Clear and practical', defaultArticleLength: 1200, config: domainConfigSchema.parse({}) },
    ])
    .returning();
  return { db, domains, close: () => client.close() };
}
