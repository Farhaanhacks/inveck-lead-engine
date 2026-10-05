import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';

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
  const configured = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    const [row] = (await db.execute(sql`select count(*)::int as n from leads`)) as unknown as { n: number }[];
    return Response.json({ ok: true, database: 'reachable', leads: row?.n ?? null, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ ok: false, databaseConfigured: configured, error: safe(e), ms: Date.now() - started }, { status: 503 });
  }
}
