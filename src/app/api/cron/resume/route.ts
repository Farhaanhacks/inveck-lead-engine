import { runSecret } from '@/lib/auth';
import { resumeStalledRun } from '@/lib/run-driver';
import { resumeStalledTests } from '@/lib/sourcing/drive';

export const maxDuration = 300;

/**
 * Picks up a run or sourcing test that stalled (Vercel ends a long chain of invocations each calling the
 * next) from here, a fresh request. Does nothing when nothing has stalled. Needs CRON_SECRET as a bearer token.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${await runSecret()}`) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const origin = new URL(request.url).origin;
  const run = await resumeStalledRun(origin);
  const tests = await resumeStalledTests(origin);
  return Response.json({ resumed: { run, tests } });
}
