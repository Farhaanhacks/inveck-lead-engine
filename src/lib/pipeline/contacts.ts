import type { Icp } from '../db/schema';
import { contactPriority, tierOf } from '../tiers';
import { askJson } from './ai';
import { CONTACT_PROMPT, LEADERS_PROMPT } from './prompts';
import type { Research } from './research';
import type { Services } from './services';
import { googleSearch, hunter } from './services';
import { brandOf, currentEmployer, nameIsTheCompany, type Employer } from './employer';
import { fetchWebsiteText } from './site-reader';
import { asList, asText, asTextList, errorMessage, searchName } from './text';
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

/**
 * Google query for public LinkedIn profiles at this company, for the roles INVECK approaches first:
 * the plant head / plant manager and the other hands-on heads from the ICP's lists, never the MD.
 */
export function linkedinQuery(company: string, city: string, icp: Icp): string {
  const listed = [...icp.targetTitles.split(','), ...icp.p2Titles.split(',')].map((r) => r.trim()).filter(Boolean);
  const floor = /manufactur|plant|factory|production|works/i.test(`${icp.segment} ${icp.industries}`) ? ['Plant Head', 'Plant Manager'] : [];
  const roles = [...new Set([...floor, ...listed])]
    .filter((r) => contactPriority(r, icp) < 25)
    .sort((a, b) => contactPriority(a, icp) - contactPriority(b, icp))
    .slice(0, 6);
  return [
    'site:linkedin.com/in',
    firmQuery(company),
    roles.length ? '(' + roles.map((r) => `"${r}"`).join(' OR ') + ')' : '',
    city,
  ]
    .filter(Boolean)
    .join(' ');
}

type LinkedInPerson = Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>;

const firmWords = (s: string) =>
  s.toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|india|the|co|company|group)\b/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/**
 * The role from a Google result title like "Amit Chhari - Chief of Operations - Allcargo Logistics | LinkedIn":
 * the parts after the name, without the part that is just the company's name.
 */
export function roleFromLinkedinTitle(parts: string[], company = ''): string {
  const firm = new Set(firmWords(company));
  const isFirm = (p: string) => {
    const w = firmWords(p);
    return w.length > 0 && w.every((x) => firm.has(x));
  };
  return parts.map((p) => p.trim()).filter((p) => p && !(firm.size && isFirm(p))).join(' - ');
}

function toLinkedInPeople(results: { title?: string; link?: string; snippet?: string }[], company = ''): (LinkedInPerson & { employer: Employer })[] {
  return results
    .filter((r) => /linkedin\.com\/in\//i.test(r.link || ''))
    .map((r) => {
      // Google shows "Name - Role - Company | LinkedIn". The role part may be a whole headline
      // ("Chief of Operations | Logistics & Supply Chain Leader | ..."): its first piece is the job.
      const title = String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
      const [name, ...rest] = title.split(/\s+[-–—]\s+/);
      const parts = rest.map((p) => p.split(/\s*\|\s*/)[0].trim()).filter(Boolean);
      const person = { name: (name || '').trim(), title: roleFromLinkedinTitle(parts, company), linkedin: (r.link || '').split('?')[0], snippet: r.snippet || '' };
      const employer = nameIsTheCompany(person.name, company) ? 'elsewhere' : currentEmployer({ ...person, titleParts: parts }, company);
      return { ...person, employer };
    })
    .filter((p) => p.name);
}

/**
 * The company as people write it on LinkedIn: the full name or its brand ("Lumax Auto Technologies"
 * OR "Lumax"), since staff often list "Lumax World" or "Lumax Industries".
 */
function firmQuery(company: string): string {
  const full = searchName(company) || company;
  const brand = brandOf(company);
  return brand && brand !== full.toLowerCase() ? `("${full}" OR "${brand}")` : `"${full}"`;
}

/**
 * Public LinkedIn profiles via Google. Runs the targeted query (company + roles + city) and a
 * broad one (company + any senior role), since small companies rarely match the targeted one.
 */
export async function searchLinkedIn(svc: Services, query: string, company = ''): Promise<{ people: LinkedInPerson[]; error: string }> {
  const name = searchName(company);
  const queries = [query];
  // The broad search looks for the people who run operations, not the top of the company.
  if (name) queries.push(`site:linkedin.com/in ${firmQuery(company)} ("plant head" OR "plant manager" OR operations OR "supply chain" OR warehouse OR logistics OR inventory OR head OR manager)`);
  const settled = await Promise.allSettled(queries.map((q) => googleSearch(svc, q)));
  const people: LinkedInPerson[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const p of toLinkedInPeople(s.value, company)) {
      // Found by searching the company's name, so former employees turn up too: keep only people
      // whose profile shows they work there now.
      if (company && p.employer !== 'here') continue;
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
export function sameName(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const words = (s: string) => s.toLowerCase().replace(HONORIFIC, '').split(/[^a-z]+/).filter((w) => w.length > 1);
  const [wa, wb] = [words(a), words(b)];
  return wa.length > 1 && wb.length > 1 && wa[0] === wb[0] && wa[wa.length - 1] === wb[wb.length - 1];
}

/** Name words without honorifics or punctuation: "Dr. S. K. Saha" gives s, k, saha. */
const nameWords = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(HONORIFIC, '')
    .split(/[^a-z]+/)
    .filter(Boolean);

/**
 * The same person written another way: same surname, and a first name that matches, starts the
 * other ("Siddharth" / "Siddhartha") or is its initial ("S. Saha"). Only trusted together with the
 * company showing on the profile.
 */
export function looseName(a: string, b: string): boolean {
  const [wa, wb] = [nameWords(a), nameWords(b)];
  if (wa.length < 2 || wb.length < 2 || wa[wa.length - 1] !== wb[wb.length - 1]) return false;
  const [fa, fb] = [wa[0], wb[0]];
  if (fa === fb) return true;
  if (fa.length === 1 || fb.length === 1) return fa[0] === fb[0];
  return fa.length >= 4 && fb.length >= 4 && (fa.startsWith(fb) || fb.startsWith(fa));
}

/** Two or three words from a designation that say what the job is: "Regional Logistics Manager" gives "logistics manager". */
function roleWords(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bat\b.*$/, '')
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !['senior', 'regional', 'assistant', 'deputy', 'and', 'the'].includes(w))
    .slice(0, 2)
    .join(' ');
}

/**
 * The person's own LinkedIn profile, found through Google (LinkedIn itself can't be searched by
 * outside software). Tries the exact name and company first, then a shorter name, the company's
 * short name, the surname with their role, and their city, stopping at the first match. An exact
 * name match is taken as before; a looser one ("Siddharth" for "Siddhartha", "S. Saha") only when
 * the result also shows them working at this company. A match showing another employer means they left.
 */
export async function findLinkedinProfile(
  svc: Services,
  person: string,
  company: string,
  hint: { title?: string; city?: string } = {},
): Promise<{ url: string; title: string; employer: Employer } | null> {
  // As written (Google ignores case), without honorifics or initials' dots.
  const words = person.replace(HONORIFIC, '').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const full = words.join(' ');
  const firstLast = words.length > 2 ? `${words[0]} ${words[words.length - 1]}` : '';
  const firm = searchName(company) || company;
  const firmWordsList = firm.split(/\s+/).filter(Boolean);
  const short = firmWordsList.length > 1 && firmWordsList[0].length >= 4 ? firmWordsList[0] : '';
  const role = roleWords(hint.title ?? '');
  const city = (hint.city ?? '').split(',')[0].trim();
  const queries = [
    `site:linkedin.com/in "${full}" ${firmQuery(company)}`,
    `site:linkedin.com/in "${full}" ${firm}`,
    firstLast && `site:linkedin.com/in "${firstLast}" ${firm}`,
    short && `site:linkedin.com/in "${firstLast || full}" "${short}"`,
    role && words.length > 1 && `site:linkedin.com/in "${words[words.length - 1]}" ${short || firm} ${role}`,
    city && `site:linkedin.com/in "${firstLast || full}" ${short || firm} ${city}`,
  ].filter((q, i, all): q is string => !!q && all.indexOf(q) === i);

  for (const [i, q] of queries.entries()) {
    let results;
    try {
      results = toLinkedInPeople(await googleSearch(svc, q), company);
    } catch {
      continue;
    }
    const exact = results.filter((p) => sameName(p.name, person));
    const pick =
      exact.find((p) => p.employer === 'here') ??
      results.find((p) => p.employer === 'here' && looseName(p.name, person)) ??
      exact.find((p) => p.employer === 'elsewhere') ??
      (i === 0 ? exact[0] : undefined);
    if (pick) return { url: pick.linkedin, title: pick.title, employer: pick.employer };
  }
  return null;
}

/** True when the person's title or profile names the lead's city: they work at this branch. */
export function atBranch(c: { title: string; snippet?: string }, city: string): boolean {
  const place = city.trim().toLowerCase();
  return place.length > 2 && `${c.title} ${c.snippet ?? ''}`.toLowerCase().includes(place);
}

/** Sort key: INVECK's contact priority, a head start for someone at this branch, then a number, then an email. */
type RankIcp = Parameters<typeof contactPriority>[1];

export function candidateRank(c: { title: string; snippet?: string; phone?: string; email?: string }, icp: RankIcp, city = ''): number {
  return contactPriority(c.title, icp) - (atBranch(c, city) ? 6 : 0) - (c.phone ? 0.2 : 0) - (c.email ? 0.1 : 0);
}

export function rankCandidates<T extends { title: string; snippet?: string; phone?: string; email?: string }>(list: T[], icp: RankIcp, city = ''): T[] {
  return [...list].sort((a, b) => candidateRank(a, icp, city) - candidateRank(b, icp, city));
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
  // INVECK's order decides who comes first, not the AI: plant heads, then hands-on heads, then process
  // owners, with the MD last (see contactPriority), and someone at this branch before someone at another.
  // The AI's job is to vet: pick among the people it chose or listed as relevant, and only fall back to
  // the rest when it vetted nobody on the lists. The sales team's own contact always stays.
  const vetted = [chosen, ...asTextList(d.other_ids).map((id) => byId.get(id.trim()))].filter((c): c is Candidate => !!c);
  const pool = vetted.some((c) => contactPriority(c.title, icp) < 99) ? vetted : candidates;
  const best = rankCandidates(pool, icp, lead.city)[0];
  if (chosen?.source !== 'Sales team' && best && contactPriority(best.title, icp) < 99 && (!chosen || candidateRank(best, icp, lead.city) < candidateRank(chosen, icp, lead.city))) {
    chosen = best;
  }
  if (chosen && tierOf(chosen.title, icp) === 'Avoid') chosen = undefined;
  const contact = chosen
    ? toContact(chosen, tierOf(chosen.title, icp) === 'P1', chosen.id === asText(d.chosen_id) ? asText(d.reason) : `Ranked first by INVECK's contact priority: ${chosen.title}`)
    : { ...EMPTY_CONTACT };

  const otherCandidates = asTextList(d.other_ids)
    .map((id) => byId.get(id.trim()))
    // Only people the ICP wants: designations on its P1/P2/P3 lists.
    .filter((c): c is Candidate => !!c && c !== chosen && ['P1', 'P2', 'P3'].includes(tierOf(c.title, icp)));
  const others = otherCandidates.slice(0, 4).map((c) => [c.name, c.title, c.email || c.linkedin].filter(Boolean).join(' | '));
  // Everyone found, best first by INVECK's contact priority, the chosen contact on top.
  const ranked = [...(chosen ? [chosen] : []), ...rankCandidates(candidates.filter((c) => c !== chosen), icp, lead.city)];
  const rolesToFind = asTextList(d.roles_to_find_on_linkedin);

  const notes: string[] = [];
  if (others.length) notes.push('Other decision-makers:\n' + others.join('\n'));
  if (rolesToFind.length) notes.push('Still to find on LinkedIn: ' + rolesToFind.join(', '));
  return { contact, notes, error: '', ranked };
}
