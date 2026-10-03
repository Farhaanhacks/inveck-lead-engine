import type { Client, Icp, Lead, NewLead, NewPerson } from '../db/schema';
import { EMPTY_CONTACT, atBranch, atOtherSite, buildCandidates, findLinkedinProfile, sameName, hunterDomainSearch, linkedinQuery, pickContact, searchLeaders, searchLinkedIn, type Candidate } from './contacts';
import { writeOutreach } from './draft';
import { belongsTo, findEmail, searchWebEmails, SOURCE_LABELS, type EmailFormatUsed } from './emails';
import { fillPattern, lookupEmailFormat, patternLabel } from './email-format';
import { researchLead, websiteEmails, type Research } from './research';
import { scoreLead } from './scoring';
import { contactPriority, icpFor } from '../tiers';
import { currentEmployer } from './employer';
import type { Services } from './services';
import { crawlSite, fetchWebsiteText } from './site-reader';
import { domainOf, errorMessage, normalizeWebsite, normCompany, rootDomain, splitName } from './text';
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
const BEFORE_OUTREACH = ['Awaiting Approval', 'Approved', 'Needs Manual Contact', 'Low Score', 'Rejected', 'Error'];

/**
 * Researches a lead and finds its contacts. With `contactsOnly` (contacts reset), the company research
 * already on the lead is kept and only the people are found again; a lead past outreach keeps its stage.
 */
export async function processLead(
  svc: Services,
  lead: Lead,
  ctx: { icps: Icp[]; clients: Client[]; taken?: TakenContact[] },
  log: Log,
  opts: { contactsOnly?: boolean; teamContact?: boolean } = {},
): Promise<LeadResult> {
  const client = matchClient(lead, ctx.clients);
  if (client) {
    await log(`${lead.company}: already a client (${client.company}), skipped`);
    return { status: 'Existing Client', fitReason: `Already an INVECK client (matches "${client.company}" in Clients)`, lastError: '' };
  }

  const icp = icpFor(lead.segment, ctx.icps);
  if (!icp) return { status: 'Error', lastError: 'No active ICP. Turn on at least one ICP.' };

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
  if (site.via === 'google') await log(`${lead.company}: website blocks automated reading; researched from Google's index of its pages`);
  if (site.error) await log(`${lead.company}: website not readable (${site.error})`, 'warn');
  const domain = rootDomain(website);
  const input = { company: lead.company, website, domain, city: lead.city };

  // Read the rest of the site too: contact, team, about, locations and investor pages.
  const pages = await crawlSite(svc, site);
  if (pages.length) await log(`${lead.company}: read ${pages.length} more page${pages.length === 1 ? '' : 's'} (${pages.map((p) => new URL(p.url).pathname).join(', ')})`);
  const siteText = [site.text, ...pages.map((p) => `## ${p.url}\n${p.text}`)].join('\n\n');

  const reused = opts.contactsOnly && lead.researchSummary ? storedResearch(lead) : null;
  const { research, error } = reused ? { research: reused, error: '' } : await researchLead(svc, input, icp, siteText);
  if (!research) {
    await log(`${lead.company}: research failed: ${error}`, 'error');
    return { ...corrected, status: 'Error', lastError: error || 'Research failed' };
  }
  const base: LeadUpdate = {
    ...corrected,
    segment: icp.segment,
    researchSummary: research.text,
    qualified: research.qualified,
    fitScore: research.fitScore,
    fitReason: research.fitReason,
    lastError: '',
  };
  if (!research.qualified) {
    await log(`${lead.company}: disqualified (fit ${research.fitScore}/10)`);
    return { ...base, status: 'Disqualified' };
  }

  if (opts.contactsOnly) await log(`${lead.company}: finding contacts again from scratch`);
  // Decision-makers: public LinkedIn profiles via Google, plus Hunter's people at the domain. A contact
  // the sales team entered is kept and never replaced; one an earlier research run picked is not the
  // team's (it has to be found again like everyone else). Without a say from the caller, a lead never
  // researched before counts its contact as the team's (typed in when the company was added).
  const fromTeam = opts.teamContact ?? !lead.researchSummary;
  const manual = fromTeam
    ? { name: lead.contactName, title: lead.contactTitle, email: lead.contactEmail, phone: lead.contactPhone, linkedin: lead.contactLinkedin }
    : { name: '', title: '', email: '', phone: '', linkedin: '' };
  const notes: string[] = [];
  const [linkedin, people, webEmails, leaders, news] = await Promise.all([
    searchLinkedIn(svc, linkedinQuery(lead.company, lead.city, icp), lead.company),
    manual.email ? Promise.resolve({ emails: [], pattern: '', error: '' }) : hunterDomainSearch(svc, domain),
    manual.email ? Promise.resolve([]) : searchWebEmails(svc, domain),
    searchLeaders(svc, lead.company, domain, site.text, pages),
    findSignals(svc, lead.company),
  ]);
  if (news.signals.length) await log(`${lead.company}: buying signal: ${news.signals[0].headline}${news.signals.length > 1 ? ` (+${news.signals.length - 1} more)` : ''}`);
  if (linkedin.error) notes.push('LinkedIn search error: ' + linkedin.error);
  // Finding contacts again must not replace good ones with nothing because the search is down.
  if (opts.contactsOnly && linkedin.error && !linkedin.people.length) throw new Error('LinkedIn search failed: ' + linkedin.error);
  if (people.error) notes.push('Email search error: ' + people.error);
  if (leaders.error) notes.push('Leadership search error: ' + leaders.error);

  // Nobody who works somewhere else now ("Plant Head at PepsiCo"), whatever source listed them.
  // Another branch of this company already has its own main contact: they stay with that branch
  // unless their profile places them at this one.
  const firmName = normCompany(lead.company);
  const firmSite = rootDomain(lead.website);
  const otherBranches = (ctx.taken ?? []).filter(
    (t) => t.leadId !== lead.id && t.contactName && ((firmName && normCompany(t.company) === firmName) || (firmSite && rootDomain(t.website) === firmSite)),
  );
  const candidates = buildCandidates(manual, linkedin.people, people.emails, leaders.people).filter(
    (c) =>
      c.source === 'Sales team' ||
      (currentEmployer(c, lead.company) !== 'elsewhere' &&
        // Based at another of the company's sites (unless their role covers the whole company).
        !atOtherSite(c, lead.city) &&
        !(otherBranches.some((t) => sameName(t.contactName, c.name)) && !atBranch(c, lead.city))),
  );
  const published = websiteEmails(siteText, domain);
  const pick = (list: Candidate[]) => pickContact(svc, { company: lead.company, domain, city: lead.city, segment: icp.segment }, research, icp, list);
  const vetted = await vetPick(svc, lead, candidates, linkedin.people, pick, notes, icp);
  const picked = vetted.picked;
  const lookupFailed = vetted.lookupFailed;
  notes.unshift(...picked.notes);
  if (picked.error) notes.push('Contact step error: ' + picked.error);
  const contact = picked.contact;

  const email = contact.name || contact.email
    ? await findEmail(svc, contact, { company: lead.company, domain, pattern: people.pattern, websiteEmails: published, webEmails: [...webEmails, ...leaders.emails] })
    : { email: '', status: 'no email found' as const, source: '' as const, notes: [], reason: 'no contact found' };
  notes.push(...email.notes);
  contact.email = email.email;

  const score = scoreLead(research.fitScore, contact, email.status);
  const update: LeadResult = {
    ...base,
    emailStatus: email.email && email.source
      ? `${email.status} (${SOURCE_LABELS[email.source]}${email.detail ? `: ${email.detail}` : ''})`
      : email.reason ? `no email found: ${email.reason}` : email.status,
    finalScore: score.finalScore,
    scoreBreakdown: score.breakdown,
    otherDecisionMakers: notes.join('\n\n'),
    signals: news.signals.length ? news.signals : lead.signals,
    signalsCheckedAt: new Date(),
  };
  // Everyone else at the company, with the best email we can give them for free.
  let format: EmailFormatUsed | null = email.format ?? (people.pattern && domain ? { pattern: people.pattern, domain, strong: true, detail: `${patternLabel(people.pattern)} per Hunter` } : null);
  const needFormat = picked.ranked.some((c) => !c.email && c.name !== contact.name);
  if (!format && needFormat && domain && svc.settings.useCompanyFormat) {
    const web = await lookupEmailFormat(svc, lead.company, domain);
    if (web) format = { pattern: web.pattern, domain: web.domain, strong: web.strong, detail: patternLabel(web.pattern) };
  }
  // Only people the ICP wants: the chosen contact and anyone whose designation is on the P1/P2/P3 lists.
  // MDs, CEOs and CXOs rarely answer: kept only when there's nobody else on the lists.
  const listed = picked.ranked.filter((c) => contactPriority(c.title, icp) < 99);
  const anyoneBelowTop = listed.some((c) => contactPriority(c.title, icp) < 50);
  const wanted = picked.ranked.filter(
    (c) => sameName(c.name, contact.name) || (contactPriority(c.title, icp) < 99 && (!anyoneBelowTop || contactPriority(c.title, icp) < 50)),
  );
  update.people = companyPeople(wanted, contact, update.emailStatus ?? '', [...published, ...webEmails, ...leaders.emails], format, svc.settings.useCompanyFormat);

  // Never wipe contact details the sales team typed in.
  if (contact.name) update.contactName = contact.name;
  if (contact.title) update.contactTitle = contact.title;
  if (contact.email) update.contactEmail = contact.email;
  if (contact.phone) update.contactPhone = contact.phone;
  if (contact.linkedin) update.contactLinkedin = contact.linkedin;
  // Checked against LinkedIn during research (found there, or looked up by name). A lookup that
  // failed leaves it unchecked, so the next contact check tries again.
  if (contact.name && !lookupFailed) update.contactCheckedAt = new Date();

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
): Promise<{ picked: Picked; lookupFailed: boolean }> {
  let list = candidates;
  let picked = await pick(list);
  for (let attempt = 0; ; attempt++) {
    const contact = picked.contact;
    const fromLinkedin = linkedinPeople.some((p) => sameName(p.name, contact.name) && p.title);
    if (!contact.name || fromLinkedin) return { picked, lookupFailed: false };
    let profile: Awaited<ReturnType<typeof findLinkedinProfile>>;
    try {
      profile = await findLinkedinProfile(svc, contact.name, lead.company, { title: contact.title, city: lead.city });
    } catch (e) {
      notes.push(`LinkedIn lookup for ${contact.name} failed, will retry: ${errorMessage(e)}`);
      return { picked, lookupFailed: true };
    }
    const chosen = list.find((c) => sameName(c.name, contact.name));
    const otherSite = !!profile && atOtherSite({ title: profile.title || contact.title, location: profile.location }, lead.city);
    // Their real current role, from LinkedIn, isn't one INVECK wants ("QA Analyst", "Presales Engineer").
    const unwanted = !!profile?.title && !!icp && contactPriority(profile.title, icp) >= 99;
    const wrong = !!profile && (profile.employer === 'elsewhere' || profile.abroad || otherSite || unwanted) && chosen?.source !== 'Sales team';
    // Three wrong picks in a row: nobody rather than the last wrong one (the team finds someone).
    if (wrong && attempt >= 3) {
      notes.push(`${contact.name} left out too; no one else on the ICP lists checked out`);
      return { picked: { ...picked, contact: { ...EMPTY_CONTACT } }, lookupFailed: false };
    }
    if (wrong && profile) {
      notes.push(
        profile.abroad
          ? `${contact.name} left out: LinkedIn shows them based in ${profile.location || 'another country'}`
          : profile.employer === 'elsewhere'
            ? `${contact.name} left out: LinkedIn shows them at another company now${profile.title ? ` (${profile.title})` : ''}`
            : otherSite
              ? `${contact.name} left out: based in ${profile.location}, not at the ${lead.city} site`
              : `${contact.name} left out: LinkedIn shows their role is ${profile.title}, not one on the ICP lists`,
      );
      list = list.filter((c) => !sameName(c.name, contact.name));
      picked = await pick(list);
      continue;
    }
    if (profile) {
      if (!contact.linkedin) contact.linkedin = profile.url;
      if (chosen && profile.location && !chosen.location) chosen.location = profile.location;
      notes.push(`LinkedIn profile found by name: ${profile.url}`);
      if (profile.title && profile.title.toLowerCase() !== contact.title.toLowerCase()) {
        notes.push(`Title taken from LinkedIn: "${profile.title}"${contact.title ? ` (the other source said "${contact.title}")` : ''}`);
        contact.title = profile.title;
      }
    }
    return { picked, lookupFailed: false };
  }
}

const SOURCE_NAMES: Record<Candidate['source'], string> = {
  'Sales team': 'Sales team',
  LinkedIn: 'LinkedIn',
  'Email database': 'Hunter',
  Web: 'Company website / records',
};

/**
 * The company's people, best first, each with the best free email: one Hunter already knows,
 * one published on the web, or (when the company's format is proven) one built from it.
 */
export function companyPeople(
  ranked: Candidate[],
  main: { name: string; email: string; phone: string; title?: string; linkedin?: string },
  mainEmailStatus: string,
  published: string[],
  format: EmailFormatUsed | null,
  useFormat: boolean,
): Omit<NewPerson, 'leadId'>[] {
  const seen = new Set<string>();
  const out: Omit<NewPerson, 'leadId'>[] = [];
  for (const c of ranked) {
    const key = c.name.toLowerCase().replace(/[^a-z]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const isPrimary = !!main.name && c.name === main.name;
    let email = isPrimary ? main.email : c.email;
    // Emails on candidates come from Hunter, or from the sales team for their own contact.
    let emailStatus = isPrimary ? mainEmailStatus : c.email ? (c.source === 'Sales team' ? 'known (sales team)' : 'known (Hunter)') : '';
    if (!email) {
      const { first, last, middle } = splitName(c.name);
      const f = first.toLowerCase().replace(/[^a-z]/g, '');
      const l = last.toLowerCase().replace(/[^a-z]/g, '');
      const found = published.find((e) => belongsTo(e.split('@')[0], f, l));
      if (found) {
        email = found;
        emailStatus = 'found on the web';
      } else if (format?.strong && useFormat && first.length > 1 && last.length > 1) {
        const local = fillPattern(format.pattern, first, last, middle);
        if (local) {
          email = `${local}@${format.domain}`;
          emailStatus = `likely (company's email format: ${format.detail})`;
        }
      }
    }
    out.push({
      name: c.name,
      // The main contact's title and LinkedIn as checked on LinkedIn during research.
      title: isPrimary ? main.title || c.title : c.title,
      email,
      emailStatus: email ? emailStatus : '',
      // Only a number the sales team gave (phone numbers aren't collected automatically).
      phone: isPrimary ? main.phone : c.source === 'Sales team' ? c.phone : '',
      linkedin: isPrimary ? main.linkedin || c.linkedin : c.linkedin,
      location: c.location ?? '',
      source: SOURCE_NAMES[c.source],
      isPrimary,
    });
    if (out.length >= 15) break;
  }
  return out;
}
