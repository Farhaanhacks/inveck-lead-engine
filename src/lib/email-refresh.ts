import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import { activities, leads, people, type Lead, type Person } from './db/schema';
import { logActivity } from './activity';
import { apolloEmail } from './pipeline/apollo';
import { emailLabel, verifyEmail, type ApolloBudget } from './pipeline/emails';
import type { Services } from './pipeline/services';
import { sameName } from './pipeline/contacts';
import { rootDomain } from './pipeline/text';

export type EmailKind = 'team' | 'verified' | 'inferred' | 'unverified' | 'none';

/**
 * What an email on file is: typed by the team, verified, inferred from the company's format, or
 * unconfirmed. From the stored fields, or for rows saved before they existed, from the readable status.
 */
export function emailKind(e: { email: string; emailSource: string; emailVerification: string; emailStatus: string }): EmailKind {
  if (!e.email) return 'none';
  if (e.emailSource === 'manual') return 'team';
  if (e.emailSource) return e.emailVerification === 'verified' ? 'verified' : e.emailSource === 'inferred' ? 'inferred' : 'unverified';
  const s = e.emailStatus.toLowerCase();
  if (/entered by the team|sales team/.test(s)) return 'team';
  if (/^valid/.test(s)) return 'verified';
  if (/^likely|email format/.test(s)) return 'inferred';
  return 'unverified';
}

export type RefreshOutcome = 'upgraded' | 'conflict' | 'kept' | 'skipped' | 'failed';

type Holder = { name: string; linkedin: string; email: string; emailSource: string; emailVerification: string; emailStatus: string };

async function logOnce(db: Db, leadId: number, text: string) {
  const [seen] = await db.select({ id: activities.id }).from(activities).where(and(eq(activities.leadId, leadId), eq(activities.text, text))).limit(1);
  if (!seen) await logActivity(db, leadId, 'note', text);
}

/**
 * One contact's email, looked at again: an inferred or unconfirmed address is replaced when Apollo
 * has a verified address for the same person at the same company (Apollo's own "verified", or its
 * address confirmed by the mail-server check). An address the team typed is never replaced, and a
 * verified one never by anything less: a different verified address from Apollo is logged as a
 * conflict for review instead. Nothing here throws; a failed lookup changes nothing.
 */
export async function refreshEmail(
  db: Db,
  svc: Services,
  lead: Pick<Lead, 'id' | 'company' | 'website'>,
  holder: Holder,
  save: (fields: Record<string, unknown>) => Promise<void>,
  budget: ApolloBudget,
): Promise<RefreshOutcome> {
  if (!holder.name || !svc.keys.apollo) return 'skipped';
  const kind = emailKind(holder);
  const q = { name: holder.name, company: lead.company, domain: rootDomain(lead.website), linkedin: holder.linkedin };
  const current = holder.email.trim().toLowerCase();

  // Team-typed and verified addresses stay. Only an earlier Apollo result is looked at (no credit),
  // to flag a different verified address for the team to review.
  if (kind === 'team' || kind === 'verified') {
    const cached = await apolloEmail(svc, q, { cacheOnly: true });
    if (cached.outcome === 'found' && cached.status === 'verified' && cached.email !== current) {
      await logOnce(
        db,
        lead.id,
        `Email conflict for review: ${holder.name}'s address on file is ${holder.email} (${kind === 'team' ? 'entered by the team' : 'verified'}); Apollo has a verified ${cached.email}. The address on file is kept.`,
      );
      return 'conflict';
    }
    return 'kept';
  }

  const cachedFirst = await apolloEmail(svc, q, { cacheOnly: true });
  let r = cachedFirst;
  if (cachedFirst.outcome === 'skipped' && cachedFirst.reason === 'no cached Apollo result') {
    if (budget.left <= 0) return 'skipped';
    r = await apolloEmail(svc, q);
    if (r.outcome !== 'skipped') budget.left--;
  }
  if (r.outcome === 'failed') return 'failed';
  if (r.outcome !== 'found') return 'kept';

  let verifiedBy: 'Apollo' | 'mail-server check';
  if (r.status === 'verified') verifiedBy = 'Apollo';
  else {
    // Not verified by Apollo: only the mail-server check can make it an upgrade.
    const check = await verifyEmail(svc, r.email);
    if (check.status !== 'valid') return 'kept';
    verifiedBy = 'mail-server check';
  }
  const result = { email: r.email, source: 'apollo' as const, verification: 'verified' as const, verifiedBy, providerStatus: r.status, retrievedAt: r.retrievedAt };
  await save({
    email: r.email,
    emailStatus: emailLabel(result),
    emailSource: 'apollo',
    emailVerification: 'verified',
    emailProviderStatus: r.status,
    emailRetrievedAt: new Date(r.retrievedAt),
  });
  await logActivity(
    db,
    lead.id,
    'contact',
    `Email upgraded for ${holder.name}: ${current ? `${current} (${kind})` : 'none on file'} → ${r.email} (Apollo, verified by ${verifiedBy})`,
  );
  return 'upgraded';
}

/** The lead's main contact (lead and their People row together). */
export async function refreshMainEmail(db: Db, svc: Services, lead: Lead, budget: ApolloBudget): Promise<RefreshOutcome> {
  const holder = {
    name: lead.contactName,
    linkedin: lead.contactLinkedin,
    email: lead.contactEmail,
    emailSource: lead.emailSource,
    emailVerification: lead.emailVerification,
    emailStatus: lead.emailStatus,
  };
  return refreshEmail(db, svc, lead, holder, async (f) => {
    const { email, ...rest } = f as { email: string } & Record<string, unknown>;
    await db.update(leads).set({ contactEmail: email, ...rest, updatedAt: new Date() }).where(eq(leads.id, lead.id));
    const mine = (await db.select().from(people).where(eq(people.leadId, lead.id))).filter((p) => p.isPrimary || sameName(p.name, lead.contactName));
    for (const p of mine) await db.update(people).set({ email, ...rest }).where(eq(people.id, p.id));
  }, budget);
}

/** Someone else at the company (their People row). */
export async function refreshPersonEmail(db: Db, svc: Services, lead: Lead, p: Person, budget: ApolloBudget): Promise<RefreshOutcome> {
  return refreshEmail(db, svc, lead, p, async (f) => {
    await db.update(people).set(f).where(eq(people.id, p.id));
  }, budget);
}
