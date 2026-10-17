import { after } from 'next/server';
import { runSecret } from '@/lib/auth';
import { driveRun } from '@/lib/run-driver';

// Keep in sync with RUN_MAX_DURATION in lib/run-driver.ts.
export const maxDuration = 300;

/** A run that ran out of time in one invocation calls this to carry on in a new one. */
export async function POST(request: Request, ctx: RouteContext<'/api/runs/[id]/continue'>) {
  if (request.headers.get('x-run-secret') !== (await runSecret())) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const id = Number((await ctx.params).id);
  const origin = new URL(request.url).origin;
  after(() => driveRun(id, origin));
  return Response.json({ ok: true }, { status: 202 });
}
