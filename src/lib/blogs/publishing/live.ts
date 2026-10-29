import 'server-only';
import { getCmsAdapter } from '../cms';
import { getDb } from '../db/client';
import { getSetting } from '../settings';
import type { QueueSettings } from './schedule';
import { processDuePosts } from './worker';

export async function loadQueueSettings(): Promise<QueueSettings> {
  return (await getSetting('queue')) as unknown as QueueSettings;
}

/** One worker tick: publishes whatever is due. */
export async function runPublishTick() {
  const q = await loadQueueSettings();
  return processDuePosts((await getDb()), getCmsAdapter(), q);
}
