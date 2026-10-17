import { getDb } from '@/lib/db';
import { getRunView } from '@/lib/run-view';
import { getCurrentUser } from '@/lib/users';

/** One run's progress and results, polled by the dashboard while it runs. */
export async function GET(_request: Request, ctx: RouteContext<'/api/runs/[id]'>) {
  if ((await getCurrentUser())?.role !== 'admin') return Response.json({ error: 'Administrators only' }, { status: 403 });
  const id = Number((await ctx.params).id);
  const view = Number.isInteger(id) ? await getRunView(await getDb(), id) : null;
  if (!view) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(view);
}
