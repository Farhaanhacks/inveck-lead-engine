import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { leads, people, type Lead } from './db/schema';
import { logActivity } from './activity';
import { findLinkedinProfile } from './pipeline/contacts';
import { redraftForContact } from './pipeline/redraft';
import type { Services } from './pipeline/services';

/** A designation can change; contacts are checked again after this long. */
const RECHECK_AFTER_DAYS = 30;
/** Leads whose contact is worth keeping right: being worked, or waiting to be handed out. */
const LIVE = ['Awaiting Approval', 'Approved', 'Contacted', 'Replied', 'Meeting Booked', 'Needs Manual Contact', 'Low Score'] as const;

export type CheckResult = 'corrected' | 'confirmed' | 'not_found' | 'skipped';

/**
 * Checks one point of contact on LinkedIn by name and company: saves their profile and, when their
 * current LinkedIn title differs from the one on file, corrects the designation, logs it and
 * rewrites the email for them. Runs on its own; nobody has to press anything.
 */
export async function verifyContact(db: Db, svc: Services, lead: Lead, now = new Date()): Promise<CheckResult> {
  if (!lead.contactName || !svc.keys.serper) return 'skipped';
  const profile = await findLinkedinProfile(svc, lead.contactName, lead.company);
  if (!profile) {
    await db.update(leads).set({ contactCheckedAt: now }).where(eq(leads.id, lead.id));
    return 'not_found';
  }
  const url = lead.contactLinkedin || profile.url;
  const retitle = !!profile.title && profile.title.toLowerCase() !== lead.contactTitle.toLowerCase();
  await db
    .update(leads)
    .set({ contactLinkedin: url, contactCheckedAt: now, ...(retitle ? { contactTitle: profile.title, contactTier: '', updatedAt: now } : {}) })
    .where(eq(leads.id, lead.id));
  await db.update(people).set({ linkedin: url, ...(retitle ? { title: profile.title } : {}) }).where(and(eq(people.leadId, lead.id), eq(people.isPrimary, true)));
  if (!lead.contactLinkedin) await logActivity(db, lead.id, 'contact', `LinkedIn profile found for ${lead.contactName}: ${url}`);
  if (!retitle) return 'confirmed';
  await logActivity(db, lead.id, 'contact', `Designation updated from LinkedIn: "${profile.title}" (was "${lead.contactTitle || 'blank'}")`);
  if (lead.emailBody) await redraftForContact(db, svc, lead.id);
  return 'corrected';
}

/**
 * Checks the contacts not checked yet (or not for a month), the given person's first when `ownerId`
 * is set, a few at a time. Called before the morning draw, when someone opens Today, and after research.
 */
export async function verifyContacts(db: Db, svc: Services, opts: { ownerId?: number; limit?: number } = {}): Promise<Record<CheckResult, number>> {
  const tally: Record<CheckResult, number> = { corrected: 0, confirmed: 0, not_found: 0, skipped: 0 };
  if (!svc.keys.serper) return tally;
  const stale = new Date(Date.now() - RECHECK_AFTER_DAYS * 86_400_000);
  const due = await db
    .select()
    .from(leads)
    .where(
      and(
        ne(leads.contactName, ''),
        inArray(leads.status, [...LIVE]),
        or(isNull(leads.contactCheckedAt), lt(leads.contactCheckedAt, stale)),
        opts.ownerId ? eq(leads.ownerId, opts.ownerId) : undefined,
      ),
    )
    .orderBy(sql`${leads.contactCheckedAt} nulls first`, asc(leads.id))
    .limit(opts.limit ?? 50);
  for (let i = 0; i < due.length; i += 5) {
    const results = await Promise.allSettled(due.slice(i, i + 5).map((l) => verifyContact(db, svc, l)));
    for (const r of results) tally[r.status === 'fulfilled' ? r.value : 'skipped']++;
  }
  return tally;
}
