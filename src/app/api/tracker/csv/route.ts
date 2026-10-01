import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/users';
import { ownerScope } from '@/lib/access';
import { loadTracker, TRACKER_HEADERS, trackerCells } from '@/lib/tracker';
import { toCsv } from '@/lib/csv';

/** The tracker sheet as a CSV with the team's column names. A team member gets their own leads only. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not logged in' }, { status: 401 });
  const rows = await loadTracker(await getDb(), ownerScope(me));
  const csv = toCsv([[...TRACKER_HEADERS], ...rows.map(trackerCells)]);
  return new Response('﻿' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="inveck-tracker-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
