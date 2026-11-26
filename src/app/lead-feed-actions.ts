'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/access';
import { bestEffort } from '@/lib/best-effort';
import { runDailyDraw, topUpDraw } from '@/lib/draw';
import { syncLeadFeed } from '@/lib/lead-feed';

/**
 * "Sync now" on Settings: reads the Instinct lead sheet (read-only) and makes leads of the usable new companies. A feed that arrives
 * after the morning draw is then dealt out to whoever is still short today, as a top-up does. Administrators only.
 */
export async function syncLeadFeedAction() {
  await requireAdmin();
  const db = await getDb();
  await syncLeadFeed(db);
  await bestEffort('the morning draw', () => runDailyDraw(db), null);
  await bestEffort('topping up the draw', () => topUpDraw(db), null);
  revalidatePath('/settings');
  revalidatePath('/leads');
  revalidatePath('/today');
}
