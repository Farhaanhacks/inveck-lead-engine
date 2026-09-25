import { eq, inArray } from 'drizzle-orm';
import type { Db } from './db';
import { ENGAGED_STAGES, leads, type LeadStatus } from './db/schema';
import { logActivity } from './activity';
import { nextFollowUpAt } from './pipeline/follow-ups';

const WHAT: Partial<Record<LeadStatus, string>> = {
  New: 'Queued for research again',
  'Awaiting Approval': 'Moved back to Awaiting Approval',
  Rejected: 'Draft rejected',
  Replied: 'They replied',
  'Meeting Booked': 'Meeting booked',
  Won: 'Won',
  Lost: 'Lost',
};

/**
 * Moves leads to a stage with everything that goes with it: sending starts the follow-up
 * schedule, a reply (or any later stage) stops it, and every move goes on the timeline.
 */
export async function applyStage(db: Db, ids: number[], status: LeadStatus): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select().from(leads).where(inArray(leads.id, ids));
  const now = new Date();
  for (const lead of rows) {
    if (lead.status === status) continue;
    const set: Partial<typeof leads.$inferInsert> = { status, updatedAt: now };
    if (status === 'Contacted') {
      if (!lead.sentAt) {
        set.sentAt = now;
        set.followUpStep = 0;
        set.nextFollowUpAt = nextFollowUpAt(now, 0);
      }
    } else {
      // Only contacted leads get follow-ups; a reply or any later stage ends the sequence.
      set.nextFollowUpAt = null;
      set.followUpSubject = '';
      set.followUpBody = '';
    }
    if (status === 'New') set.lastError = '';
    await db.update(leads).set(set).where(eq(leads.id, lead.id));

    if (status === 'Approved') await logActivity(db, lead.id, 'approved', 'Draft approved', status);
    else if (status === 'Contacted' && !lead.sentAt) {
      await logActivity(db, lead.id, 'sent', `First email sent${lead.emailSubject ? `: “${lead.emailSubject}”` : ''}. Follow-ups scheduled for day 3 and day 7.`, status);
    } else await logActivity(db, lead.id, 'stage', WHAT[status] ?? `Moved to ${status}`, status);
    if (ENGAGED_STAGES.includes(status) && lead.nextFollowUpAt) await logActivity(db, lead.id, 'note', 'Follow-ups stopped');
  }
}
