import type { Client, Icp, Lead, NewLead } from '../db/schema';
import { buildCandidates, hunterDomainSearch, linkedinQuery, pickContact, searchLinkedIn } from './contacts';
import { writeOutreach } from './draft';
import { findEmail, searchWebEmails, SOURCE_LABELS } from './emails';
import { researchLead, websiteEmails, websitePhone } from './research';
import { scoreLead } from './scoring';
import type { Services } from './services';
import { fetchWebsiteText } from './services';
import { domainOf, normalizeWebsite, normCompany } from './text';
import { findOfficialWebsite } from './website';

export type LeadUpdate = Partial<Omit<NewLead, 'id' | 'createdAt'>>;
export type Log = (msg: string, level?: 'info' | 'warn' | 'error') => Promise<void> | void;

/** The client this lead belongs to, matched by company name (ignoring Pvt/Ltd/India…) or website domain. */
export function matchClient(lead: { company: string; website: string }, clients: Client[]): Client | undefined {
  const name = normCompany(lead.company);
  const domain = domainOf(lead.website);
  return clients.find((c) => (name && normCompany(c.company) === name) || (domain && domainOf(c.website) === domain));
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
export async function processLead(svc: Services, lead: Lead, ctx: { icps: Icp[]; clients: Client[] }, log: Log): Promise<LeadUpdate> {
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
      if (!retry.error) {
        await log(`${lead.company}: website ${website ? `corrected from ${domainOf(website)} ` : ''}to ${found}`);
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
  if (site.error) await log(`${lead.company}: website not readable (${site.error})`, 'warn');
  const domain = domainOf(website);
  const input = { company: lead.company, website, domain, city: lead.city };

  const { research, error } = await researchLead(svc, input, icp, site.text);
  if (!research) {
    await log(`${lead.company}: research failed: ${error}`, 'error');
    return { ...corrected, status: 'Error', lastError: error || 'Research failed' };
  }
  const companyPhone = websitePhone(site.text);
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
  const [linkedin, people, webEmails] = await Promise.all([
    searchLinkedIn(svc, linkedinQuery(lead.company, lead.city, research, icp)),
    manual.email ? Promise.resolve({ emails: [], pattern: '', error: '' }) : hunterDomainSearch(svc, domain),
    manual.email ? Promise.resolve([]) : searchWebEmails(svc, domain),
  ]);
  if (linkedin.error) notes.push('LinkedIn search error: ' + linkedin.error);
  if (people.error) notes.push('Email search error: ' + people.error);

  const candidates = buildCandidates(manual, linkedin.people, people.emails);
  const picked = await pickContact(svc, { company: lead.company, domain, city: lead.city, segment: icp.segment }, research, icp, candidates);
  notes.unshift(...picked.notes);
  if (picked.error) notes.push('Contact step error: ' + picked.error);
  const contact = picked.contact;

  const email = contact.name || contact.email
    ? await findEmail(svc, contact, { domain, pattern: people.pattern, websiteEmails: websiteEmails(site.text, domain), webEmails })
    : { email: '', status: 'no email found' as const, source: '' as const, notes: [] };
  notes.push(...email.notes);
  contact.email = email.email;

  const score = scoreLead(research.fitScore, contact, email.status, svc.settings.minScore);
  const update: LeadUpdate = {
    ...base,
    emailStatus: !email.email || !email.source
      ? email.status
      : (email.source === 'pattern' || email.source === 'format') && email.status !== 'valid'
        ? `best guess, not confirmed (${SOURCE_LABELS[email.source]})`
        : `${email.status} (${SOURCE_LABELS[email.source]})`,
    finalScore: score.finalScore,
    scoreBreakdown: score.breakdown,
    otherDecisionMakers: notes.join('\n\n'),
  };
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

  const out = await writeOutreach(svc, { company: lead.company, city: lead.city, segment: icp.segment }, research, icp, contact);
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
