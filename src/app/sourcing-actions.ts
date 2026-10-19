'use server';

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { sourcingTests } from '@/lib/db/schema';
import { requireAdmin } from '@/lib/access';
import { liveServices } from '@/lib/run-driver';
import { activeSourcingTest, runSourcingTest, SOURCING_LIMITS, validSegment } from '@/lib/sourcing/test-run';

/** Starts a sourcing test (one at a time) and shows it. It runs after the response, on the page's time limit. */
export async function startSourcingTestAction(form: FormData) {
  const user = await requireAdmin();
  const segment = validSegment(String(form.get('segment') ?? ''));
  if (!segment) redirect('/sourcing');
  const asked = Math.round(Number(form.get('companies')) || SOURCING_LIMITS.companies);
  const companies = Math.min(SOURCING_LIMITS.maxCompanies, Math.max(SOURCING_LIMITS.minCompanies, asked));
  const db = await getDb();
  const running = await activeSourcingTest(db);
  if (running) redirect(`/sourcing?test=${running.id}`);
  const mode = form.get('mode') === 'companies' ? 'companies' : 'people';
  const [test] = await db.insert(sourcingTests).values({ segment, mode, companies, startedBy: user.id, progress: 'Starting…' }).returning({ id: sourcingTests.id });
  after(async () => runSourcingTest(await getDb(), await liveServices(), test.id));
  redirect(`/sourcing?test=${test.id}`);
}
