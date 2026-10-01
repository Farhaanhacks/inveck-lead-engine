import 'server-only';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { SCHEMA_STATEMENTS } from './migrate';
import { seedIfEmpty, upgradeIcpsV2 } from './seed';
import { seedUsers } from '../passwords';

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
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

async function connect(): Promise<Db> {
  const url = databaseUrl();
  let db: Db;
  if (url && !url.startsWith('memory://') && !url.startsWith('pglite://')) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    // Serverless functions come and go, so keep the pool small.
    const client = postgres(url, { max: 3, prepare: false });
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
  for (const statement of SCHEMA_STATEMENTS) await db.execute(sql.raw(statement));
  await seedIfEmpty(db);
  await upgradeIcpsV2(db);
  await seedUsers(db);
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
