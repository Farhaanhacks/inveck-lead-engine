import type { Client, Icp, Lead, NewLead, NewPerson } from '../db/schema';
import { buildCandidates, hunterDomainSearch, linkedinQuery, pickContact, searchLeaders, searchLinkedIn, type Candidate } from './contacts';
import { writeOutreach } from './draft';
import { belongsTo, findEmail, searchWebEmails, SOURCE_LABELS, type EmailFormatUsed } from './emails';
import { fillPattern, lookupEmailFormat, patternLabel } from './email-format';
import { researchLead, websiteEmails, websitePhone } from './research';
import { scoreLead } from './scoring';
import type { Services } from './services';
import { crawlSite, fetchWebsiteText } from './site-reader';
import { domainOf, normalizeWebsite, normCompany, rootDomain, splitName } from './text';
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

export function icpFor(segment: string, icps: Icp[]): Icp | undefined {
  const s = segment.trim().toLowerCase();
  return icps.find((i) => i.segment.trim().toLowerCase() === s) || icps[0];
}

/**
 * Takes one lead through the whole pipeline and returns the fields to save:
 * client check → website → research & qualify → decision-maker search → contact pick →
 * email search → score → outreach draft. Never throws for a single lead's problems;
 * they end up in `status: 'Error'` and `lastError`.
 */
export async function processLead(svc: Services, lead: Lead, ctx: { icps: Icp[]; clients: Client[] }, log: Log): Promise<LeadResult> {
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
  const contactPage = pages.find((p) => /contact|reach|enquir/i.test(new URL(p.url).pathname));

  const { research, error } = await researchLead(svc, input, icp, siteText);
  if (!research) {
    await log(`${lead.company}: research failed: ${error}`, 'error');
    return { ...corrected, status: 'Error', lastError: error || 'Research failed' };
  }
  const companyPhone = (contactPage && websitePhone(contactPage.text)) || websitePhone(siteText);
  const base: LeadUpdate = {
    ...corrected,
    ...(companyPhone ? { companyPhone } : {}),
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

  // Decision-makers: public LinkedIn profiles via Google, plus Hunter's people at the domain.
  const manual = {
    name: lead.contactName,
    title: lead.contactTitle,
    email: lead.contactEmail,
    phone: lead.contactPhone,
    linkedin: lead.contactLinkedin,
  };
  const notes: string[] = [];
  const [linkedin, people, webEmails, leaders, news] = await Promise.all([
    searchLinkedIn(svc, linkedinQuery(lead.company, lead.city, research, icp), lead.company),
    manual.email ? Promise.resolve({ emails: [], pattern: '', error: '' }) : hunterDomainSearch(svc, domain),
    manual.email ? Promise.resolve([]) : searchWebEmails(svc, domain),
    searchLeaders(svc, lead.company, domain, site.text, pages),
    findSignals(svc, lead.company),
  ]);
  if (news.signals.length) await log(`${lead.company}: buying signal: ${news.signals[0].headline}${news.signals.length > 1 ? ` (+${news.signals.length - 1} more)` : ''}`);
  if (linkedin.error) notes.push('LinkedIn search error: ' + linkedin.error);
  if (people.error) notes.push('Email search error: ' + people.error);
  if (leaders.error) notes.push('Leadership search error: ' + leaders.error);

  const candidates = buildCandidates(manual, linkedin.people, people.emails, leaders.people);
  const published = websiteEmails(siteText, domain);
  const picked = await pickContact(svc, { company: lead.company, domain, city: lead.city, segment: icp.segment }, research, icp, candidates);
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
  update.people = companyPeople(picked.ranked, contact, update.emailStatus ?? '', [...published, ...webEmails, ...leaders.emails], format, svc.settings.useCompanyFormat);

  // Never wipe contact details the sales team typed in.
  if (contact.name) update.contactName = contact.name;
  if (contact.title) update.contactTitle = contact.title;
  if (contact.email) update.contactEmail = contact.email;
  if (contact.phone) update.contactPhone = contact.phone;
  if (contact.linkedin) update.contactLinkedin = contact.linkedin;

  if (!score.readyForDraft) {
    await log(`${lead.company}: ${score.statusWithoutDraft} (score ${score.finalScore})`);
    return { ...update, status: score.statusWithoutDraft };
  }

  const out = await writeOutreach(svc, { company: lead.company, city: lead.city, segment: icp.segment }, research, icp, contact, news.signals.length ? news.signals : lead.signals);
  if (!out.draft) {
    await log(`${lead.company}: drafting failed: ${out.error}`, 'error');
    return { ...update, status: 'Error', lastError: out.error || 'Drafting failed' };
  }
  await log(`${lead.company}: draft ready for ${contact.name || 'the team'} (score ${score.finalScore})`);
  return {
    ...update,
    status: 'Awaiting Approval',
    emailSubject: out.draft.subject,
    emailBody: out.draft.body,
    linkedinMessage: out.draft.linkedin,
  };
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
  main: { name: string; email: string; phone: string },
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
      title: c.title,
      email,
      emailStatus: email ? emailStatus : '',
      phone: isPrimary ? main.phone || c.phone : c.phone,
      linkedin: c.linkedin,
      source: SOURCE_NAMES[c.source],
      isPrimary,
    });
    if (out.length >= 15) break;
  }
  return out;
}
