import { KnownBranches } from '../branches';
import type { Client, Icp, Lead, NewLead, NewPerson } from '../db/schema';
import { EMPTY_CONTACT, atBranch, atOtherSite, buildCandidates, confirmedAtSite, contactStanding, siteEvidence, findLinkedinProfile, rankCandidates, sameName, linkedinQuery, pickContact, searchLeaders, searchLinkedIn, type Candidate } from './contacts';
import { writeOutreach } from './draft';
import { researchLead, type Research } from './research';
import { buildSources } from './fit';
import { scoreLead } from './scoring';
import { contactPriority, icpFor } from '../tiers';
import { resolveIcp } from '../icp-match';
import { currentEmployer } from './employer';
import { learnFirm } from './firm-identity';
import { checkCompanyName } from './company-name';
import { firmAliasesOf } from './employer';
import { knowPlaces } from './places';
import type { Services } from './services';
import { crawlSite, fetchWebsiteText } from './site-reader';
import { domainOf, errorMessage, normalizeWebsite, normCompany, rootDomain } from './text';
import { findOfficialWebsite } from './website';
import { findSignals } from './signals';

export type LeadUpdate = Partial<Omit<NewLead, 'id' | 'createdAt'>>;
/** What research produced: the lead's new fields, and everyone found at the company. */
export type LeadResult = LeadUpdate & { people?: Omit<NewPerson, 'leadId'>[] };
export type Log = (msg: string, level?: 'info' | 'warn' | 'error') => Promise<void> | void;

/** The client this lead belongs to, matched by company name (ignoring Pvt/Ltd/India…) or website domain. */
export function matchClient(lead: { company: string; website: string }, clients: Client[]): Client | undefined {
  const name = normCompany(lead.company);
  const domain = rootDomain(lead.website);
  return clients.find((c) => (name && normCompany(c.company) === name) || (domain && rootDomain(c.website) === domain));
}

export { icpFor };

/**
 * Takes one lead through the whole pipeline and returns the fields to save:
 * client check → website → research & qualify → decision-maker search → contact pick →
 * email search → score → outreach draft. Never throws for a single lead's problems;
 * they end up in `status: 'Error'` and `lastError`.
 */
/** The company research saved on a lead, for finding its contacts again without researching it again. */
function storedResearch(lead: Lead): Research {
  return {
    summary: lead.researchSummary,
    industry: '',
    companySize: '',
    locations: lead.city,
    inventoryComplexity: '',
    warehousing3pl: '',
    erpWms: '',
    verificationNeed: '',
    fitReason: lead.fitReason,
    pitchHook: '',
    targetRoles: [],
    fitScore: lead.fitScore ?? 0,
    qualified: lead.qualified ?? true,
    text: lead.researchSummary,
  };
}

/** Another lead's main contact: used so two branches of one company don't get the same person. */
export type TakenContact = { leadId: number; company: string; website: string; contactName: string };

/** Stages before anything was sent: re-finding contacts here may set the stage and rewrite the draft. */
const BEFORE_OUTREACH = ['Awaiting Approval', 'Approved', 'Needs Manual Contact', 'Low Score', 'Rejected', 'Error', 'Needs Review', 'Disqualified'];

/**
 * Researches a lead and finds its contacts. With `contactsOnly` (contacts reset), the company research
 * already on the lead is kept and only the people are found again; a lead past outreach keeps its stage.
 */
/** Why a lead from INVECK's own lead list is set aside. */
export const OWN_LEAD_REASON = "Already in INVECK's own lead list (Leads INVECK already has, on ICPs & clients)";

export async function processLead(
  svc: Services,
  lead: Lead,
  ctx: { icps: Icp[]; clients: Client[]; taken?: TakenContact[]; ownLeads?: KnownBranches },
  log: Log,
  opts: { contactsOnly?: boolean; teamContact?: boolean } = {},
): Promise<LeadResult> {
  const client = matchClient(lead, ctx.clients);
  if (client) {
    await log(`${lead.company}: already a client (${client.company}), skipped`);
    return { status: 'Existing Client', fitReason: `Already an INVECK client (matches "${client.company}" in Clients)`, lastError: '' };
  }

  // Already in INVECK's own lead list at this location: the team has it, so it isn't researched here.
  if (!opts.contactsOnly && ctx.ownLeads?.has(lead.company, lead.website, lead.city)) {
    await log(`${lead.company}${lead.city ? ` (${lead.city})` : ''}: already in INVECK's own lead list, skipped`);
    return { status: 'Rejected', fitReason: OWN_LEAD_REASON, lastError: '' };
  }

  // A person ruled the company out: that call stands until someone asks for the fit to be reassessed.
  if (!opts.contactsOnly && lead.fitOverride === 'not_fit') {
    await log(`${lead.company}: marked not a fit by the team; not researched again (Reassess fit checks it again)`);
    return { status: 'Disqualified', fitDecision: lead.fitDecision, lastError: '' };
  }

  // Finding contacts again keeps the lead's own ICP (its contact lists). Anything else checks the fit
  // against the one active ICP named by the lead's segment; no match is flagged, never guessed.
  let icp: Icp;
  if (opts.contactsOnly) {
    const own = icpFor(lead.segment, ctx.icps);
    if (!own) throw new Error(`segment "${lead.segment}" matches no ICP, so there are no contact lists to search with`);
    icp = own;
  } else {
    const match = resolveIcp(lead.segment, ctx.icps);
    if (!match.icp) {
      await log(`${lead.company}: needs review: ${match.detail}`, 'warn');
      return { status: 'Needs Review', qualified: null, fitStatus: 'review', fitDecision: `Needs review: ${match.detail}`, assessedIcp: '', assessedAt: new Date(), finalScore: null, lastError: '' };
    }
    icp = match.icp;
  }
  // A person confirmed the fit: research again keeps their call and only finds contacts and drafts.
  const keepFit = !opts.contactsOnly && lead.fitOverride === 'qualified';

  let website = normalizeWebsite(lead.website);
  let site = await fetchWebsiteText(svc, website);
  // No website, or one that doesn't load (often a wrong domain): look the real one up.
  const corrected: LeadUpdate = {};
  if (!website || site.error) {
    const found = await findOfficialWebsite(svc, lead.company, lead.city);
    if (found && found !== domainOf(website)) {
      const retry = await fetchWebsiteText(svc, normalizeWebsite(found));
      // Keep a found address even when its page can't be read (big sites often block
      // automated readers): it's still the domain the company's emails are on.
      if (!retry.error || !website) {
        await log(`${lead.company}: website ${website ? `corrected from ${domainOf(website)} ` : ''}set to ${found}`);
        website = normalizeWebsite(found);
        site = retry;
        corrected.website = found;
        const client = matchClient({ company: lead.company, website }, ctx.clients);
        if (client) {
          await log(`${lead.company}: already a client (${client.company}), skipped`);
          return { ...corrected, status: 'Existing Client', fitReason: `Already an INVECK client (matches "${client.company}" in Clients)`, lastError: '' };
        }
      }
    }
  }
  // The other names its staff use: its website name ("Lumax World") and its LinkedIn page's name
  // ("Micron Technology"); and where the site is, to tell who works there.
  // The name, checked against the company's own website before it is searched for, matched against
  // profiles or written into outreach: a name a letter or two off what the site and domain show is
  // corrected (the first one kept as nameAsFound); one that can't be settled goes to review. A name the
  // team typed in, or a lead whose fit a person confirmed, is left as it is.
  if (lead.nameEvidence !== 'set by the team' && lead.fitOverride !== 'qualified' && site.text) {
    await learnFirm(svc, lead.company, website);
    const check = checkCompanyName(lead.company, rootDomain(website), site.text, firmAliasesOf(lead.company));
    if (check.status === 'corrected') {
      await log(`${lead.company}: name corrected to "${check.name}": ${check.evidence}`, 'warn');
      Object.assign(corrected, { company: check.name, nameAsFound: lead.nameAsFound || lead.company, nameEvidence: check.evidence } satisfies LeadUpdate);
      lead = { ...lead, company: check.name };
      // The right name may be a client's, or on INVECK's own list.
      const client = matchClient({ company: lead.company, website }, ctx.clients);
      if (client) return { ...corrected, status: 'Existing Client', fitReason: `Already an INVECK client (matches "${client.company}" in Clients)`, lastError: '' };
      if (!opts.contactsOnly && ctx.ownLeads?.has(lead.company, website, lead.city)) return { ...corrected, status: 'Rejected', fitReason: OWN_LEAD_REASON, lastError: '' };
    } else if (check.status === 'mismatch') {
      await log(`${lead.company}: needs review: company name not confirmed: ${check.evidence}`, 'warn');
      return {
        ...corrected,
        status: 'Needs Review',
        fitStatus: 'review',
        fitDecision: `Needs review: the company name isn't confirmed: ${check.evidence}. Correct the name under Company (or confirm it by saving it), then Reassess fit.`,
        finalScore: null,
        lastError: '',
      };
    } else if (check.status === 'confirmed') {
      corrected.nameEvidence = check.evidence;
    }
  }
  await learnFirm(svc, lead.company, website);
  await knowPlaces(svc, [lead.city]);
  if (site.via === 'google') await log(`${lead.company}: website blocks automated reading; researched from Google's index of its pages`);
  if (site.error) await log(`${lead.company}: website not readable (${site.error})`, 'warn');
  const domain = rootDomain(website);
  const input = { company: lead.company, website, domain, city: lead.city };

  // Read the rest of the site too: contact, team, about, locations and investor pages.
  const pages = await crawlSite(svc, site);
  if (pages.length) await log(`${lead.company}: read ${pages.length} more page${pages.length === 1 ? '' : 's'} (${pages.map((p) => new URL(p.url).pathname).join(', ')})`);
  // What research read, numbered so each piece of evidence can point at the page it came from.
  const read = buildSources([
    ...(site.via === 'google' && site.results?.length
      ? site.results.map((r) => ({ url: r.url, title: "Google's index of the website", text: [r.title, r.snippet].filter(Boolean).join('\n') }))
      : site.text
        ? [{ url: site.url || website, title: 'company website', text: site.text }]
        : []),
    ...pages.map((p) => ({ url: p.url, title: '', text: p.text })),
  ], undefined, undefined, lead.company);

  const reused = (opts.contactsOnly || keepFit) && lead.researchSummary ? storedResearch(lead) : null;
  const { research, error } = reused ? { research: reused, error: '' } : await researchLead(svc, input, icp, read, log);
  if (!research) {
    await log(`${lead.company}: research failed: ${error}`, 'error');
    return { ...corrected, status: 'Error', lastError: error || 'Research failed' };
  }
  const base: LeadUpdate = { ...corrected, segment: icp.segment, lastError: '' };
  const a = keepFit ? undefined : research.assessment;
  if (keepFit) {
    // The fit a person confirmed stands; research done now only adds the company description.
    if (!reused && research.text) base.researchSummary = research.text;
  } else if (a) {
    // An answer that couldn't be used leaves the company description from before.
    if (research.text) base.researchSummary = research.text;
    Object.assign(base, {
      qualified: a.status === 'qualified' ? true : a.status === 'not_fit' ? false : null,
      fitScore: a.fitScore,
      fitReason: research.fitReason,
      fitStatus: a.status,
      fitDecision: a.reason,
      fitEvidence: a.evidence,
      riskFlags: a.risks,
      assessedIcp: icp.segment,
      assessedAt: new Date(),
    } satisfies LeadUpdate);
    // Commercial risk is recorded apart from the fit; it changes the decision only as an ICP deal-breaker.
    if (a.risks.length) await log(`${lead.company}: commercial risk noted, kept apart from the ICP fit: ${a.risks.map((r) => r.label).join(', ')}`, 'warn');
    if (a.status === 'not_fit') {
      await log(`${lead.company}: not a fit${a.fitScore != null ? ` (ICP fit ${a.fitScore}/10)` : ''}: ${a.reason.replace(/^Not a fit: /, '')}`);
      return { ...base, status: 'Disqualified', finalScore: null };
    }
    if (a.status === 'review') {
      await log(`${lead.company}: ${a.reason.replace(/^Needs review: /, 'needs review: ')}`, 'warn');
      return { ...base, status: 'Needs Review', finalScore: null };
    }
  } else if (!research.qualified) {
    // Saved research that didn't qualify: nothing to find contacts for, and the stage stays.
    await log(`${lead.company}: not qualified, so contacts weren't searched`);
    return base;
  }

  if (opts.contactsOnly) await log(`${lead.company}: finding contacts again from scratch`);
  // Decision-makers: public LinkedIn profiles via Google, and leaders named on the website. A contact
  // the sales team entered is kept and never replaced; one an earlier research run picked is not the
  // team's (it has to be found again like everyone else). Without a say from the caller, a lead never
  // researched before counts its contact as the team's (typed in when the company was added).
  const fromTeam = opts.teamContact ?? !lead.researchSummary;
  const manual = fromTeam
    ? { name: lead.contactName, title: lead.contactTitle, email: lead.contactEmail, phone: lead.contactPhone, linkedin: lead.contactLinkedin }
    : { name: '', title: '', email: '', phone: '', linkedin: '' };
  const notes: string[] = [];
  const [linkedin, leaders, news] = await Promise.all([
    searchLinkedIn(svc, linkedinQuery(lead.company, lead.city, icp), lead.company, lead.city),
    searchLeaders(svc, lead.company, domain, site.text, pages),
    findSignals(svc, lead.company),
  ]);
  if (news.signals.length) await log(`${lead.company}: buying signal: ${news.signals[0].headline}${news.signals.length > 1 ? ` (+${news.signals.length - 1} more)` : ''}`);
  if (linkedin.error) {
    notes.push('LinkedIn search error: ' + linkedin.error);
    await log(`${lead.company}: LinkedIn search failed: ${linkedin.error}${/credit/i.test(linkedin.error) ? ' (Google search, SERPER_API_KEY, is out of credits)' : ''}`, 'error');
  }
  // The search failed and found nobody: "nobody found" would be wrong, so contacts are searched
  // again on a later run (research and draft kept).
  const searchFailed = !!linkedin.error && !linkedin.people.length;
  // Finding contacts again must not replace good ones with nothing because the search is down.
  if (opts.contactsOnly && linkedin.error && !linkedin.people.length) throw new Error('LinkedIn search failed: ' + linkedin.error);
  if (leaders.error) notes.push('Leadership search error: ' + leaders.error);

  // Nobody who works somewhere else now ("Plant Head at PepsiCo"), whatever source listed them.
  // Another branch of this company already has its own main contact: they stay with that branch
  // unless their profile places them at this one.
  const firmName = normCompany(lead.company);
  const firmSite = rootDomain(lead.website);
  const otherBranches = (ctx.taken ?? []).filter(
    (t) => t.leadId !== lead.id && t.contactName && ((firmName && normCompany(t.company) === firmName) || (firmSite && rootDomain(t.website) === firmSite)),
  );
  const candidates = buildCandidates(manual, linkedin.people, leaders.people).filter(
    (c) =>
      c.source === 'Sales team' ||
      (currentEmployer(c, lead.company) !== 'elsewhere' &&
        // Based at another of the company's sites (unless their role covers the whole company).
        !atOtherSite(c, lead.city) &&
        !(otherBranches.some((t) => sameName(t.contactName, c.name)) && !atBranch(c, lead.city))),
  );
  // The best-ranked people whose location the search result didn't show: looked up by name, so
  // they can be confirmed at the site (or not) instead of being set aside for a missing location.
  const unplaced = rankCandidates(
    candidates.filter((c) => c.source === 'LinkedIn' && !c.location?.trim() && contactPriority(c.title, icp) < 99),
    icp,
    lead.city,
  ).slice(0, 3);
  for (const c of lead.city ? unplaced : []) {
    try {
      const profile = await findLinkedinProfile(svc, c.name, lead.company, { title: c.title, city: lead.city });
      if (profile?.employer === 'here' && profile.location) c.location = profile.location;
    } catch {
      // Left without a location: not the main contact this time.
    }
  }
  const pick = (list: Candidate[]) => pickContact(svc, { company: lead.company, domain, city: lead.city, segment: icp.segment }, research, icp, list);
  const vetted = await vetPick(svc, lead, candidates, linkedin.people, pick, notes, icp);
  const picked = vetted.picked;
  const lookupFailed = vetted.lookupFailed;
  notes.unshift(...picked.notes);
  if (picked.error) notes.push('Contact step error: ' + picked.error);
  const contact = picked.contact;

  // Emails are never looked up (like phone numbers): only an address the sales team typed in is kept.
  const teamEmail = contact.emailSource === 'manual' ? contact.email.trim() : '';
  contact.email = teamEmail;

  const score = scoreLead(research.fitScore, contact, teamEmail ? 'likely' : 'no email found');
  const update: LeadResult = {
    ...base,
    ...teamEmailFields(teamEmail),
    finalScore: score.finalScore,
    scoreBreakdown: score.breakdown,
    otherDecisionMakers: notes.join('\n\n'),
    signals: news.signals.length ? news.signals : lead.signals,
    signalsCheckedAt: new Date(),
  };
  // Only people the ICP wants: the chosen contact and anyone whose designation is on the P1/P2/P3 lists.
  // MDs, CEOs and CXOs rarely answer: kept only when there's nobody else on the lists.
  const listed = picked.ranked.filter((c) => contactPriority(c.title, icp) < 99);
  const anyoneBelowTop = listed.some((c) => contactPriority(c.title, icp) < 50);
  const wanted = picked.ranked.filter(
    (c) => sameName(c.name, contact.name) || (contactPriority(c.title, icp) < 99 && (!anyoneBelowTop || contactPriority(c.title, icp) < 50)),
  );
  update.people = companyPeople(wanted, contact);
  const now = new Date();
  // Nobody confirmed at the site: people found at the company but not confirmed at this site are kept
  // as potential contacts pending verification, checked on LinkedIn again weekly (reconfirmSetAside):
  // corporate contacts (owner, partner, CEO, director) for the team to review, and people whose location
  // no result showed. A corporate contact based in another city is never taken for a site contact.
  if (!contact.name && lead.city) {
    for (const p of update.people) {
      if (p.source !== SOURCE_NAMES.LinkedIn || confirmedAtSite(p, lead.city)) continue;
      const { standing, reason } = contactStanding({ ...p, title: p.title ?? '' }, icp, lead.city);
      p.passedAt = now;
      p.passedReason = 'unverified';
      p.whyNot =
        standing === 'corporate'
          ? reason
          : `Potential company contact, pending verification: title and current employment need confirmation; ${siteEvidence(p, lead.city)}, not confirmed at the ${lead.city} site`;
    }
  }
  // Everyone else LinkedIn shows working at the company now is kept too, set aside with the reason they
  // aren't a contact for this site (another site, a role not on the lists, the top of the company while
  // others are found), so "no contact" is never left unexplained. They are never contacted or checked
  // automatically; the team can still make one of them the main contact.
  const extras = linkedin.people
    .filter((p) => !update.people!.some((q) => sameName(q.name, p.name)))
    .map((p) => {
      const branchContact = otherBranches.find((t) => sameName(t.contactName, p.name));
      const { standing, reason } = contactStanding(p, icp, lead.city);
      const why = branchContact
        ? `The main contact for another ${branchContact.company} lead`
        : standing === 'site' || (standing === 'corporate' && anyoneBelowTop)
          ? `Top of the company (${p.title}): approached only when nobody else on the ICP lists is found`
          : reason;
      return { person: { ...p, id: '', source: 'LinkedIn' as const, email: '', phone: '' }, corporate: standing === 'corporate', why };
    })
    .sort((a, b) => Number(b.corporate) - Number(a.corporate));
  const setAside = companyPeople(
    extras.map((x) => x.person),
    { name: '', email: '', phone: '' },
  );
  for (const p of setAside) {
    const why = extras.find((x) => x.person.name === p.name)?.why ?? '';
    p.passedAt = now;
    p.passedReason = 'excluded';
    p.whyNot = why;
  }
  update.people.push(...setAside);

  // Never wipe contact details the sales team typed in. A person chosen now gets their own email
  // (or none): never the previous contact's.
  if (contact.name) update.contactName = contact.name;
  if (contact.title) update.contactTitle = contact.title;
  if (contact.name || contact.email) update.contactEmail = contact.email;
  if (contact.phone) update.contactPhone = contact.phone;
  if (contact.linkedin) update.contactLinkedin = contact.linkedin;
  // Checked against LinkedIn during research (found there, or looked up by name). A lookup that
  // failed leaves it unchecked, so the next contact check tries again.
  if (contact.name && !lookupFailed) update.contactCheckedAt = new Date();
  // Confirmed at this company and site, or not (the morning draw holds back an unconfirmed contact).
  update.contactVerifiedAt = contact.name && vetted.verified ? new Date() : null;

  if (searchFailed && !contact.name) {
    update.refetchPending = true;
    update.lastError = `Contacts not searched: the LinkedIn search failed (${linkedin.error.slice(0, 120)}). Searched again automatically on a later run.`;
  }

  // Contacts reset on a lead already in outreach: new people, same stage, no new first email.
  if (opts.contactsOnly && !BEFORE_OUTREACH.includes(lead.status)) {
    await log(`${lead.company}: contacts found again (${contact.name || 'nobody on the lists yet'}); stage kept at ${lead.status}`);
    return update;
  }
  const out = await writeOutreach(svc, { company: lead.company, city: lead.city, segment: icp.segment }, research, icp, contact, news.signals.length ? news.signals : lead.signals);
  if (!out.draft) {
    // The research and contacts stand; the missing draft is written again in the background.
    await log(`${lead.company}: drafting failed, will retry: ${out.error}`, 'warn');
    return { ...update, status: score.status, lastError: `Drafting failed (retrying automatically): ${out.error || 'unknown error'}` };
  }
  await log(`${lead.company}: draft ready for ${contact.name || 'the team (no contact found yet)'} (score ${score.finalScore})`);
  return {
    ...update,
    status: score.status,
    emailSubject: out.draft.subject,
    emailBody: out.draft.body,
    linkedinMessage: out.draft.linkedin,
  };
}

type Picked = Awaited<ReturnType<typeof pickContact>>;

/**
 * Titles from email records and old pages go stale: unless the chosen contact came from the LinkedIn
 * search itself, they are looked up on LinkedIn by name and their current LinkedIn title wins. When
 * their profile shows they work somewhere else now, or are based abroad, they are dropped and the next
 * best is picked (up to three times). Someone the sales team named is never dropped. A lookup that
 * fails is reported as such (`lookupFailed`), so the contact is checked again later.
 */
export async function vetPick(
  svc: Services,
  lead: { company: string; city: string },
  candidates: Candidate[],
  linkedinPeople: { name: string; title: string }[],
  pick: (list: Candidate[]) => Promise<Picked>,
  notes: string[],
  icp?: Parameters<typeof contactPriority>[1],
): Promise<{ picked: Picked; lookupFailed: boolean; verified: boolean }> {
  let list = candidates;
  let picked = await pick(list);
  for (let attempt = 0; ; attempt++) {
    const contact = picked.contact;
    if (!contact.name) return { picked, lookupFailed: false, verified: false };
    const chosen = list.find((c) => sameName(c.name, contact.name));
    // The sales team's own contact is theirs to vouch for. Someone found in the LinkedIn search has a
    // profile showing this company, and was only picked with a location confirmed at the site.
    if (chosen?.source === 'Sales team') return { picked, lookupFailed: false, verified: true };
    if (linkedinPeople.some((p) => sameName(p.name, contact.name) && p.title)) return { picked, lookupFailed: false, verified: true };
    let profile: Awaited<ReturnType<typeof findLinkedinProfile>>;
    try {
      profile = await findLinkedinProfile(svc, contact.name, lead.company, { title: contact.title, city: lead.city });
    } catch (e) {
      notes.push(`LinkedIn lookup for ${contact.name} failed, will retry: ${errorMessage(e)}`);
      return { picked, lookupFailed: true, verified: false };
    }
    // Their real current role, from LinkedIn, isn't one INVECK wants ("QA Analyst", "Presales Engineer").
    const unwanted = !!profile?.title && !!icp && contactPriority(profile.title, icp) >= 99;
    // Not found on LinkedIn means not confirmed, not "fine": they are set aside, not used.
    const why = !profile
      ? `${contact.name} set aside: no LinkedIn profile confirms they work at ${lead.company}`
      : profile.abroad
        ? `${contact.name} left out: LinkedIn shows them based in ${profile.location || 'another country'}`
        : profile.employer === 'unknown'
          ? `${contact.name} left out: ${profile.evidence || "LinkedIn doesn't confirm a current job here"}`
          : profile.employer !== 'here'
          ? `${contact.name} left out: LinkedIn shows them at another company now${profile.title ? ` (${profile.title})` : ''}`
          : !confirmedAtSite({ ...profile, title: profile.title || contact.title }, lead.city)
            ? `${contact.name} left out: ${siteEvidence({ ...profile, title: profile.title || contact.title }, lead.city)}, not confirmed at the ${lead.city} site`
            : unwanted
              ? `${contact.name} left out: LinkedIn shows their role is ${profile.title}, not one on the ICP lists`
              : '';
    if (why) {
      notes.push(why);
      // Three wrong picks in a row: nobody rather than the last wrong one (the team finds someone).
      if (attempt >= 2) {
        notes.push('No one else on the ICP lists could be confirmed at this site');
        return { picked: { ...picked, contact: { ...EMPTY_CONTACT } }, lookupFailed: false, verified: false };
      }
      list = list.filter((c) => !sameName(c.name, contact.name));
      picked = await pick(list);
      continue;
    }
    const found = profile!;
    if (!contact.linkedin) contact.linkedin = found.url;
    if (chosen && found.location && !chosen.location) chosen.location = found.location;
    if (chosen && found.jobLocation) chosen.jobLocation = found.jobLocation;
    if (chosen && found.responsibility) chosen.responsibility = found.responsibility;
    if (chosen && found.evidence) chosen.evidence = found.evidence;
    notes.push(`LinkedIn profile found by name: ${found.url}`);
    if (found.title && found.title.toLowerCase() !== contact.title.toLowerCase()) {
      notes.push(`Title taken from LinkedIn: "${found.title}"${contact.title ? ` (the other source said "${contact.title}")` : ''}`);
      contact.title = found.title;
    }
    return { picked, lookupFailed: false, verified: true };
  }
}

const SOURCE_NAMES: Record<Candidate['source'], string> = {
  'Sales team': 'Sales team',
  LinkedIn: 'LinkedIn',
  'Email database': 'Hunter',
  Web: 'Company website / records',
};

/** The email fields for an address the sales team typed in (or none): emails are never looked up. */
export function teamEmailFields(email: string) {
  return {
    emailStatus: email ? 'entered by the team' : '',
    emailSource: email ? 'manual' : '',
    emailVerification: email ? 'unverified' : '',
    emailProviderStatus: '',
    emailRetrievedAt: null,
  };
}

/**
 * The company's people, best first. Emails are never looked up: only an address the sales team gave
 * (for their contact, or the main contact's typed in) comes with a person.
 */
export function companyPeople(ranked: Candidate[], main: { name: string; email: string; phone: string; title?: string; linkedin?: string }): Omit<NewPerson, 'leadId'>[] {
  const seen = new Set<string>();
  const out: Omit<NewPerson, 'leadId'>[] = [];
  for (const c of ranked) {
    const key = c.name.toLowerCase().replace(/[^a-z]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const isPrimary = !!main.name && c.name === main.name;
    const email = isPrimary ? main.email : c.source === 'Sales team' ? c.email : '';
    out.push({
      name: c.name,
      // The main contact's title and LinkedIn as checked on LinkedIn during research.
      title: isPrimary ? main.title || c.title : c.title,
      email,
      ...teamEmailFields(email),
      // Only a number the sales team gave (phone numbers aren't collected automatically).
      phone: isPrimary ? main.phone : c.source === 'Sales team' ? c.phone : '',
      linkedin: isPrimary ? main.linkedin || c.linkedin : c.linkedin,
      location: c.location ?? '',
      jobLocation: c.jobLocation ?? '',
      responsibility: c.responsibility ?? '',
      evidence: c.evidence ?? (c.source === 'Sales team' ? 'Entered by the team' : ''),
      source: SOURCE_NAMES[c.source],
      isPrimary,
    });
    if (out.length >= 15) break;
  }
  return out;
}
