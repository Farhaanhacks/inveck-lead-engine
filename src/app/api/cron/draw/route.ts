import { runSecret } from '@/lib/auth';
import { bestEffort } from '@/lib/best-effort';
import { getDb } from '@/lib/db';
import { after } from 'next/server';
import { getDraw, runDailyDraw, topUpDraw } from '@/lib/draw';
import { runCaDraw } from '@/lib/ca-sheet';
import { driveRun, resumeStalledRun } from '@/lib/run-driver';
import { startRun } from '@/lib/runs';
import { liveServices } from '@/lib/run-driver';
import { tidyContacts, verifyContacts } from '@/lib/verify-contacts';
import { fillMissingDrafts, redraftForContact } from '@/lib/pipeline/redraft';
import { ensureSequences } from '@/lib/tasks';
import { searchBudgetLeft } from '@/lib/search-budget';
import { pausedToday } from '@/lib/pause';
import { noteWake, wakeDailyRun } from '@/lib/sourcing/wake';

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
  await noteWake(db, 'vercel', 'the 8 am draw').catch(() => {});
  // Paused today (Settings key pausedDays): no contact checks, draw, CA draw or drafts.
  if (await pausedToday(db)) return Response.json({ paused: true });
  // The 6 am run, if it stalled (its chain of invocations ended), carries on from here; so does the daily sample (started here if no earlier check did).
  await resumeStalledRun(new URL(request.url).origin);
  await bestEffort('the daily sample', () => wakeDailyRun(db, new URL(request.url).origin), null);
  // Each step on its own: a failure in one (a search quota, a slow lookup) never stops the draw.
  // Every contact the team will see today checked on LinkedIn first: profile and current designation.
  const svc = await liveServices();
  const promoted = await bestEffort('tidying contacts', () => tidyContacts(db), [] as number[]);
  for (const id of promoted) await bestEffort('rewriting a draft', () => redraftForContact(db, svc, id), undefined);
  const checked = await bestEffort('checking contacts on LinkedIn', () => verifyContacts(db, svc, { limit: 200, budgetLeft: () => searchBudgetLeft(db, svc.settings) }), null);
  const drawn = (await bestEffort('the morning draw', () => runDailyDraw(db), null)) ?? (await bestEffort('topping up the draw', () => topUpDraw(db), null));
  // CA firms: 10 each for Anchal and Puja from the Google Sheet, then researched like any other new lead.
  const ca = await bestEffort('the CA firm draw', () => runCaDraw(db), null);
  if (ca?.added) {
    const { run, created } = await startRun(db, { findProspects: false, trigger: 'auto' });
    if (created) after(() => driveRun(run.id, new URL(request.url).origin));
  }
  // Every owned lead's steps on its owner's Today now, not only once someone opens the page.
  const planned = await bestEffort('planning Today steps', () => ensureSequences(db), 0);
  // Qualified leads missing an email or LinkedIn draft (none written yet, or the AI dropped one).
  const drafted = await bestEffort('writing missing drafts', () => fillMissingDrafts(db, svc, { limit: 15 }), null);
  return Response.json({ promoted: promoted.length, checked, drafted, planned, ca: ca ? { drawn: ca.drawn, wanted: ca.wanted, added: ca.added, problem: ca.problem } : null, drawn: drawn !== null, draw: drawn ?? (await getDraw(db)) });
}
