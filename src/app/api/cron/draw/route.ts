import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getDraw, runDailyDraw } from '@/lib/draw';
import { liveServices } from '@/lib/run-driver';
import { promoteBetterContacts, purgeFormerEmployees, verifyContacts } from '@/lib/verify-contacts';
import { redraftForContact } from '@/lib/pipeline/redraft';

export const maxDuration = 300;

/**
 * The morning draw (see vercel.json): hands out the day's leads before the team starts at 10.
 * Pages also run it when opened after the draw hour, in case the schedule was late.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  // Every contact the team will see today checked on LinkedIn first: profile and current designation.
  const svc = await liveServices();
  const purged = await purgeFormerEmployees(db);
  const promoted = await promoteBetterContacts(db);
  for (const id of promoted) await redraftForContact(db, svc, id);
  const checked = await verifyContacts(db, svc, { limit: 200 });
  const drawn = await runDailyDraw(db);
  return Response.json({ purged, promoted: promoted.length, checked, drawn: drawn !== null, draw: drawn ?? (await getDraw(db)) });
}
