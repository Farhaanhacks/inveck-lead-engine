import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getDraw, runDailyDraw } from '@/lib/draw';

/**
 * The morning draw (see vercel.json): hands out the day's leads before the team starts at 10.
 * Pages also run it when opened after the draw hour, in case the schedule was late.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  const drawn = await runDailyDraw(db);
  return Response.json({ drawn: drawn !== null, draw: drawn ?? (await getDraw(db)) });
}
