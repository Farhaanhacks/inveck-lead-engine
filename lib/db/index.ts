import 'server-only';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { SCHEMA_STATEMENTS } from './migrate';
import { removeTopFromP1, upgradeLogisticsIcpV2, upgradeLogisticsIcpV3, seedIfEmpty, upgradeIcpsV2, upgradeManufacturingDealBreakersV5, upgradeManufacturingHeavyV4, upgradeManufacturingIndustriesV3 } from './seed';
import { seedUsers } from '../passwords';
import { reconcileFollowUpsOnce } from '../follow-up-reconcile';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

type Holder = { db?: Promise<Db> };
const holder = globalThis as unknown as { __inveckDb?: Holder };
holder.__inveckDb ??= {};

/**
 * DATABASE_URL (or POSTGRES_URL, which Vercel's Postgres integration sets) points at
 * Postgres. Without one, local development uses PGlite, an embedded Postgres stored in
 * ./.data. `memory://` gives a throwaway in-memory database (used by the tests).
 */
export function databaseUrl(): string {
  // SUPABASE_DB_URL wins: set it to move the app to Supabase without touching the Neon integration's
  // own variables (which Vercel manages).
  return process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

async function connect(): Promise<Db> {
  const url = databaseUrl();
  let db: Db;
  if (url && !url.startsWith('memory://') && !url.startsWith('pglite://')) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    // Serverless functions come and go, so keep the pool small.
    // Supabase only takes encrypted connections; its pooler (port 6543) needs prepare: false, as here.
    const client = postgres(url, { max: 3, prepare: false, ...(/supabase\.(co|com)/.test(url) ? { ssl: 'require' as const } : {}) });
    db = drizzle(client, { schema }) as unknown as Db;
  } else {
    if (!url && process.env.VERCEL) {
      throw new Error('No database configured. Add a Postgres database in Vercel (Storage) so DATABASE_URL or POSTGRES_URL is set.');
    }
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const dir = url.startsWith('pglite://') ? url.slice('pglite://'.length) : url ? undefined : './.data/pglite';
    if (dir) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
    }
    const client = dir ? new PGlite(dir) : new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
  }
  // Schema upkeep on each cold start. When the database won't take it (read-only, over a plan limit,
  // a lock), the app still runs on the tables already there instead of every page failing.
  try {
    for (const statement of SCHEMA_STATEMENTS) await db.execute(sql.raw(statement));
    await seedIfEmpty(db);
    await upgradeIcpsV2(db);
    await upgradeManufacturingIndustriesV3(db);
    await removeTopFromP1(db);
    await upgradeLogisticsIcpV2(db);
    await upgradeLogisticsIcpV3(db);
    await upgradeManufacturingHeavyV4(db);
    await upgradeManufacturingDealBreakersV5(db);
    await seedUsers(db);
    await reconcileFollowUpsOnce(db);
  } catch (e) {
    const cause = (e as { cause?: unknown })?.cause;
    console.error('[db] schema upkeep failed; running on the existing schema:', cause ?? e);
  }
  return db;
}

export function getDb(): Promise<Db> {
  const h = holder.__inveckDb!;
  if (!h.db) {
    h.db = connect().catch((e) => {
      h.db = undefined;
      throw e;
    });
  }
  return h.db;
}

/** Tests only: forget the current connection so the next getDb() starts fresh. */
export function resetDbForTests() {
  holder.__inveckDb = {};
}

export { schema };
