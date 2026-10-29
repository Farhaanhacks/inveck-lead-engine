import 'server-only';
import { getDb as getInveckDb } from '../../db';
import type { AnyDb } from './types';

/**
 * The Blogs area uses Inveck's own database connection (DATABASE_URL / local PGlite) and only its own `blog_*` tables: nothing
 * here reads or writes the CRM's tables. The connection is typed over the blog schema.
 */
export async function getDb(): Promise<AnyDb> {
  return (await getInveckDb()) as unknown as AnyDb;
}

export type Db = AnyDb;
