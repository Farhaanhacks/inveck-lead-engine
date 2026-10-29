import 'server-only';
import { getDb } from '../db/client';
import { imageStore } from '../db/schema';
import { IMAGE_URL_PREFIX } from '../image-url';
import type { AnyDb } from '../db/types';
import { env } from '../env';
import { ExaProvider } from '../providers/exa';
import { GeminiProvider } from '../providers/gemini';
import { chooseImageService } from '../providers/image-choice';
import { getSetting } from '../settings';
import type { ImageStorage } from './image';
import { findDueJobs, runJob, type JobDeps, type JobOutcome } from './job';

/** Featured images are kept in the blog's own table (blog_image_store) and shown through /api/blogs/image; nothing leaves the database but the CMS upload. */
export class DbImageStorage implements ImageStorage {
  constructor(private readonly db: AnyDb) {}

  async put(key: string, bytes: Buffer, contentType: string) {
    await this.db
      .insert(imageStore)
      .values({ key, bytes, mimeType: contentType })
      .onConflictDoUpdate({ target: imageStore.key, set: { bytes, mimeType: contentType, createdAt: new Date() } });
    return { url: `${IMAGE_URL_PREFIX}${encodeURIComponent(key)}` };
  }
}

export function missingPipelineKeys(): string[] {
  const e = env();
  return [!e.EXA_API_KEY && 'EXA_API_KEY', !e.GEMINI_API_KEY && 'GEMINI_API_KEY'].filter((x): x is string => !!x);
}

export async function liveJobDeps(): Promise<JobDeps> {
  const e = env();
  if (!e.EXA_API_KEY || !e.GEMINI_API_KEY) throw new Error(`Missing ${missingPipelineKeys().join(' and ')}`);
  const [models, budget, queue] = await Promise.all([getSetting('models'), getSetting('budget'), getSetting('queue')]);
  const gemini = new GeminiProvider(e.GEMINI_API_KEY);
  const images = chooseImageService(e);
  return {
    research: new ExaProvider(e.EXA_API_KEY),
    llm: gemini,
    // WaveSpeed when its key is set, then Pollinations; Gemini's image model otherwise.
    image: images ? images.provider() : gemini,
    storage: new DbImageStorage(await getDb()),
    models: images ? { ...models, image: images.model } : models,
    budget,
    timeZone: queue.timezone,
    // Hosted functions have a hard time limit, so a job hands itself back to the queue (the cron tick resumes it).
    // On your own machine there is no such limit, so one run goes all the way through.
    budgetMs: process.env.VERCEL ? 170_000 : 20 * 60_000,
  };
}

/** Runs one job with live providers. Never throws: failures are written onto the job. */
export async function runJobLive(jobId: string, opts: { force?: boolean } = {}): Promise<JobOutcome> {
  try {
    return await runJob((await getDb()), jobId, await liveJobDeps(), opts);
  } catch (e) {
    console.error('job runner crashed', jobId, e instanceof Error ? e.message : e);
    return 'failed';
  }
}

export async function runDueJobs() {
  const ids = await findDueJobs((await getDb()), new Date(), 2);
  const out: { id: string; outcome: JobOutcome }[] = [];
  for (const id of ids) out.push({ id, outcome: await runJobLive(id) });
  return out;
}
