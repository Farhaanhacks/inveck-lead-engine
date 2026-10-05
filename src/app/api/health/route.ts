import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';

export const dynamic = 'force-dynamic';

/** Error text safe to show: no connection strings, hosts' credentials or keys. */
const safe = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .replace(/[a-z]+:\/\/[^\s'"]+/gi, '[url]')
    .replace(/(password|token|key|secret)[=:]\s*\S+/gi, '$1=[hidden]')
    .slice(0, 400);

/** Whether the app can reach its database (public; says nothing about the data). */
export async function GET() {
  const started = Date.now();
  const configured = !!(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const provider = process.env.SUPABASE_DB_URL ? 'supabase' : 'neon/vercel';
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    const [row] = (await db.execute(sql`select count(*)::int as n from leads`)) as unknown as { n: number }[];
    // Reading works; can the database also take the startup schema upkeep (a harmless no-op)?
    await db.execute(sql.raw(SCHEMA_STATEMENTS[0]));
    return Response.json({ ok: true, provider, database: 'reachable', leads: row?.n ?? null, ms: Date.now() - started });
  } catch (e) {
    // The database's own reason is on the wrapped error (drizzle's "Failed query" hides it).
    const cause = (e as { cause?: { message?: string; code?: string; severity?: string; detail?: string; hint?: string } })?.cause;
    return Response.json(
      {
        ok: false,
        reason: cause ? safe(cause) : safe(e),
        code: cause?.code ?? '',
        detail: cause?.detail ? safe(cause.detail) : '',
        hint: cause?.hint ? safe(cause.hint) : '',
        provider,
        databaseConfigured: configured,
        failedStep: safe(e).slice(0, 80),
        ms: Date.now() - started,
      },
      { status: 503 },
    );
  }
}
