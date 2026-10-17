import { runSecret } from '@/lib/auth';
import { bestEffort } from '@/lib/best-effort';
import { getDb } from '@/lib/db';
import { getDraw, runDailyDraw, topUpDraw } from '@/lib/draw';
import { liveServices } from '@/lib/run-driver';
import { tidyContacts, verifyContacts } from '@/lib/verify-contacts';
import { fillMissingDrafts, redraftForContact } from '@/lib/pipeline/redraft';
import { ensureSequences } from '@/lib/tasks';

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
  // Each step on its own: a failure in one (a search quota, a slow lookup) never stops the draw.
  // Every contact the team will see today checked on LinkedIn first: profile and current designation.
  const svc = await liveServices();
  const promoted = await bestEffort('tidying contacts', () => tidyContacts(db), [] as number[]);
  for (const id of promoted) await bestEffort('rewriting a draft', () => redraftForContact(db, svc, id), undefined);
  const checked = await bestEffort('checking contacts on LinkedIn', () => verifyContacts(db, svc, { limit: 200 }), null);
  const drawn = (await bestEffort('the morning draw', () => runDailyDraw(db), null)) ?? (await bestEffort('topping up the draw', () => topUpDraw(db), null));
  // Every owned lead's steps on its owner's Today now, not only once someone opens the page.
  const planned = await bestEffort('planning Today steps', () => ensureSequences(db), 0);
  // Qualified leads missing an email or LinkedIn draft (none written yet, or the AI dropped one).
  const drafted = await bestEffort('writing missing drafts', () => fillMissingDrafts(db, svc, { limit: 15 }), null);
  return Response.json({ promoted: promoted.length, checked, drafted, planned, drawn: drawn !== null, draw: drawn ?? (await getDraw(db)) });
}
