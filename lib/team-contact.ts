import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { activities, type Lead } from './db/schema';

/**
 * Whether the lead's saved contact is the sales team's own (and so kept as it is): entered when the
 * company was added (it had no research yet), or set on the lead by someone in the team since. A
 * contact an earlier research run picked is not.
 */
export async function contactFromTeam(db: Db, lead: Pick<Lead, 'id' | 'contactName' | 'contactEmail' | 'researchSummary'>): Promise<boolean> {
  if (!lead.contactName && !lead.contactEmail) return false;
  if (!lead.researchSummary) return true;
  const [row] = await db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.leadId, lead.id),
        sql`(${activities.text} LIKE 'Point of contact updated%' OR ${activities.text} LIKE '%(chosen by the team)%' OR ${activities.text} LIKE '%added by the team%')`,
      ),
    )
    .limit(1);
  return !!row;
}
