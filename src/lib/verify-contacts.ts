import { and, asc, eq, exists, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { activities, icps, leads, people, tasks, type Lead, type Person } from './db/schema';
import { logActivity } from './activity';
import { reconcileContactStatus } from './contact-status';
import { vagueLocation } from './pipeline/employer';
import { atOtherSite, candidateRank, confirmedAtSite, findLinkedinProfile, rankCandidates, sameName, siteEvidence } from './pipeline/contacts';

/** The places a profile shows, kept apart: where they live, where the job is, the site their title names. */
function placeFields(profile: { location: string; jobLocation: string; responsibility: string } | null | undefined) {
  if (!profile) return {};
  return {
    // "India" says nothing new: a specific place already on file is never replaced by it.
    ...(profile.location && !vagueLocation(profile.location) ? { location: profile.location } : {}),
    ...(profile.jobLocation ? { jobLocation: profile.jobLocation } : {}),
    ...(profile.responsibility ? { responsibility: profile.responsibility } : {}),
  };
}
import { contactFromTeam } from './team-contact';
import { contactPriority, icpFor } from './tiers';
import { makePrimary } from './people';
import { basedAbroad, currentEmployer, nameIsTheCompany, sameFirm } from './pipeline/employer';
import { learnFirm, recallFirm } from './pipeline/firm-identity';
import { knowPlaces } from './pipeline/places';
import { dbEnrichmentCache } from './enrichment-cache';
import { escalate } from './escalate';
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
  const cache = dbEnrichmentCache(db);
  for (const l of new Map(rows.map(({ lead }) => [lead.id, lead])).values()) await recallFirm(cache, l.company, l.website);
  for (const { person: p, lead: l } of rows) {
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
  await purgeUnwanted(db, scope);
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
  for (const p of next) {
    // A failed search leaves them unchecked, so the next pass tries again.
    let profile: Awaited<ReturnType<typeof findLinkedinProfile>>;
    try {
      profile = await findLinkedinProfile(svc, p.name, lead.company, { title: p.title, city: lead.city });
    } catch {
      continue;
    }
    const otherSite = !!profile && atOtherSite({ ...profile!, title: profile!.title || p.title }, lead.city);
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
      .set({ checkedAt: now, ...(profile?.evidence ? { evidence: profile.evidence } : {}), ...placeFields(profile), ...(profile && !p.linkedin ? { linkedin: profile.url } : {}), ...(retitle ? { title: profile!.title } : {}) })
      .where(eq(people.id, p.id));
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
  const result = await checkLeadContacts(db, svc, lead, now, opts);
  // Whatever the check found, the lead's status follows its contact.
  await reconcileContactStatus(db, lead.id);
  return result;
}

async function checkLeadContacts(db: Db, svc: Services, lead: Lead, now: Date, opts: { mainOnly?: boolean }): Promise<CheckResult> {
  await learnFirm(svc, lead.company, lead.website);
  await knowPlaces(svc, [lead.city]);
  // Without any search: drop people whose stored title already shows another employer, and move off a
  // main contact who has left.
  await dropFormerEmployees(db, lead);
  if (lead.contactName && currentEmployer({ name: lead.contactName, title: lead.contactTitle }, lead.company) === 'elsewhere') {
    await moveOn(db, svc, lead, 'left', now, lead.contactTitle)
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (!svc.keys.serper) return 'skipped';
  // No point of contact: someone set aside earlier because LinkedIn couldn't confirm them may be
  // confirmed now (a search that failed, a profile updated since).
  if (!lead.contactName) return reconfirmSetAside(db, svc, lead, now);
  if (!opts.mainOnly) await checkOthers(db, svc, lead, now);
  // The sales team's own contact is theirs to vouch for.
  if (await contactFromTeam(db, lead)) {
    if (!lead.contactVerifiedAt) await db.update(leads).set({ contactVerifiedAt: now }).where(eq(leads.id, lead.id));
    return 'confirmed';
  }
  // Confirmed recently (during research, say): only the others needed it. A contact never confirmed
  // is always checked; being looked at before isn't the same as being confirmed.
  if (lead.contactVerifiedAt && lead.contactVerifiedAt > staleBefore(now)) {
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
    await moveOn(db, svc, lead, 'unverified', now, 'no LinkedIn profile found')
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'not_found';
  }
  if (profile && !profile.abroad && profile.employer !== 'elsewhere' && atOtherSite({ ...profile, title: profile.title || lead.contactTitle }, lead.city)) {
    await moveOn(db, svc, lead, 'other_site', now, profile.location)
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (profile?.abroad) {
    await moveOn(db, svc, lead, 'abroad', now, profile.location)
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (profile?.employer === 'elsewhere') {
    await moveOn(db, svc, lead, 'left', now, profile.title)
    // The next person gets checked on the next pass.
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'left';
  }
  if (profile.employer !== 'here') {
    // Conflicting evidence (the job here has ended, though an undated line still shows it): not confirmed.
    await moveOn(db, svc, lead, 'unverified', now, profile.evidence || 'LinkedIn does not confirm a current job here');
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, lead.id));
    return 'not_found';
  }
  if (!confirmedAtSite({ ...profile, title: profile.title || lead.contactTitle }, lead.city)) {
    // At this company, but nothing shows they are at this site.
    await moveOn(db, svc, lead, 'unverified', now, `${siteEvidence({ ...profile, title: profile.title || lead.contactTitle }, lead.city)}, not confirmed at the ${lead.city} site`)
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
      .set({ checkedAt: now, ...(profile.evidence ? { evidence: profile.evidence } : {}), ...placeFields(profile), ...(p.linkedin !== url ? { linkedin: url } : {}), ...(retitle || !p.title ? { title: retitle ? profile.title : lead.contactTitle || profile.title } : {}) })
      .where(eq(people.id, p.id));
  }
  if (!lead.contactLinkedin) await logActivity(db, lead.id, 'contact', `LinkedIn profile found for ${lead.contactName}: ${url}`);
  if (!retitle) return 'confirmed';
  await logActivity(db, lead.id, 'contact', `Designation updated from LinkedIn: "${profile.title}" (was "${lead.contactTitle || 'blank'}")`);
  if (lead.emailBody) await redraftForContact(db, svc, lead.id);
  return 'corrected';
}

/** The P2 flow, then the draft rewritten when the point of contact changed or there is none now. */
async function moveOn(db: Db, svc: Services, lead: Lead, why: Parameters<typeof escalate>[2], now: Date, detail = '') {
  const result = await escalate(db, lead.id, why, now, detail);
  if (lead.emailBody && (result.switched || result.cleared)) await safely(() => redraftForContact(db, svc, lead.id));
  return result;
}

/** People set aside because LinkedIn couldn't confirm them (rows from before the reason was kept: the set-aside main contact). */
const setAside = (p: Person) => !!p.passedAt && (p.passedReason === 'unverified' || (p.passedReason === '' && p.isPrimary));
const RECHECK_DAYS = 7;

/**
 * A lead with no point of contact: the best of the people set aside as unconfirmed are looked up on
 * LinkedIn again (each at most once a week). One confirmed at this company and site becomes the main
 * contact again, the lead goes back to waiting for approval when they can be reached, and the draft
 * is rewritten for them.
 */
async function reconfirmSetAside(db: Db, svc: Services, lead: Lead, now: Date): Promise<CheckResult> {
  const icp = icpFor(lead.segment, await db.select().from(icps));
  const due = new Date(now.getTime() - RECHECK_DAYS * 86_400_000);
  const aside = (await db.select().from(people).where(eq(people.leadId, lead.id))).filter(
    (p) => setAside(p) && (!p.checkedAt || p.checkedAt < due) && (!icp || contactPriority(p.title, icp) < 99),
  );
  if (!aside.length) return 'skipped';
  for (const p of rankCandidates(aside, icp, lead.city).slice(0, 2)) {
    let profile: Awaited<ReturnType<typeof findLinkedinProfile>>;
    try {
      profile = await findLinkedinProfile(svc, p.name, lead.company, { title: p.title, city: lead.city });
    } catch {
      return 'skipped';
    }
    await db.update(people).set({ checkedAt: now, isPrimary: false, ...placeFields(profile) }).where(eq(people.id, p.id));
    if (!profile || profile.abroad || profile.employer !== 'here' || !confirmedAtSite({ ...profile, title: profile.title || p.title }, lead.city)) continue;
    await db
      .update(people)
      .set({ passedAt: null, passedReason: '', whyNot: '', linkedin: p.linkedin || profile.url, ...(profile.title ? { title: profile.title } : {}) })
      .where(eq(people.id, p.id));
    await makePrimary(db, p.id, { why: 'LinkedIn now confirms them at this company and site' });
    const reachable = !!(p.linkedin || profile.url) || !!p.email;
    await db
      .update(leads)
      .set({ contactCheckedAt: now, contactVerifiedAt: now, contactSince: now, ...(lead.status === 'Needs Manual Contact' && reachable ? { status: 'Awaiting Approval' as const } : {}) })
      .where(eq(leads.id, lead.id));
    if (lead.emailBody) await safely(() => redraftForContact(db, svc, lead.id));
    return 'confirmed';
  }
  return 'not_found';
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
        inArray(leads.status, [...LIVE]),
        opts.dueToday ? onToday : undefined,
        or(
          // No point of contact, and someone set aside as unconfirmed is due another look.
          and(
            eq(leads.contactName, ''),
            exists(
              db
                .select({ one: sql`1` })
                .from(people)
                .where(
                  and(
                    eq(people.leadId, leads.id),
                    isNotNull(people.passedAt),
                    or(eq(people.passedReason, 'unverified'), and(eq(people.passedReason, ''), eq(people.isPrimary, true))),
                    or(isNull(people.checkedAt), lt(people.checkedAt, new Date(Date.now() - RECHECK_DAYS * 86_400_000))),
                  ),
                ),
            ),
          ),
          // A point of contact not checked yet, or not for a month
          and(
            ne(leads.contactName, ''),
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
/**
 * People INVECK doesn't contact, found before the rules were tightened: anyone not on the ICP's lists
 * (directors, HR, admin, IT…) and anyone based outside India. Set aside as not contacts (hidden, never
 * contacted, nothing deleted); a main contact among them is replaced by the next confirmed person (or
 * the lead waits for the team to find one). People the team entered themselves are never touched.
 */
export async function purgeUnwanted(db: Db, scope: Scope = {}): Promise<number> {
  const [icpRows, rows] = await Promise.all([
    db.select().from(icps),
    db.select({ person: people, lead: leads }).from(people).innerJoin(leads, eq(people.leadId, leads.id)).where(inScope(scope)),
  ]);
  const verdict = ({ person: p, lead: l }: (typeof rows)[number]): string => {
    if (p.source === 'Sales team' || p.source === 'Added by the team' || p.passedReason === 'excluded') return '';
    if (p.location && basedAbroad(p.location, '', p.linkedin)) return `based in ${p.location}, outside India`;
    const icp = icpFor(l.segment, icpRows);
    if (icp && p.title.trim() && contactPriority(p.title, icp) >= 99) return `${p.title}: not on the ICP's contact lists (directors, HR, admin and IT aren't contacted)`;
    return '';
  };
  const gone = rows.map((r) => ({ ...r, why: verdict(r) })).filter((r) => r.why);
  const isMain = ({ person: p, lead: l }: (typeof gone)[number]) => p.isPrimary && p.name.toLowerCase() === l.contactName.toLowerCase();
  const now = new Date();
  for (const { person: p, why } of gone.filter((g) => !isMain(g))) {
    await db.update(people).set({ passedAt: now, passedReason: 'excluded', whyNot: why, isPrimary: false }).where(eq(people.id, p.id));
  }
  for (const { lead: l, why } of gone.filter(isMain)) {
    await escalate(db, l.id, 'off_list', now, why);
    await db.update(leads).set({ contactCheckedAt: null }).where(eq(leads.id, l.id));
  }
  return gone.length;
}

export async function purgeFormerEmployees(db: Db, scope: Scope = {}): Promise<number> {
  const rows = await db
    .select({ person: people, lead: leads })
    .from(people)
    .innerJoin(leads, eq(people.leadId, leads.id))
    .where(inScope(scope));
  const cache = dbEnrichmentCache(db);
  for (const l of new Map(rows.map(({ lead }) => [lead.id, lead])).values()) await recallFirm(cache, l.company, l.website);
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
