import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { runEvents, runs } from '@/lib/db/schema';

/** Run progress, polled by the Runs page while a run is going. */
export async function GET(_request: Request, ctx: RouteContext<'/api/runs/[id]'>) {
  const id = Number((await ctx.params).id);
  const db = await getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return Response.json({ error: 'Not found' }, { status: 404 });
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(desc(runEvents.id)).limit(200);
  return Response.json({ run, events: events.reverse() });
}
