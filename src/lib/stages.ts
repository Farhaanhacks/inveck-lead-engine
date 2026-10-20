import { and, eq, gt, gte, inArray, isNull } from 'drizzle-orm';
import type { Db } from './db';
import { activities, ENGAGED_STAGES, leads, tasks, type LeadStatus } from './db/schema';
import { NOT_INTERESTED } from './tracker';
import { istDay } from './tasks';
import { logActivity } from './activity';
import { importClients } from './clients';

const BEFORE_SENDING: LeadStatus[] = ['New', 'Approved', 'Rejected'];

const WHAT: Partial<Record<LeadStatus, string>> = {
  New: 'Queued for research again',
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
export async function applyStage(db: Db, ids: number[], status: LeadStatus, whyBought?: string): Promise<void> {
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
      }
    } else {
      // Follow-ups are driven by the follow-up sequence, not by the stage; a draft is dropped when the lead moves on.
      set.nextFollowUpAt = null;
      set.followUpSubject = '';
      set.followUpBody = '';
    }
    // Back before sending (re-research, or moved back on the board): it hasn't been sent.
    const unsent = BEFORE_SENDING.includes(status) && !!lead.sentAt;
    if (unsent) {
      set.sentAt = null;
      set.followUpStep = 0;
    }
    if (status === 'New') set.lastError = '';
    await db.update(leads).set(set).where(eq(leads.id, lead.id));

    if (status === 'Approved') await logActivity(db, lead.id, 'approved', 'Approved', status);
    else if (status === 'Contacted' && !lead.sentAt) {
      await logActivity(db, lead.id, 'sent', `First email sent${lead.emailSubject ? `: “${lead.emailSubject}”` : ''}.`, status);
    } else await logActivity(db, lead.id, 'stage', WHAT[status] ?? `Moved to ${status}`, status);
    if (ENGAGED_STAGES.includes(status) && lead.followUpStartedOn) await logActivity(db, lead.id, 'note', 'Follow-ups stopped');
    if (unsent) await logActivity(db, lead.id, 'note', 'Moved back before sending: no longer counted as contacted');
    // A conversation, a meeting or a decision: the later outreach rounds on Today stop (today's still show).
    if (ENGAGED_STAGES.includes(status)) {
      await db.update(tasks).set({ doneAt: now, outcome: 'closed' }).where(and(eq(tasks.leadId, lead.id), isNull(tasks.doneAt), eq(tasks.priority, false), gt(tasks.dueDate, istDay(now))));
    }
    // Won means they became a client (Existing Client: they already were): put them on the client
    // sheet, so they're never prospected again.
    if (status === 'Won' || status === 'Existing Client') {
      const r = await importClients(db, [{ company: lead.company, website: lead.website, industry: lead.segment, whyBought: whyBought ?? '' }]);
      await logActivity(db, lead.id, 'note', r.added ? 'Added to current clients' : 'Already on the current clients sheet');
    }
  }
}

/** How far along the pipeline a stage is; outreach only ever moves a lead forward. */
const RANK: Partial<Record<LeadStatus, number>> = {
  New: 0,
  'Low Score': 1,
  Approved: 2,
  Rejected: 2,
  Contacted: 3,
  Replied: 4,
  'Meeting Booked': 5,
};

/**
 * The stage a lead should move to after something is logged on Today, or null to leave it:
 * any call attempt or message sent means Contacted; a connected call that went well means a
 * conversation started (Replied), a demo means Meeting Booked, and not interested means Lost.
 */
export function stageAfterOutreach(current: LeadStatus, kind: string, outcome: string, feedback = ''): LeadStatus | null {
  // A company ruled out (or whose fit couldn't be confirmed) isn't moved along by outreach until a person decides.
  if (['Won', 'Disqualified', 'Existing Client'].includes(current) || outcome === 'skipped' || outcome === 'closed') return null;
  let target: LeadStatus = 'Contacted';
  if (kind === 'call' && outcome === 'connected') {
    // A client now, or one already: wherever the lead was.
    if (feedback === 'Client onboarded') return 'Won';
    if (feedback === 'Already a client') return 'Existing Client';
    if (feedback === 'Demo scheduled' || feedback === 'Demo completed') target = 'Meeting Booked';
    else if ((NOT_INTERESTED as readonly string[]).includes(feedback)) target = 'Lost';
    else if (['Interested', 'Call back later', 'Send details on email / WhatsApp'].includes(feedback)) target = 'Replied';
  }
  if (target === 'Lost') return current === 'Lost' ? null : 'Lost';
  // A lost lead comes back only if the conversation starts again.
  if (current === 'Lost') return target === 'Replied' || target === 'Meeting Booked' ? target : null;
  return (RANK[target] ?? 0) > (RANK[current] ?? 0) ? target : null;
}

/**
 * Moves a lead on after outreach logged at `at`; returns the stage it was at, or '' when it didn't move.
 * Contacted here doesn't start the automatic email follow-ups: Today plans the follow-up rounds.
 */
export async function moveAfterOutreach(db: Db, leadId: number, target: LeadStatus, at: Date): Promise<LeadStatus | ''> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.status === target) return '';
  if (target === 'Contacted') {
    await db.update(leads).set({ status: target, sentAt: lead.sentAt ?? at, updatedAt: at }).where(eq(leads.id, leadId));
    await logActivity(db, leadId, 'stage', 'Moved to Contacted: first outreach logged', target);
  } else {
    await applyStage(db, [leadId], target);
    if (!lead.sentAt) await db.update(leads).set({ sentAt: at }).where(eq(leads.id, leadId));
  }
  return lead.status;
}

/** Undo of a logged step: puts the lead back at the stage it was at, if nothing else moved it since. */
export async function undoOutreachStage(db: Db, leadId: number, from: LeadStatus, to: LeadStatus, at: Date): Promise<void> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.status !== to) return;
  const set: Partial<typeof leads.$inferInsert> = { status: from, updatedAt: new Date() };
  // Contacted was stamped by this step: before it, nothing had gone out.
  if (lead.sentAt && lead.sentAt.getTime() === at.getTime()) set.sentAt = null;
  await db.update(leads).set(set).where(eq(leads.id, leadId));
  await db.delete(activities).where(and(eq(activities.leadId, leadId), eq(activities.kind, 'stage'), eq(activities.stage, to), gte(activities.at, at)));
}
