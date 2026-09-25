import { getDb } from '@/lib/db';
import { activeRun } from '@/lib/runs';

/** Whether research is running right now, for the indicator in the side menu. */
export async function GET() {
  const run = await activeRun(await getDb());
  return Response.json(run ? { id: run.id, processed: run.stats.processed } : null, { headers: { 'cache-control': 'no-store' } });
}
