'use server';

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { sourcingTests } from '@/lib/db/schema';
import { requireAdmin } from '@/lib/access';
import { requestOrigin } from '@/lib/run-driver';
import { driveSourcingTest } from '@/lib/sourcing/drive';
import { activeSourcingTest, reopenTest, SOURCING_LIMITS, validSegment } from '@/lib/sourcing/test-run';
import { assignSampleLeads, pushSampleCompanies, stopSample, type MorningSampleStart } from '@/lib/sourcing/sample-run';

/**
 * Starts a sourcing test (one at a time) and shows it. It runs after the response; a people-first test
 * that needs longer than one invocation carries on in the next (see driveSourcingTest).
 */
export async function startSourcingTestAction(form: FormData) {
  const user = await requireAdmin();
  const segment = validSegment(String(form.get('segment') ?? ''));
  if (!segment) redirect('/sourcing');
  const asked = Math.round(Number(form.get('companies')) || SOURCING_LIMITS.prospects);
  const companies = Math.min(SOURCING_LIMITS.maxProspects, Math.max(SOURCING_LIMITS.minProspects, asked));
  const db = await getDb();
  const running = await activeSourcingTest(db);
  if (running) redirect(`/sourcing?test=${running.id}`);
  const mode = form.get('mode') === 'companies' ? 'companies' : 'people';
  const [test] = await db.insert(sourcingTests).values({ segment, mode, companies, startedBy: user.id, progress: 'Starting…' }).returning({ id: sourcingTests.id });
  const origin = await requestOrigin();
  after(() => driveSourcingTest(test.id, origin));
  redirect(`/sourcing?test=${test.id}`);
}

/**
 * Starts a Morning Sample Run (one at a time): tomorrow's 6 am run and 8 am draw on paper. Nothing is
 * saved as a lead and nobody is given anything; only its report is kept.
 */
export async function startMorningSampleAction(form: FormData) {
  const user = await requireAdmin();
  const db = await getDb();
  const running = await activeSourcingTest(db, 'morning');
  if (running) redirect(`/sourcing?sample=${running.id}#morning`);
  const start: MorningSampleStart = { mode: 'morning', phase: 'init', fresh: form.get('fresh') === 'on' };
  const [test] = await db
    .insert(sourcingTests)
    .values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, startedBy: user.id, progress: 'Starting…', report: start })
    .returning({ id: sourcingTests.id });
  const origin = await requestOrigin();
  after(() => driveSourcingTest(test.id, origin));
  redirect(`/sourcing?sample=${test.id}#morning`);
}

/**
 * Carries on a Morning Sample Run that stopped for the server's time limit, from where it got to: nothing
 * it already searched or researched is done again.
 */
export async function carryOnSampleAction(form: FormData) {
  await requireAdmin();
  const id = Number(form.get('id'));
  const db = await getDb();
  const running = await activeSourcingTest(db, 'morning');
  if (running) redirect(`/sourcing?sample=${running.id}#morning`);
  if (id && (await reopenTest(db, id))) {
    const origin = await requestOrigin();
    after(() => driveSourcingTest(id, origin));
  }
  redirect(`/sourcing?sample=${id}#morning`);
}

/** Stops a running Morning Sample Run where it is: nothing more is searched or researched. */
export async function stopSampleAction(form: FormData) {
  await requireAdmin();
  const id = Number(form.get('id'));
  if (id) await stopSample(await getDb(), id);
  redirect(`/sourcing?sample=${id}#morning`);
}

/** Puts every lead a finished sample dealt into the pipeline as Approved, given to the person it dealt each to (see assignSampleLeads). */
export async function assignSampleAction(form: FormData) {
  await requireAdmin();
  const id = Number(form.get('id'));
  if (id) await assignSampleLeads(await getDb(), id);
  revalidatePath('/leads');
  revalidatePath('/today');
  redirect(`/sourcing?sample=${id}#morning`);
}

/** Puts the companies ticked in a stopped or finished sample into the pipeline as real leads (see pushSampleCompanies). */
export async function pushSampleAction(form: FormData) {
  await requireAdmin();
  const id = Number(form.get('id'));
  const keys = form.getAll('key').map(Number).filter((k) => Number.isFinite(k));
  if (id && keys.length) await pushSampleCompanies(await getDb(), id, keys);
  redirect(`/sourcing?sample=${id}#morning`);
}
