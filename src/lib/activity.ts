import type { Db } from './db';
import { activities, type ActivityKind } from './db/schema';

/** Adds an entry to a lead's timeline. Never fails the caller: the timeline is a record, not a dependency. */
export async function logActivity(db: Db, leadId: number, kind: ActivityKind, text = '', stage = ''): Promise<void> {
  try {
    await db.insert(activities).values({ leadId, kind, text: text.slice(0, 4000), stage });
  } catch {}
}
