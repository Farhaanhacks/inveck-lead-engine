'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/access';
import { syncInboundDemos } from '@/lib/inbound-demo';

/** "Sync now" on Settings: reads the inbound demo sheet (read-only) and brings the CRM up to date. Administrators only. */
export async function syncInboundDemosAction() {
  await requireAdmin();
  await syncInboundDemos(await getDb());
  revalidatePath('/settings');
  revalidatePath('/today');
}
