import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './db';
import { contactLinkedin, leads, people, type ContactLinkedin } from './db/schema';

/** The LinkedIn steps a BDA tracks for one contact on Today. */
export const LINKEDIN_STATUSES = ['not_started', 'request_sent', 'accepted', 'message_sent', 'follow_up_sent', 'response_received'] as const;
export type LinkedinStatus = (typeof LINKEDIN_STATUSES)[number];
export const LINKEDIN_STATUS_LABEL: Record<LinkedinStatus, string> = {
  not_started: 'Not started',
  request_sent: 'Connection request sent',
  accepted: 'Connection accepted',
  message_sent: 'Message sent',
  follow_up_sent: 'Follow-up sent',
  response_received: 'Response received',
};
export const MAX_REMARKS = 1000;

/**
 * Where a contact stands before anyone has set it here: what the lead's existing LinkedIn outcome (the tracker's)
 * already says for the main contact. Shown only; nothing is saved until the BDA changes it.
 */
export function statusFromOutcome(outcome: string): LinkedinStatus {
  if (outcome === 'Request sent') return 'request_sent';
  if (outcome === 'Accepted') return 'accepted';
  if (outcome === 'Replied') return 'response_received';
  return 'not_started';
}

export type LinkedinView = { status: LinkedinStatus; remarks: string };

/** Saved activity for these leads' contacts, keyed "leadId:personId". */
export async function loadLinkedinActivity(db: Db, leadIds: number[]): Promise<Map<string, LinkedinView>> {
  const out = new Map<string, LinkedinView>();
  if (!leadIds.length) return out;
  for (const r of await db.select().from(contactLinkedin).where(inArray(contactLinkedin.leadId, leadIds))) out.set(`${r.leadId}:${r.personId}`, { status: r.status as LinkedinStatus, remarks: r.remarks });
  return out;
}

/**
 * Saves a contact's LinkedIn status and remarks. The contact must be a person at that lead (or 0, the lead's main
 * contact when it has no people row); each contact has its own row, so saving one never touches another.
 */
export async function saveLinkedinActivity(db: Db, input: { leadId: number; personId: number; status: unknown; remarks: unknown; userId: number }): Promise<{ ok: true; row: ContactLinkedin } | { ok: false; error: string }> {
  const status = String(input.status ?? '') as LinkedinStatus;
  if (!LINKEDIN_STATUSES.includes(status)) return { ok: false, error: 'Choose one of the LinkedIn statuses.' };
  const remarks = String(input.remarks ?? '').trim();
  if (remarks.length > MAX_REMARKS) return { ok: false, error: `Keep the remarks to ${MAX_REMARKS} characters or fewer.` };
  if (!Number.isInteger(input.leadId) || !Number.isInteger(input.personId) || input.personId < 0) return { ok: false, error: 'Unknown contact.' };
  if (!(await db.select({ id: leads.id }).from(leads).where(eq(leads.id, input.leadId))).length) return { ok: false, error: 'That company no longer exists.' };
  if (input.personId > 0 && !(await db.select({ id: people.id }).from(people).where(and(eq(people.id, input.personId), eq(people.leadId, input.leadId)))).length) return { ok: false, error: 'That contact is no longer at this company. Refresh the page.' };
  const now = new Date();
  const [row] = await db
    .insert(contactLinkedin)
    .values({ leadId: input.leadId, personId: input.personId, status, remarks, updatedBy: input.userId, updatedAt: now })
    .onConflictDoUpdate({ target: [contactLinkedin.leadId, contactLinkedin.personId], set: { status, remarks, updatedBy: input.userId, updatedAt: now } })
    .returning();
  return { ok: true, row };
}
