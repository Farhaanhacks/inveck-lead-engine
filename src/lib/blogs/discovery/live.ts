import 'server-only';
import { getDb } from '../db/client';
import { env } from '../env';
import { ExaProvider } from '../providers/exa';
import { GeminiProvider } from '../providers/gemini';
import { getSetting } from '../settings';
import { findRunnableRuns, processTopicRun, type RunDeps } from './run';

/** Provider keys the discovery engine needs, so callers can refuse to queue a run that cannot work. */
export function missingDiscoveryKeys(): string[] {
  const e = env();
  return [!e.EXA_API_KEY && 'EXA_API_KEY', !e.GEMINI_API_KEY && 'GEMINI_API_KEY'].filter((x): x is string => !!x);
}

export async function liveRunDeps(): Promise<RunDeps> {
  const e = env();
  if (!e.EXA_API_KEY || !e.GEMINI_API_KEY) throw new Error(`Missing ${missingDiscoveryKeys().join(' and ')}`);
  const [weights, models, budget, queue] = await Promise.all([getSetting('scoringWeights'), getSetting('models'), getSetting('budget'), getSetting('queue')]);
  return {
    research: new ExaProvider(e.EXA_API_KEY),
    llm: new GeminiProvider(e.GEMINI_API_KEY),
    model: models.fast,
    weights,
    budget,
    timeZone: queue.timezone,
  };
}

/** Processes one run with live providers. Never throws: failures are written onto the run. */
export async function runDiscovery(runId: string) {
  const db = await (await getDb());
  try {
    return await processTopicRun(db, runId, await liveRunDeps());
  } catch (e) {
    console.error('discovery run crashed', runId, e instanceof Error ? e.message : e);
    return { status: 'failed' as const, created: 0 };
  }
}

/** For the cron endpoint: picks up queued runs and runs whose worker vanished. */
export async function runPendingDiscovery() {
  const ids = await findRunnableRuns((await getDb()));
  const results = [];
  for (const id of ids) results.push({ id, ...(await runDiscovery(id)) });
  return results;
}
