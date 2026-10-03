import { and, asc, eq, exists, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { activities, icps, leads, people, tasks, type Lead, type Person } from './db/schema';
import { logActivity } from './activity';
import { atOtherSite, candidateRank, confirmedAtSite, findLinkedinProfile, rankCandidates, sameName } from './pipeline/contacts';
import { contactFromTeam } from './team-contact';
import { contactPriority, icpFor } from './tiers';
import { makePrimary } from './people';
import { currentEmployer, nameIsTheCompany, registerFirmWebsite, sameFirm } from './pipeline/employer';
import { escalate } from './escalate';
import { refreshMainEmail, refreshPersonEmail } from './email-refresh';
import { istDay } from './tasks';
import { redraftForContact } from './pipeline/redraft';
import type { Services } from './pipeline/services';

/** A designation can change; contacts are checked again after this long. */
const RECHECK_AFTER_DAYS = 30;
/** Leads whose contact is worth keeping right: being worked, or waiting to be handed out. */
const LIVE = ['Awaiting Approval', 'Approved', 'Contacted', 'Replied', 'Meeting Booked', 'Needs Manual Contact', 'Low Score'] as const;

/** A real change of role, not the same role written shorter ("Plant Head at Lumax World" vs "Plant Head"). */
const newRole = (saved: string, found: string) => {
  const [a, b] = [saved.toLowerCase().trim(), found.toLowerCase().trim()];
  return !a || !(a === b || a.startsWith(b) || b.startsWith(a));
};

export type CheckResult = 'corrected' | 'confirmed' | 'not_found' | 'left' | 'skipped';

const staleBefore = (now = new Date()) => new Date(now.getTime() - RECHECK_AFTER_DAYS * 86_400_000);

/** Which leads a tidy-up covers: one lead, one person's leads, or (empty) all. */
export type Scope = { leadId?: number; ownerId?: number };
const inScope = (scope: Scope) =>
  and(scope.leadId ? eq(leads.id, scope.leadId) : undefined, scope.ownerId ? eq(leads.ownerId, scope.ownerId) : undefined);

/**
 * A "designation" that is only the company's name ("CIE Automotive India Ltd") says nothing about the
 * role: clear it, so the person ranks as unknown and a real plant head on file can take over.
 */
export async function clearCompanyTitles(db: Db, scope: Scope = {}): Promise<number> {
  const rows = await db.select({ person: people, lead: leads }).from(people).innerJoin(leads, eq(people.leadId, leads.id)).where(inScope(scope));
  let n = 0;
  for (const { person: p, lead: l } of rows) {
    registerFirmWebsite(l.company, l.website);
    if (!p.title || !sameFirm(p.title, l.company)) continue;
    await db.update(people).set({ title: '' }).where(eq(people.id, p.id));
    if (p.isPrimary && sameFirm(l.contactTitle, l.company)) await db.update(leads).set({ contactTitle: '' }).where(eq(leads.id, l.id));
    n++;
  }
  const leadOnly = await db.select({ id: leads.id, company: leads.company, title: leads.contactTitle }).from(leads).where(and(inScope(scope), ne(leads.contactTitle, '')));
  for (const l of leadOnly) if (sameFirm(l.title, l.company)) await db.update(leads).set({ contactTitle: '' }).where(eq(leads.id, l.id));
  return n;
}

/**
 * Keeps the people on file right, with no searching: clears titles that are just the company's name,
 * removes people who work elsewhere now, and makes the best-ranked person the main contact when
 * outreach hasn't started. Runs when Today, a lead or Contacts opens, and before the morning draw.
 * Returns the leads whose main contact changed (their email gets rewritten).
 */
export async function tidyContacts(db: Db, scope: Scope = {}): Promise<number[]> {
  await clearCompanyTitles(db, scope);
  await purgeFormerEmployees(db, scope);
  return promoteBetterContacts(db, scope);
}

/** An email refresh never stops a contact check. */
async function safely(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {}
}

/** Others checked per company per pass: the best-ranked ones, the people the team would switch to. */
const OTHERS_PER_LEAD = 4;

/**
 * The other people stored at the company get the same check as the main contact: whoever's LinkedIn
 * shows another employer is removed; for the rest the profile is saved and the designation updated.
 */
async function checkOthers(db: Db, svc: Services, lead: Lead, now: Date): Promise<void> {
  const [icpRows, found] = await Promise.all([
    db.select().from(icps),
    db.select().from(people).where(and(eq(people.leadId, lead.id), eq(people.isPrimary, false), isNull(people.checkedAt), isNull(people.passedAt))),
  ]);
  const icp = icpFor(lead.segment, icpRows);
  const next = rankCandidates(found, icp, lead.city).slice(0, OTHERS_PER_LEAD);
  const gone: string[] = [];
  // Email providers for the best-ranked others confirmed now (the main contact has its own lookup).
  const emailBudget = { left: Math.max(0, svc.settings.emailLookupsPerCompany - 1) };
  for (const p of next) {
    // A failed search leaves them unchecked, so the next pass tries again.
    let profile: Awaited<ReturnType<typeof findLinkedinProfile>>;
    try {
      profile = await findLinkedinProfile(svc, p.name, lead.company, { title: p.title, city: lead.city });
    } catch {
      continue;
    }
    const otherSite = !!profile && atOtherSite({ title: profile.title || p.title, location: profile.location }, lead.city);
    if (profile?.employer === 'elsewhere' || profile?.abroad || otherSite) {
      await db.delete(people).where(eq(people.id, p.id));
      gone.push(`${p.name}${profile!.abroad || otherSite ? ` (based in ${profile!.location || 'another country'})` : profile!.title ? ` (now ${profile!.title})` : ''}`);
      continue;
    }
    // No profile confirms they work here: set aside (shown as tried, never picked), not "checked and fine".
    if (!profile) {
      await db.update(people).set({ checkedAt: now, passedAt: now }).where(eq(people.id, p.id));
      continue;
    }
    const retitle = !!profile?.title && newRole(p.title, profile.title);
    await db
      .update(people)
      .set({ checkedAt: now, ...(profile?.location ? { location: profile.location } : {}), ...(profile && !p.linkedin ? { linkedin: profile.url } : {}), ...(retitle ? { title: profile!.title } : {}) })
      .where(eq(people.id, p.id));
    // Confirmed at the company: an inferred or unconfirmed email may be upgraded (never a team's or verified one).
    await safely(() => refreshPersonEmail(db, svc, lead, { ...p, linkedin: p.linkedin || profile!.url }, emailBudget));
  }
  if (gone.length) await logActivity(db, lead.id, 'note', `Removed ${gone.length === 1 ? 'someone who no longer works' : 'people who no longer work'} at ${lead.company}${lead.city ? ` ${lead.city}` : ''} (left, or based elsewhere): ${gone.join('; ')}`);
}

/** Removes, from a lead's people, anyone whose profile shows they work somewhere else now. */
async function dropFormerEmployees(db: Db, lead: Lead): Promise<number> {
  const found = await db.select().from(people).where(and(eq(people.leadId, lead.id), eq(people.isPrimary, false)));
  const gone = found.filter(
    (p) => currentEmployer({ name: p.name, title: p.title }, lead.company) === 'elsewhere' || (p.source === 'LinkedIn' && nameIsTheCompany(p.name, lead.company)),
  );
  if (!gone.length) return 0;
  await db.delete(people).where(inArray(people.id, gone.map((p) => p.id)));
  await logActivity(db, lead.id, 'note', `Removed ${gone.length} ${gone.length === 1 ? 'person' : 'people'} who no longer work at ${lead.company}: ${gone.map((p) => `${p.name} (${p.title})`).join('; ')}`);
  return gone.length;
}

/**
 * Checks one point of contact on LinkedIn by name and company: saves their profile and, when their
 * current LinkedIn title differs from the one on file, corrects the designation, logs it and
 * rewrites the email for them. Runs on its own; nobody has to press anything.
 */
export async function verifyContact(db: Db, svc: Services, lead: Lead, now = new Date(), opts: { mainOnly?: boolean } = {}): Promise<CheckResult> {
  registerFirmWebsite(lead.company, lead.website);
  // Without any search: drop people whose stored title already shows another employer, and move off a
  // main contact who has left.
  await dropFormerEmployees(db, lead);
  if (lead.contactName && currentEmployer({ name: lead.contactName, title: lead.contactTitle }, lead.company) === 'elsewhere') {
    await escalate(db, lead.id, 'left', now, lead.contactTitle);
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (!lead.contactName || !svc.keys.serper) return 'skipped';
  if (!opts.mainOnly) await checkOthers(db, svc, lead, now);
  const emailBudget = { left: svc.settings.emailLookupsPerCompany };
  // The sales team's own contact is theirs to vouch for (their email too: only a conflict is flagged).
  if (await contactFromTeam(db, lead)) {
    if (!lead.contactVerifiedAt) await db.update(leads).set({ contactVerifiedAt: now }).where(eq(leads.id, lead.id));
    await safely(() => refreshMainEmail(db, svc, lead, emailBudget));
    return 'confirmed';
  }
  // Confirmed recently (during research, say): only the others needed it. A contact never confirmed
  // is always checked; being looked at before isn't the same as being confirmed.
  if (lead.contactVerifiedAt && lead.contactVerifiedAt > staleBefore(now)) {
    await safely(() => refreshMainEmail(db, svc, lead, emailBudget));
    return 'confirmed';
  }
  let profile: Awaited<ReturnType<typeof findLinkedinProfile>>;
  try {
    profile = await findLinkedinProfile(svc, lead.contactName, lead.company, { title: lead.contactTitle, city: lead.city });
  } catch {
    // Not "not found": left unchecked so the next pass (Today, the lead page, the morning job) tries again.
    return 'skipped';
  }
  if (!profile) {
    // No profile confirms they work here: set aside (kept, retryable), not "fine for a month".
    await escalate(db, lead.id, 'unverified', now, 'no LinkedIn profile found');
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'not_found';
  }
  if (profile && !profile.abroad && profile.employer !== 'elsewhere' && atOtherSite({ title: profile.title || lead.contactTitle, location: profile.location }, lead.city)) {
    await escalate(db, lead.id, 'other_site', now, profile.location);
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (profile?.abroad) {
    await escalate(db, lead.id, 'abroad', now, profile.location);
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (profile?.employer === 'elsewhere') {
    await escalate(db, lead.id, 'left', now, profile.title);
    // The next person gets checked on the next pass.
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (!confirmedAtSite({ location: profile.location }, lead.city)) {
    // At this company, but nothing shows they are at this site.
    await escalate(db, lead.id, 'unverified', now, 'location not confirmed');
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'not_found';
  }
  const url = lead.contactLinkedin || profile.url;
  const retitle = !!profile.title && newRole(lead.contactTitle, profile.title);
  await db
    .update(leads)
    .set({ contactLinkedin: url, contactCheckedAt: now, contactVerifiedAt: now, ...(retitle ? { contactTitle: profile.title, contactTier: '', updatedAt: now } : {}) })
    .where(eq(leads.id, lead.id));
  // The People list shows the same link and title (the main contact's row, by flag or by name).
  const mine = (await db.select().from(people).where(eq(people.leadId, lead.id))).filter((p) => p.isPrimary || sameName(p.name, lead.contactName));
  for (const p of mine) {
    await db
      .update(people)
      .set({ checkedAt: now, ...(profile.location ? { location: profile.location } : {}), ...(p.linkedin !== url ? { linkedin: url } : {}), ...(retitle || !p.title ? { title: retitle ? profile.title : lead.contactTitle || profile.title } : {}) })
      .where(eq(people.id, p.id));
  }
  if (!lead.contactLinkedin) await logActivity(db, lead.id, 'contact', `LinkedIn profile found for ${lead.contactName}: ${url}`);
  // Confirmed at this company and site: an inferred or unconfirmed email may be upgraded from Apollo.
  await safely(() => refreshMainEmail(db, svc, { ...lead, contactLinkedin: url }, emailBudget));
  if (!retitle) return 'confirmed';
  await logActivity(db, lead.id, 'contact', `Designation updated from LinkedIn: "${profile.title}" (was "${lead.contactTitle || 'blank'}")`);
  if (lead.emailBody) await redraftForContact(db, svc, lead.id);
  return 'corrected';
}

/**
 * Checks the contacts not checked yet (or not for a month), the given person's first when `ownerId`
 * is set, a few at a time. Called before the morning draw, when someone opens Today, and after research.
 */
export async function verifyContacts(
  db: Db,
  svc: Services,
  opts: { ownerId?: number; limit?: number; dueToday?: boolean; mainOnly?: boolean } = {},
): Promise<Record<CheckResult, number>> {
  const tally: Record<CheckResult, number> = { corrected: 0, confirmed: 0, not_found: 0, left: 0, skipped: 0 };
  const stale = staleBefore();
  // Companies with a step due today or earlier: what the team is about to call.
  const onToday = exists(
    db
      .select({ one: sql`1` })
      .from(tasks)
      .where(and(eq(tasks.leadId, leads.id), isNull(tasks.doneAt), lte(tasks.dueDate, istDay()))),
  );
  const due = await db
    .select()
    .from(leads)
    .where(
      and(
        ne(leads.contactName, ''),
        inArray(leads.status, [...LIVE]),
        opts.dueToday ? onToday : undefined,
        or(
          isNull(leads.contactCheckedAt),
          lt(leads.contactCheckedAt, stale),
          // or the main contact isn't confirmed yet, or not for a month
          isNull(leads.contactVerifiedAt),
          lt(leads.contactVerifiedAt, stale),
          // or someone else at the company hasn't been checked yet
          exists(
            db
              .select({ one: sql`1` })
              .from(people)
              .where(and(eq(people.leadId, leads.id), eq(people.isPrimary, false), isNull(people.checkedAt), isNull(people.passedAt))),
          ),
        ),
        opts.ownerId ? eq(leads.ownerId, opts.ownerId) : undefined,
      ),
    )
    // Today's companies first, then whoever has waited longest.
    .orderBy(sql`${onToday} desc`, sql`${leads.contactCheckedAt} nulls first`, asc(leads.id))
    .limit(opts.limit ?? 50);
  for (let i = 0; i < due.length; i += 5) {
    const results = await Promise.allSettled(due.slice(i, i + 5).map((l) => verifyContact(db, svc, l, new Date(), { mainOnly: opts.mainOnly })));
    for (const r of results) tally[r.status === 'fulfilled' ? r.value : 'skipped']++;
  }
  return tally;
}

/**
 * The same check over every company's stored people, with no search: anyone whose title shows another
 * employer goes, and a main contact who has left is replaced (P2 flow). For one lead when `leadId` is set.
 */
export async function purgeFormerEmployees(db: Db, scope: Scope = {}): Promise<number> {
  const rows = await db
    .select({ person: people, lead: leads })
    .from(people)
    .innerJoin(leads, eq(people.leadId, leads.id))
    .where(inScope(scope));
  for (const { lead: l } of rows) registerFirmWebsite(l.company, l.website);
  const gone = rows.filter(
    ({ person: p, lead: l }) =>
      currentEmployer({ name: p.name, title: p.title }, l.company) === 'elsewhere' || (p.source === 'LinkedIn' && nameIsTheCompany(p.name, l.company)),
  );
  const isMain = ({ person: p, lead: l }: (typeof gone)[number]) => p.isPrimary && p.name.toLowerCase() === l.contactName.toLowerCase();
  // Others first, so a main contact who has left is never replaced by someone else who has.
  for (const { person: p, lead: l } of gone.filter((g) => !isMain(g))) {
    await db.delete(people).where(eq(people.id, p.id));
    await logActivity(db, l.id, 'note', `Removed ${p.name} (${p.title}): no longer works at ${l.company}`);
  }
  for (const { person: p, lead: l } of gone.filter(isMain)) {
    await escalate(db, l.id, 'left', new Date(), p.title);
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, l.id));
  }
  return gone.length;
}

/**
 * Leads researched before INVECK's contact priority was enforced may have an MD (or someone off the
 * lists) as the main contact while a plant head or process owner is on file. Before any outreach has
 * happened, the best-ranked person takes over. Returns the leads that changed (their email is redrafted).
 */
export async function promoteBetterContacts(db: Db, scope: Scope = {}): Promise<number[]> {
  const [icpRows, rows] = await Promise.all([
    db.select().from(icps),
    db
      .select({ person: people, lead: leads })
      .from(people)
      .innerJoin(leads, eq(people.leadId, leads.id))
      .where(and(inScope(scope), inArray(leads.status, [...LIVE]))),
  ]);
  const byLead = new Map<number, { lead: Lead; list: Person[] }>();
  for (const r of rows) {
    const g = byLead.get(r.lead.id) ?? { lead: r.lead, list: [] };
    g.list.push(r.person);
    byLead.set(r.lead.id, g);
  }
  const changed: number[] = [];
  for (const { lead, list } of byLead.values()) {
    const icp = icpFor(lead.segment, icpRows);
    if (!icp) continue;
    // The main contact is ranked the same way as everyone else, with where they are based (from their
    // People record), so two people equally placed at this site never look like a step up.
    const primary = list.find((p) => p.isPrimary && p.name.toLowerCase() === lead.contactName.toLowerCase());
    const current = { title: lead.contactTitle, snippet: '', phone: lead.contactPhone, email: lead.contactEmail, location: primary?.location ?? '' };
    // Like research's own pick, the main contact has to be confirmed at this site: someone whose LinkedIn
    // location isn't known, or is another city, is never promoted (the team finds someone instead).
    const others = list.filter(
      (p) => !p.isPrimary && !p.passedAt && p.name.toLowerCase() !== lead.contactName.toLowerCase() && contactPriority(p.title, icp) < 99 && confirmedAtSite(p, lead.city),
    );
    const best = rankCandidates(others, icp, lead.city)[0];
    if (!best) continue;
    // Only a real step up: a better class of contact, not a tie decided by who has a phone number.
    const gain = Math.floor(candidateRank(current, icp, lead.city)) - Math.floor(candidateRank(best, icp, lead.city));
    if (lead.contactName && gain < 5) continue;
    // Not once the team has started on this person (for someone off the lists: once they've actually
    // spoken to them), and never over someone the team chose themselves.
    const offList = contactPriority(lead.contactTitle, icp) >= 99;
    const worked = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.leadId, lead.id), isNotNull(tasks.doneAt), offList ? eq(tasks.outcome, 'connected') : ne(tasks.outcome, 'closed')))
      .limit(1);
    if (worked.length || (!offList && lead.sentAt)) continue;
    const chosen = await db
      .select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.leadId, lead.id), eq(activities.kind, 'contact'), or(like(activities.text, 'Main contact changed%'), like(activities.text, 'Point of contact updated%'))))
      .limit(1);
    if (chosen.length) continue;
    await makePrimary(db, best.id, { why: `INVECK approaches ${best.title || 'them'} before ${lead.contactName ? `${lead.contactName} (${lead.contactTitle || 'no title'})` : 'anyone else'}` });
    await db.update(leads).set({ contactTier: '', contactSince: new Date() }).where(eq(leads.id, lead.id));
    changed.push(lead.id);
  }
  return changed;
}
