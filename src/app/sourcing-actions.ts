'use server';

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { sourcingTests } from '@/lib/db/schema';
import { requireAdmin } from '@/lib/access';
import { requestOrigin } from '@/lib/run-driver';
import { driveSourcingTest } from '@/lib/sourcing/drive';
import { activeSourcingTest, SOURCING_LIMITS, validSegment } from '@/lib/sourcing/test-run';

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
