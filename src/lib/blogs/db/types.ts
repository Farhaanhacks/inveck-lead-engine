import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

/** Any Drizzle Postgres database over this schema: Supabase in production, PGlite in tests. */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
