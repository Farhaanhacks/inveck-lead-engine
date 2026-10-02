import { runSecret } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { liveServices } from '@/lib/run-driver';
import { tidyContacts, verifyContacts } from '@/lib/verify-contacts';
import { fillMissingDrafts, redraftForContact } from '@/lib/pipeline/redraft';

export const maxDuration = 300;

/**
 * Every working morning before the team starts (see vercel.json): checks the contacts the team will
 * see on LinkedIn, and writes any email or LinkedIn draft a qualified lead is missing.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = await getDb();
  // Every contact the team will see today checked on LinkedIn first: profile and current designation.
  const svc = await liveServices();
  const promoted = await tidyContacts(db);
  for (const id of promoted) await redraftForContact(db, svc, id);
  const checked = await verifyContacts(db, svc, { limit: 200 });
  // Qualified leads missing an email or LinkedIn draft (none written yet, or the AI dropped one).
  const drafted = await fillMissingDrafts(db, svc, { limit: 15 });
  return Response.json({ promoted: promoted.length, checked, drafted });
}
