'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/access';
import { syncLeadFeed } from '@/lib/lead-feed';

/** "Sync now" on Settings: reads the Instinct lead sheet (read-only) and makes leads of the usable new companies. Administrators only. */
export async function syncLeadFeedAction() {
  await requireAdmin();
  await syncLeadFeed(await getDb());
  revalidatePath('/settings');
  revalidatePath('/leads');
}
