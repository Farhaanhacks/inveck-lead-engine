import type { Icp } from '../db/schema';
import { tierOf } from '../tiers';
import { askJson } from './ai';
import { CONTACT_PROMPT, LEADERS_PROMPT } from './prompts';
import type { Research } from './research';
import type { Services } from './services';
import { googleSearch, hunter } from './services';
import { fetchWebsiteText } from './site-reader';
import { asBool, asList, asText, asTextList, errorMessage, searchName } from './text';
import { isBlockedDomain } from './website';

export type Candidate = {
  id: string;
  source: 'Sales team' | 'LinkedIn' | 'Email database' | 'Web';
  name: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  snippet: string;
};

export type ManualContact = { name: string; title: string; email: string; phone: string; linkedin: string };

export type Contact = {
  name: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  /** Where the email came from, when it came with the contact. */
  emailSource: '' | 'hunter' | 'manual';
  roleMatch: boolean;
  reason: string;
};

export const EMPTY_CONTACT: Contact = { name: '', title: '', email: '', phone: '', linkedin: '', emailSource: '', roleMatch: false, reason: '' };

/** Google query for public LinkedIn profiles of the target roles at this company. */
export function linkedinQuery(company: string, city: string, research: Research, icp: Icp): string {
  const roles = (research.targetRoles.length ? research.targetRoles : icp.targetTitles.split(','))
    .map((r) => String(r).trim())
    .filter(Boolean)
    .slice(0, 4);
  return [
    'site:linkedin.com/in',
    `"${company}"`,
    roles.length ? '(' + roles.map((r) => `"${r}"`).join(' OR ') + ')' : '',
    city,
  ]
    .filter(Boolean)
    .join(' ');
}

type LinkedInPerson = Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>;

function toLinkedInPeople(results: { title?: string; link?: string; snippet?: string }[]): LinkedInPerson[] {
  return results
    .filter((r) => /linkedin\.com\/in\//i.test(r.link || ''))
    .map((r) => {
      const title = String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
      const [name, ...rest] = title.split(/\s+[-–|]\s+/);
      return { name: (name || '').trim(), title: rest.join(' - ').trim(), linkedin: (r.link || '').split('?')[0], snippet: r.snippet || '' };
    })
    .filter((p) => p.name);
}

/**
 * Public LinkedIn profiles via Google. Runs the targeted query (company + roles + city) and a
 * broad one (company + any senior role), since small companies rarely match the targeted one.
 */
export async function searchLinkedIn(svc: Services, query: string, company = ''): Promise<{ people: LinkedInPerson[]; error: string }> {
  const name = searchName(company);
  const queries = [query];
  if (name) queries.push(`site:linkedin.com/in "${name}" (founder OR director OR CEO OR owner OR partner OR head OR manager OR president)`);
  const settled = await Promise.allSettled(queries.map((q) => googleSearch(svc, q)));
  const people: LinkedInPerson[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const p of toLinkedInPeople(s.value)) {
      const key = p.linkedin.toLowerCase().replace(/^https?:\/\/[a-z]+\./, '');
      if (seen.has(key)) continue;
      seen.add(key);
      people.push(p);
    }
  }
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  return { people, error: failed && !people.length ? errorMessage(failed.reason) : '' };
}

const leaderSchema = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, title: { type: 'string' } },
        required: ['name', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['people'],
  additionalProperties: false,
};

const HONORIFIC = /^(mr|mrs|ms|dr|er|ca|cs|cma|prof|shri|smt|capt)\.?\s+/i;

/**
 * Leadership named on the company's own pages (its about/leadership page and home page) and
 * in Google results (company records, news). The AI only extracts; a name is kept only if it
 * really appears in the text.
 */
export async function searchLeaders(
  svc: Services,
  company: string,
  domain: string,
  homeText: string,
  crawled: { url: string; text: string }[] = [],
): Promise<{ people: Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>[]; emails: string[]; error: string }> {
  const name = searchName(company);
  if (!name) return { people: [], emails: [], error: '' };
  // A team/leadership page from the site crawl saves a search and a fetch.
  const teamPage = crawled.find((p) => /team|leadership|management|board|directors|people|key-?(managerial|person)/i.test(new URL(p.url).pathname));
  try {
    const [web, filings, pages] = await Promise.all([
      googleSearch(svc, `"${name}" (founder OR director OR CEO OR "managing director" OR chairman OR partner OR "head of")`).catch(() => []),
      // Official records: annual reports and stock-exchange filings name these officers, often with emails.
      googleSearch(svc, `"${name}" ("company secretary" OR "compliance officer" OR "chief financial officer" OR "plant head" OR "works manager" OR "general manager")`).catch(() => []),
      domain && !teamPage
        ? googleSearch(svc, `site:${domain} (leadership OR management OR team OR directors OR "about us" OR founder)`).catch(() => [])
        : Promise.resolve([]),
    ]);
    const home = homeText.replace(/\s+/g, ' ');
    const pageLink = teamPage?.url || pages.map((r) => r.link || '').find((l) => l && !/\.(pdf|jpg|png)$/i.test(l));
    const page = teamPage ?? (pageLink ? await fetchWebsiteText(svc, pageLink, { useGoogle: false }) : { text: '' });

    const results = [...web, ...filings];
    const webLines = results
      .filter((r) => !isBlockedDomain((r.link || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]) || /zaubacorp|tofler|thecompanycheck|instafinancials|bseindia|nseindia/.test(r.link || ''))
      .slice(0, 16)
      .map((r) => `- ${r.title || ''}: ${r.snippet || ''} (${r.link || ''})`);
    // Emails at the company's domain published in those results (e.g. the company secretary's).
    const emails = domain
      ? [...new Set(results.flatMap((r) => `${r.title} ${r.snippet}`.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []))].filter((e) =>
          e.endsWith('@' + domain),
        )
      : [];
    const source = [
      page.text ? `## ${pageLink}\n${page.text.replace(/\s+/g, ' ').slice(0, 15000)}` : '',
      home ? `## Home page\n${home.slice(0, 8000)}` : '',
      webLines.length ? `## Google results\n${webLines.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!source) return { people: [], emails, error: '' };

    const result = await askJson(svc, LEADERS_PROMPT, `Company: ${company}${domain ? ` (${domain})` : ''}\n\n${source}`, leaderSchema);
    if (result.error !== undefined) return { people: [], emails, error: result.error };
    const haystack = source.toLowerCase();
    const people = asList(result.data.people)
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
      .map((p) => ({ name: asText(p.name).replace(HONORIFIC, '').trim(), title: asText(p.title) }))
      .filter((p) => {
        const parts = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        return parts.length >= 2 && parts.every((w) => haystack.includes(w));
      })
      .slice(0, 12)
      .map((p) => ({ ...p, linkedin: '', snippet: 'Named on the company website or in public company records' }));
    return { people, emails, error: '' };
  } catch (e) {
    return { people: [], emails: [], error: errorMessage(e) };
  }
}

type HunterEmail = { value?: string; first_name?: string; last_name?: string; position?: string; phone_number?: string; linkedin?: string };

/** People with known work emails at a domain, and the domain's email format (e.g. "{first}.{last}"). */
export async function hunterDomainSearch(svc: Services, domain: string): Promise<{ emails: HunterEmail[]; pattern: string; error: string }> {
  if (!domain) return { emails: [], pattern: '', error: '' };
  try {
    const data = await hunter<{ emails?: HunterEmail[]; pattern?: string }>(svc, 'domain-search', { domain, type: 'personal', limit: '10' });
    return { emails: Array.isArray(data.emails) ? data.emails : [], pattern: typeof data.pattern === 'string' ? data.pattern : '', error: '' };
  } catch (e) {
    return { emails: [], pattern: '', error: errorMessage(e) };
  }
}

const norm = (s: string) => s.toLowerCase().replace(HONORIFIC, '').replace(/[^a-z]/g, '');
/** "Dr. Jitendra Govind Joshi" and "Jitendra Joshi" are the same person. */
function sameName(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const words = (s: string) => s.toLowerCase().replace(HONORIFIC, '').split(/[^a-z]+/).filter((w) => w.length > 1);
  const [wa, wb] = [words(a), words(b)];
  return wa.length > 1 && wb.length > 1 && wa[0] === wb[0] && wa[wa.length - 1] === wb[wb.length - 1];
}

/**
 * The chosen person's own LinkedIn profile, by name and company, for when they were found
 * somewhere else (email records, the company website) and the role search didn't list them.
 * Only a profile whose name matches is kept.
 */
export async function findLinkedinProfile(svc: Services, person: string, company: string): Promise<string> {
  if (!person.trim()) return '';
  const firm = searchName(company) || company;
  const queries = [`site:linkedin.com/in "${person}" "${firm}"`, `site:linkedin.com/in "${person}" ${firm}`];
  for (const q of queries) {
    try {
      const found = toLinkedInPeople(await googleSearch(svc, q)).filter((p) => sameName(p.name, person));
      // Prefer the profile that mentions the company; on the exact-company query any match will do.
      const atFirm = found.find((p) => `${p.title} ${p.snippet}`.toLowerCase().includes(firm.toLowerCase().split(' ')[0]));
      const pick = atFirm ?? (q === queries[0] ? found[0] : undefined);
      if (pick) return pick.linkedin;
    } catch {
      return '';
    }
  }
  return '';
}

/** One candidate list from the sales team's contact, LinkedIn and Hunter; the same person on two lists is merged. */
export function buildCandidates(
  manual: ManualContact,
  linkedin: Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>[],
  hunterEmails: HunterEmail[],
  leaders: Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>[] = [],
): Candidate[] {
  const candidates: Candidate[] = linkedin.map((p, i) => ({ id: `L${i + 1}`, source: 'LinkedIn', email: '', phone: '', ...p }));
  // Leaders from the website and company records; someone also found on LinkedIn keeps their profile.
  leaders.forEach((p, i) => {
    const twin = candidates.find((c) => sameName(c.name, p.name));
    if (twin) {
      if (!twin.title || twin.title.length < 4) twin.title = p.title;
    } else {
      candidates.push({ id: `W${i + 1}`, source: 'Web', email: '', phone: '', ...p });
    }
  });
  hunterEmails.forEach((e, i) => {
    const person = {
      name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      title: e.position || '',
      email: e.value || '',
      phone: e.phone_number || '',
      linkedin: e.linkedin || '',
    };
    const twin = candidates.find((c) => (c.source === 'LinkedIn' || c.source === 'Web') && person.name && sameName(c.name, person.name));
    if (twin) {
      twin.email = person.email;
      twin.phone = person.phone;
      if (!twin.title) twin.title = person.title;
    } else {
      candidates.push({ id: `H${i + 1}`, source: 'Email database', snippet: '', ...person });
    }
  });
  if (manual.name || manual.email) candidates.unshift({ id: 'M', source: 'Sales team', snippet: '', ...manual });
  return candidates;
}

const schema = {
  type: 'object',
  properties: {
    chosen_id: { type: 'string' },
    role_match: { type: 'boolean' },
    reason: { type: 'string' },
    other_ids: { type: 'array', items: { type: 'string' } },
    roles_to_find_on_linkedin: { type: 'array', items: { type: 'string' } },
  },
  required: ['chosen_id', 'role_match', 'reason', 'other_ids', 'roles_to_find_on_linkedin'],
  additionalProperties: false,
};

/**
 * The AI picks the best person by candidate id only, so every name, title, email and
 * profile URL comes from a real search result.
 */
export async function pickContact(
  svc: Services,
  lead: { company: string; domain: string; city: string; segment: string },
  research: Research,
  icp: Icp,
  candidates: Candidate[],
): Promise<{ contact: Contact; notes: string[]; error: string; ranked: Candidate[] }> {
  const userText = [
    `Company: ${lead.company} (${lead.domain || 'no domain'})${lead.city ? `, focus location: ${lead.city}` : ''}`,
    `Segment: ${lead.segment}`,
    `Roles to approach, best first: ${research.targetRoles.join(', ')}`,
    `P1, primary decision-makers (approach first): ${icp.targetTitles}`,
    `P2, process owners (only when no P1 fits): ${icp.p2Titles || 'none listed'}`,
    `P3, process-level contacts (last resort): ${icp.p3Titles || 'none listed'}`,
    `Never pick as the main contact: ${icp.avoidTitles || 'none listed'}`,
    '',
    '## Candidates',
    candidates.length ? JSON.stringify(candidates.map((c) => ({ ...c, tier: tierOf(c.title, icp) || 'unlisted' })), null, 2) : '(none found)',
  ].join('\n');

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const toContact = (c: Candidate, roleMatch: boolean, reason: string): Contact => ({
    name: c.name,
    title: c.title,
    email: c.email,
    phone: c.phone,
    linkedin: c.linkedin,
    emailSource: c.email ? (c.source === 'Sales team' ? 'manual' : 'hunter') : '',
    roleMatch,
    reason,
  });

  if (!candidates.length) return { contact: { ...EMPTY_CONTACT }, notes: [], error: '', ranked: [] };

  const result = await askJson(svc, CONTACT_PROMPT, userText, schema);
  if (result.error !== undefined) {
    const manual = byId.get('M');
    return { contact: manual ? toContact(manual, false, 'Supplied by the sales team') : { ...EMPTY_CONTACT }, notes: [], error: result.error, ranked: candidates };
  }
  const d = result.data;
  let chosen = byId.get(asText(d.chosen_id));
  // HR, admin and quality are never the main contact: fall back to the best-ranked P1, P2 or P3 candidate.
  if (chosen && tierOf(chosen.title, icp) === 'Avoid') {
    const rank = { P1: 0, P2: 1, P3: 2 } as Record<string, number>;
    chosen = candidates
      .filter((c) => tierOf(c.title, icp) in rank)
      .sort((a, b) => rank[tierOf(a.title, icp)] - rank[tierOf(b.title, icp)])[0];
  }
  const contact = chosen ? toContact(chosen, asBool(d.role_match), asText(d.reason)) : { ...EMPTY_CONTACT };

  const otherCandidates = asTextList(d.other_ids)
    .map((id) => byId.get(id.trim()))
    .filter((c): c is Candidate => !!c && c !== chosen);
  const others = otherCandidates.slice(0, 4).map((c) => [c.name, c.title, c.email || c.linkedin].filter(Boolean).join(' | '));
  // Everyone found, best first: the chosen contact, the AI's other picks, then the rest.
  const ranked = [...(chosen ? [chosen] : []), ...otherCandidates, ...candidates.filter((c) => c !== chosen && !otherCandidates.includes(c))];
  const rolesToFind = asTextList(d.roles_to_find_on_linkedin);

  const notes: string[] = [];
  if (others.length) notes.push('Other decision-makers:\n' + others.join('\n'));
  if (rolesToFind.length) notes.push('Still to find on LinkedIn: ' + rolesToFind.join(', '));
  return { contact, notes, error: '', ranked };
}
