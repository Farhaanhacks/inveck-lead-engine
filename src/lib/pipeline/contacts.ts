import type { Icp } from '../db/schema';
import { cleanTitle, companyWide, contactPriority, noDepartment, roleOnly, tierOf } from '../tiers';
import { askJson } from './ai';
import { CONTACT_PROMPT, LEADERS_PROMPT } from './prompts';
import type { Research } from './research';
import type { Services } from './services';
import { googleSearch } from './services';
import { brandOf, firmAliasesOf, firmSiteName, currentEmployer, isPlace, nameIsTheCompany, placeNamedIn, vagueLocation, sameFirm, snippetRoles, subtitleJob, basedAbroad, inCity, profileLocation, siteOf, type Employer } from './employer';
import { fetchWebsiteText } from './site-reader';
import { knowPlaces } from './places';
import { asList, asText, asTextList, errorMessage, searchName } from './text';
import { isBlockedDomain } from './website';

export type Candidate = {
  id: string;
  /** 'Email database' (Hunter) is no longer produced; kept so older data still reads. */
  source: 'Sales team' | 'LinkedIn' | 'Email database' | 'Web';
  name: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  snippet: string;
  /** Where they are based, from their LinkedIn profile ("Pimpri Chinchwad, Maharashtra, India"). */
  location?: string;
  /** Where their current job here is, from that job's own entry on the profile. */
  jobLocation?: string;
  /** The site their title says they are responsible for ("Plant Head - Coimbatore"). */
  responsibility?: string;
  /** What showed they work here, and whether it was dated ("LinkedIn (via Google, undated): …"). */
  evidence?: string;
  /**
   * Contradictory current jobs (a "Present" job here, and another current job elsewhere): kept, but
   * never made the main contact until verified; what the contradiction is.
   */
  conflict?: string;
};

export type ManualContact = { name: string; title: string; email: string; phone: string; linkedin: string };

export type Contact = {
  name: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  /** Where the email came from, when it came with the contact: only the sales team's own. */
  emailSource: '' | 'manual';
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
  (s.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim() || s).toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|india|the|co|company|group)\b/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2);

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

const JOB_WORD = /\b(head|manager|director|officer|vp|president|chief|gm|dgm|agm|lead|controller|incharge|in-charge|engineer|executive|supervisor|coordinator|planner|analyst|partner|founder|ceo|cfo|coo|md)\b/i;

/** "CEO, Auto Diecasting Company": the role, then the employer; anything else is left as it is. */
function splitRoleAndFirm(part: string, company: string): string[] {
  const m = /^([^,]{2,40}),\s+([^,]{3,80})$/.exec(part);
  if (!m || !JOB_WORD.test(m[1]) || JOB_WORD.test(m[2]) || isPlace(m[2])) return [part];
  // Only when the second piece is a company ("Head, Operations" is one role).
  const firm = (company && sameFirm(m[2], company)) || /\b(company|ltd|limited|pvt|llp|inc|industries|enterprises|corporation|group)\b/i.test(m[2]);
  if (!firm) return [part];
  return [m[1].trim(), m[2].trim()];
}

type FoundPerson = LinkedInPerson & { employer: Employer; abroad: boolean };

/** How strong the employment evidence in a result is: a dated job beats an undated line, which beats nothing. */
function evidenceStrength(p: FoundPerson): number {
  if (!p.evidence) return 0;
  if (/undated/.test(p.evidence)) return 1;
  return 2;
}

/**
 * The same profile often comes back from several searches, each result showing a different part of it
 * (one the city, another the dated job). They are merged: the employer from the strongest evidence,
 * and every place any of them shows (a specific city over "India").
 */
export function mergeSameProfile<T extends FoundPerson>(list: T[]): T[] {
  const byKey = new Map<string, T>();
  const keyOf = (p: T) => p.linkedin.toLowerCase().replace(/^https?:\/\/[a-z]+\./, '').replace(/\/+$/, '');
  for (const p of list) {
    const key = keyOf(p);
    const had = byKey.get(key);
    if (!had) {
      byKey.set(key, { ...p });
      continue;
    }
    const [best, other] = evidenceStrength(p) > evidenceStrength(had) ? [{ ...p }, had] : [had, p];
    if (vagueLocation(best.location) && !vagueLocation(other.location)) best.location = other.location;
    if (!best.jobLocation && other.jobLocation) best.jobLocation = other.jobLocation;
    if (!best.responsibility && other.responsibility) best.responsibility = other.responsibility;
    if (!best.title && other.title) best.title = other.title;
    best.abroad = best.abroad && other.abroad;
    if (!best.conflict && other.conflict) best.conflict = other.conflict;
    byKey.set(key, best);
  }
  return [...byKey.values()];
}

function toLinkedInPeople(results: { title?: string; link?: string; snippet?: string; subtitle?: string }[], company = ''): FoundPerson[] {
  return results
    .filter((r) => /linkedin\.com\/in\//i.test(r.link || ''))
    .map((r) => {
      // Google shows "Name - Role - Company | LinkedIn". The role part may be a whole headline
      // ("Chief of Operations | Logistics & Supply Chain Leader | ..."): its first piece is the job.
      const title = String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
      const [name, ...rest] = title.split(/\s+[-–—]\s+/);
      // "CEO, Auto Diecasting Company" is a role and an employer, as "CEO - Auto Diecasting Company" would be.
      const parts = rest.map((p) => p.split(/\s*\|\s*/)[0].trim()).filter(Boolean).flatMap((p) => splitRoleAndFirm(p, company));
      const location = profileLocation(r.subtitle, r.snippet);
      const abroad = basedAbroad(location, r.snippet, r.link || '');
      const person = { name: (name || '').trim(), title: roleFromLinkedinTitle(parts, company), linkedin: (r.link || '').split('?')[0], snippet: r.snippet || '', location, abroad };
      // A title that is the company's name or a slogan ("Cold Chain .Warehousing .Fulfilment") isn't a job.
      if (person.title && (!JOB_WORD.test(person.title) || (company && sameFirm(person.title, company) && !JOB_WORD.test(roleOnly(person.title))))) person.title = '';
      // Google's line under the result ("Mumbai · Head of Unit · Balmer Lawrie & Co. Ltd.") is the
      // profile's current job: it decides where they work now, whatever the About text says.
      const subtitleJobAny = company ? subtitleJob(r.subtitle) : null;
      // The snippet often holds the job and its dates ("Group Plant Head. CIE Automotive India Ltd. Mar
      // 2025 - Present"): a current job here gives the role; jobs here that have all ended mean they left.
      // All of it is read before deciding: a dated current job here outranks an undated line naming
      // another company (people hold two roles, and Google's line can be an old copy).
      const here = company ? snippetRoles(person.snippet).filter((j) => sameFirm(j.company, company)) : [];
      const now = here.find((j) => j.current);
      const elsewhereLine = !!subtitleJobAny && !sameFirm(subtitleJobAny.company, company);
      if (elsewhereLine && !now) {
        return { ...person, title: cleanTitle(roleOnly(subtitleJobAny!.role)), employer: 'elsewhere' as const, evidence: `LinkedIn (via Google, undated): ${cleanTitle(subtitleJobAny!.role)} at ${subtitleJobAny!.company}` };
      }
      const job = elsewhereLine ? null : subtitleJobAny;
      if (job) {
        // The profile's position here is the job itself; the headline may be a phrase around it
        // ("Working as Director Operation ...").
        if (!person.title || JOB_WORD.test(job.role)) person.title = job.role;
      }
      if (now && !isPlace(now.role) && (elsewhereLine || !person.title || !JOB_WORD.test(person.title) || sameFirm(person.title, company))) person.title = now.role;
      // Keep just the role: "Plant Head at TRACK COMPONENTS ..." is saved as "Plant Head".
      person.title = cleanTitle(roleOnly(person.title).replace(/\s*(\.\.\.|…)\s*$/, '').replace(/[\s,|-]+$/, ''));
      let employer: Employer = nameIsTheCompany(person.name, company) ? 'elsewhere' : currentEmployer({ ...person, titleParts: parts }, company);
      // A headline "Head of Supply Chain | NBC Bearings | CKA Birla Group": a piece naming the company
      // (and none naming another as current) means they work there.
      if (employer === 'unknown' && company) {
        const pieces = rest.flatMap((p) => p.split(/\s*\|\s*/)).map((p) => p.trim()).filter(Boolean);
        if (pieces.slice(1).some((p) => sameFirm(p, company))) employer = 'here';
      }
      // Dated jobs in the snippet outrank the undated line under the result: a job here that has ended,
      // or a current job at another company, means the line is an old copy of the profile.
      const dated = company ? snippetRoles(person.snippet) : [];
      const currentElsewhere = dated.find((j) => j.current && !sameFirm(j.company, company));
      const endedHere = here.length > 0 && !now;
      let evidence = '';
      let conflict = '';
      if (now) {
        employer = 'here';
        evidence = `LinkedIn (via Google): ${cleanTitle(now.role)} at ${now.company}, current`;
        // A "Present" entry in a search snippet may be an old copy: when the same profile also shows a
        // current job somewhere else, neither is taken as fact. Kept for verification, never confirmed.
        const otherNow = currentElsewhere ? `${currentElsewhere.role} at ${currentElsewhere.company}` : elsewhereLine ? `${cleanTitle(subtitleJobAny!.role)} at ${subtitleJobAny!.company}` : '';
        if (otherNow) conflict = `LinkedIn shows two current jobs: ${cleanTitle(now.role)} at ${now.company}, and ${otherNow}; needs verification`;
      } else if (currentElsewhere) {
        employer = 'elsewhere';
        evidence = `LinkedIn (via Google): now ${currentElsewhere.role} at ${currentElsewhere.company}`;
      } else if (endedHere) {
        // Conflicting (an undated line may still say here): never confirmed from it.
        employer = job ? 'unknown' : 'elsewhere';
        evidence = `LinkedIn (via Google): the job at ${here[0].company} has ended${job ? '; the undated line still shows it, so not confirmed' : ''}`;
      } else if (job) {
        employer = 'here';
        evidence = `LinkedIn (via Google, undated): ${[location, cleanTitle(job.role), job.company].filter(Boolean).join(' · ')}`;
      } else if (employer === 'here') {
        evidence = `LinkedIn (via Google, undated): ${[person.title, location].filter(Boolean).join(' · ')}`;
      }
      // Where the job is, kept apart from where the profile says they live: the current job's own
      // entry, and the site their title names.
      const jobLocation = now?.location ?? '';
      const responsibility = placeNamedIn(`${person.title} ${job?.role ?? ''}`);
      return { ...person, employer, evidence, jobLocation, responsibility, ...(conflict ? { conflict } : {}) };
    })
    // INVECK sells in India: profiles on another country's LinkedIn (pk., ae., uk.) aren't wanted;
    // people based abroad on www. profiles are flagged `abroad`.
    .filter((p) => p.name && /^https?:\/\/(www\.|in\.)?linkedin\.com\//i.test(p.linkedin));
}

/** The company as people write it on LinkedIn: its full name, and its short name only where its own website uses it. */
function firmQuery(company: string): string {
  // "India" at the end of a subsidiary's name is rarely written by its staff ("Micron Semiconductor
  // Technology India" people write "Micron Semiconductor Technology" or "Micron Technology").
  const legal = searchName(company) || company;
  const full = brandOf(company) && /\s+india$/i.test(legal) ? legal.replace(/\s+india$/i, '') : legal;
  // The first word alone only when the company's own website shows its staff use a shorter name
  // ("Lumax" for Lumax Auto Technologies at lumaxworld.in); never otherwise ("Ultra" finds every Ultra).
  const brand = brandOf(company);
  const site = firmSiteName(company);
  const fullSquashed = full.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = [full, ...(brand && site && site.startsWith(brand) && !fullSquashed.startsWith(site) ? [brand] : [])];
  // And the name on the company's own LinkedIn page, which is what its staff's profiles show.
  for (const alias of firmAliasesOf(company)) {
    const n = searchName(alias.replace(/\(.*?\)/g, ' ')) || alias;
    if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  return names.length > 1 ? `(${names.map((n) => `"${n}"`).join(' OR ')})` : `"${names[0]}"`;
}

/**
 * Public LinkedIn profiles via Google. Runs the targeted query (company + roles + city) and a
 * broad one (company + any senior role), since small companies rarely match the targeted one.
 */
export async function searchLinkedIn(svc: Services, query: string, company = '', city = '', icp?: RankIcp): Promise<{ people: LinkedInPerson[]; error: string }> {
  const name = searchName(company);
  const queries = [query];
  // The broad search looks for the people who run operations, not the top of the company.
  if (name) queries.push(`site:linkedin.com/in ${firmQuery(company)} ("plant head" OR "plant manager" OR operations OR "supply chain" OR warehouse OR logistics OR inventory OR head OR manager)`);
  const settled = await Promise.allSettled(queries.map((q) => googleSearch(svc, q)));
  // The broad search's first page was full: the next ten often hold the people at the site we want.
  const broad = settled[1];
  if (queries[1] && broad?.status === 'fulfilled' && broad.value.length >= 10) settled.push(...(await Promise.allSettled([googleSearch(svc, queries[1], 2)])));
  // Every result for a profile is read together before deciding (see mergeSameProfile).
  const found = mergeSameProfile(settled.flatMap((s) => (s.status === 'fulfilled' ? toLinkedInPeople(s.value, company) : [])));
  // Found by searching the company's name, so former employees turn up too: keep only people whose
  // profile shows they work there now; and nobody based outside India ("Detroit Metropolitan Area").
  const people: LinkedInPerson[] = found.filter((p) => (!company || p.employer === 'here') && !p.abroad);
  // The searches look for the people who run the site. Until someone eligible at this site is found
  // (on the ICP's lists, not just anyone who works there), more is searched, within a small budget:
  // the company's leadership (owners, partners, the CEO, directors, the president), kept as corporate
  // contacts for review; then everyone at the company in the site's city.
  const eligibleAtSite = () =>
    people.some((p) => (!city.trim() || personSite(p, city) === 'here') && (!icp || contactPriority(p.title, icp) < 99));
  const firm = firmQuery(company);
  const town = city.split(',')[0].trim();
  const more = [
    `site:linkedin.com/in ${firm} (owner OR founder OR "managing partner" OR partner OR "managing director" OR proprietor OR CEO OR "chief executive" OR president)`,
    town ? `site:linkedin.com/in ${firm} "${town}"` : '',
  ].filter(Boolean);
  await knowPlaces(svc, [city, ...people.flatMap((p) => [p.location, p.jobLocation, p.responsibility])]);
  for (const q of more) {
    if (!name || eligibleAtSite() || settled.some((s) => s.status === 'rejected')) break;
    try {
      const extra = toLinkedInPeople(await googleSearch(svc, q), company);
      const merged = mergeSameProfile([...(people as FoundPerson[]), ...extra]).filter((p) => (!company || p.employer === 'here') && !p.abroad);
      people.splice(0, people.length, ...merged);
      await knowPlaces(svc, people.flatMap((p) => [p.location, p.jobLocation, p.responsibility]));
    } catch {
      // Nothing more found this time.
      break;
    }
  }
  await knowPlaces(svc, people.flatMap((p) => [p.location, p.jobLocation, p.responsibility]));
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
    // A name is kept only where it really belongs to this company: on its own pages, or in a search
    // result that also names the company. A name found in a result about another firm is dropped.
    const own = [page.text, home].join(' ');
    const lines = results.map((r) => `${r.title || ''} ${r.snippet || ''}`);
    const people = asList(result.data.people)
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
      .map((p) => ({ name: asText(p.name).replace(HONORIFIC, '').trim(), title: asText(p.title) }))
      .filter((p) => nameIn(p.name, own) || lines.some((l) => nameIn(p.name, l) && mentionsFirm(l, company, domain)))
      .slice(0, 12)
      .map((p) => ({ ...p, linkedin: '', snippet: 'Named on the company website or in public company records' }));
    return { people, emails, error: '' };
  } catch (e) {
    return { people: [], emails: [], error: errorMessage(e) };
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
): Promise<{ url: string; title: string; employer: Employer; abroad: boolean; location: string; jobLocation: string; responsibility: string; evidence: string } | null> {
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

  const profileOf = async (pick: FoundPerson) => {
    await knowPlaces(svc, [pick.location, pick.jobLocation, pick.responsibility, hint.city]);
    return {
      url: pick.linkedin,
      title: pick.title,
      // Contradictory current jobs: found, but not confirmed here (the reason is shown).
      employer: pick.conflict ? ('unknown' as const) : pick.employer,
      abroad: pick.abroad,
      location: pick.location ?? '',
      jobLocation: pick.jobLocation ?? '',
      responsibility: pick.responsibility ?? '',
      evidence: pick.conflict || (pick.evidence ?? ''),
    };
  };
  let failure: unknown = null;
  // Every result so far, merged per profile: one result may show the city, another the dated job.
  const seenSoFar: FoundPerson[] = [];
  // A same-name profile at another company may be someone else with that name: the remaining searches
  // still run (two more at most) looking for one at this company before concluding they work elsewhere.
  let other: FoundPerson | undefined;
  let afterOther = 0;
  for (const q of queries) {
    if (other && afterOther >= 2) break;
    if (other) afterOther++;
    let results: FoundPerson[];
    try {
      results = mergeSameProfile([...seenSoFar, ...toLinkedInPeople(await googleSearch(svc, q), company)]);
    } catch (e) {
      failure = e;
      continue;
    }
    seenSoFar.splice(0, seenSoFar.length, ...results);
    const exact = results.filter((p) => sameName(p.name, person));
    const here = exact.find((p) => p.employer === 'here') ?? results.find((p) => p.employer === 'here' && looseName(p.name, person));
    // Found, but the evidence conflicts (the job here has ended): kept so the reason is shown.
    other ??= exact.find((p) => p.employer === 'elsewhere') ?? exact.find((p) => p.employer === 'unknown' && !!p.evidence);
    if (here) return await profileOf(here);
  }
  if (other) return await profileOf(other);
  // A search that failed (quota, network) isn't "no profile": the caller checks again later.
  if (failure) throw new Error('LinkedIn search failed: ' + errorMessage(failure));
  return null;
}

type Placed = { title?: string; snippet?: string; location?: string | null; jobLocation?: string | null; responsibility?: string | null };

/**
 * Where someone works, relative to the lead's site, from the most specific evidence first: the site
 * their title says they run ("Plant Head - Coimbatore"), then the location of their current job here,
 * then the location on their profile (where they live, which can be another city).
 */
export function personSite(c: Placed, city: string): 'here' | 'elsewhere' | 'unknown' {
  if (!city.trim()) return 'unknown';
  const named = siteOf(c.responsibility ?? '', city);
  if (named !== 'unknown') return named;
  if (inCity(c.title ?? '', city)) return 'here';
  const job = siteOf(c.jobLocation ?? '', city);
  if (job !== 'unknown') return job;
  return siteOf(c.location ?? '', city);
}

/** How personSite decided, for the evidence shown to the team. */
export function siteEvidence(c: Placed, city: string): string {
  if (!city.trim()) return '';
  if (c.responsibility && siteOf(c.responsibility, city) !== 'unknown') return `title names ${c.responsibility}`;
  if (inCity(c.title ?? '', city)) return `title names ${city}`;
  if (c.jobLocation && siteOf(c.jobLocation, city) !== 'unknown') return `current job's location: ${c.jobLocation}${c.location && c.location !== c.jobLocation ? ` (profile location: ${c.location})` : ''}`;
  return c.location ? `profile location: ${c.location}` : 'no location shown';
}

/** True when the person's title or profile names the lead's city: they work at this branch. */
export function atBranch(c: Placed & { title: string }, city: string): boolean {
  return personSite(c, city) === 'here' || inCity(`${c.title} ${c.snippet ?? ''} ${c.location ?? ''}`, city);
}

/** Sort key: INVECK's contact priority, a head start for someone at this branch, then a number, then an email. */
type RankIcp = Parameters<typeof contactPriority>[1];

/** P1 first, then P2, P3, and the head of the company last: the tier decides before the location. */
const TIER_ORDER: Record<string, number> = { P1: 0, P2: 1, P3: 2, Top: 3 };

export function candidateRank(c: Placed & { title: string; phone?: string; email?: string }, icp: RankIcp, city = ''): number {
  // The tier first (a P1 at another site comes before a P2 at this one); within a tier, someone at this
  // site before someone elsewhere in India.
  const tier = TIER_ORDER[tierOf(c.title, icp)] ?? 4;
  const elsewhere = personSite(c, city) === 'elsewhere';
  return tier * 100 + contactPriority(c.title, icp) - (atBranch(c, city) ? 6 : 0) + (elsewhere ? 4 : 0) - (c.email ? 0.1 : 0);
}

/**
 * The lead is one site (NBC Bearings, Jaipur): someone whose job is at another of the company's
 * locations isn't a contact for it. The top of the company (owner, partner, MD, CEO) covers every
 * site: kept, though only made the main contact once confirmed at this one. Abroad is never kept
 * (see basedAbroad). True when they should be left out.
 */
export function atOtherSite(c: Placed & { title: string }, city: string, icp?: RankIcp): boolean {
  // A P1 at another site is still a contact (ranked after P1s at this site, before P2s here).
  if (icp && tierOf(c.title, icp) === 'P1') return false;
  return personSite(c, city) === 'elsewhere' && !companyWide(c.title);
}

/**
 * Can be the main contact for this site: at this site, or a P1 at another of the company's Indian
 * sites (a P1 elsewhere comes before a P2 here; P2 and P3 must be at this site).
 */
export function canBeMain(c: Placed & { title?: string }, city: string, icp?: RankIcp): boolean {
  if (confirmedAtSite(c, city)) return true;
  return !!icp && !!c.title && tierOf(c.title, icp) === 'P1' && personSite(c, city) === 'elsewhere';
}

/**
 * Can be the main contact for this site: when the lead has a city, their job must be confirmed
 * there (or its metro area). A location not known yet doesn't count.
 */
export function confirmedAtSite(c: Placed, city: string): boolean {
  return !city.trim() || personSite(c, city) === 'here';
}

/**
 * Where someone found at the company stands for this lead, and why: confirmed at the site; a corporate
 * contact (the top of the company, whose role covers every site) for the team to review; staff at
 * another site; a role not on the ICP's lists; or not placed yet. A corporate contact based in another
 * city is never taken for a contact at this site.
 */
export type Standing = 'site' | 'corporate' | 'other_site' | 'off_list' | 'unplaced';

export function contactStanding(p: Placed & { title: string }, icp: RankIcp, city: string): { standing: Standing; reason: string } {
  const title = p.title.trim();
  const where = siteEvidence(p, city);
  const site = personSite(p, city);
  const corporate = companyWide(title) && contactPriority(title, icp) < 99;
  if (!corporate && contactPriority(title, icp) >= 99) {
    const role = !title
      ? 'no title shown'
      : noDepartment(title)
        ? `${title}: the title doesn't say which department, so it can't be placed on the ICP lists`
        : `${title}: not a role on the ICP lists`;
    return { standing: 'off_list', reason: `${role}${city && site === 'elsewhere' ? `; ${where}, not the ${city} site` : ''}` };
  }
  if (!city.trim() || site === 'here') return { standing: 'site', reason: city ? `At the ${city} site (${where})` : 'At the company' };
  if (corporate) {
    return { standing: 'corporate', reason: `Corporate contact (${title}, a company-wide role), for review; ${where}; not a ${city} site contact unless confirmed there` };
  }
  if (site === 'elsewhere') return { standing: 'other_site', reason: `${where}, not the ${city} site` };
  return { standing: 'unplaced', reason: `${where}; not confirmed at the ${city} site` };
}

export function rankCandidates<T extends { title: string; snippet?: string; location?: string | null; phone?: string; email?: string }>(list: T[], icp: RankIcp, city = ''): T[] {
  return [...list].sort((a, b) => candidateRank(a, icp, city) - candidateRank(b, icp, city));
}

/** The person's name written in the text: first and last name close together ("Divya Somani", "Somani Divya", "Divya K. Somani"). */
export function nameIn(name: string, text: string): boolean {
  const w = name.toLowerCase().replace(HONORIFIC, '').split(/[^a-z]+/).filter((x) => x.length > 1);
  if (w.length < 2) return false;
  const [first, last] = [w[0], w[w.length - 1]];
  const t = text.toLowerCase();
  const near = (a: string, b: string) => new RegExp(`\\b${a}\\b(?:\\W+\\w+){0,2}?\\W+${b}\\b`).test(t);
  return near(first, last) || near(last, first);
}

/**
 * The text is about this company: it names the company (its opening words) or its website. Never just
 * one word: for "B C Shetty & Co" that would be "Shetty", which matches pages about anyone of that name.
 */
function mentionsFirm(text: string, company: string, domain: string): boolean {
  const clean = (x: string) => x.toLowerCase().replace(/[.,&'’-]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = ` ${clean(text)} `;
  // The opening words of the name, at least two and six letters: "ash logistics", "b c shetty", "lumax auto".
  const words = clean(searchName(company) || company).split(' ');
  let head = '';
  for (const [i, w] of words.entries()) {
    head = head ? `${head} ${w}` : w;
    if (i >= 1 && head.replace(/ /g, '').length >= 6) break;
  }
  return (!!domain && text.toLowerCase().includes(domain.toLowerCase())) || (words.length > 0 && t.includes(` ${head} `));
}

/**
 * One candidate list from the sales team's contact, LinkedIn and the company's leaders; the same
 * person on two lists is merged. (Hunter's people search is no longer a source; emails are found
 * for the chosen people afterwards, see findEmail.)
 */
export function buildCandidates(
  manual: ManualContact,
  linkedin: Omit<Candidate, 'id' | 'source' | 'email' | 'phone'>[],
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
    phone: c.phone,
    linkedin: c.linkedin,
    // Only the sales team's own address comes with a candidate; other emails are found afterwards.
    email: c.source === 'Sales team' ? c.email : '',
    emailSource: c.email && c.source === 'Sales team' ? 'manual' : '',
    roleMatch,
    reason,
  });

  if (!candidates.length) return { contact: { ...EMPTY_CONTACT }, notes: [], error: '', ranked: [] };

  const result = await askJson(svc, CONTACT_PROMPT, userText, schema);
  // The AI only suggests; the choice is INVECK's ranking over the people who pass the checks. When the
  // AI can't be reached, the ranking still picks from the LinkedIn candidates already found (people
  // named only in records need the AI's vetting or a LinkedIn check, so they wait for it).
  const aiError = result.error !== undefined ? result.error : '';
  const d: Record<string, unknown> = result.error !== undefined ? { chosen_id: '', other_ids: [], reason: '', roles_to_find_on_linkedin: [] } : result.data;
  const aiChosen = byId.get(asText(d.chosen_id));
  // Only people who passed the hard checks are ranked, so ranking never brings back someone excluded:
  // a role on the ICP's lists, an employer confirmed (a LinkedIn profile showing this company, or a
  // person the AI vetted as working there), and, to be the main contact, a location confirmed at this
  // site when the lead has a city. People from records and email lists get their location confirmed on
  // LinkedIn before they are used (see vetPick). INVECK's order then decides who comes first: plant
  // heads, then hands-on heads, then process owners. The sales team's own contact always stays.
  const vetted = new Set([asText(d.chosen_id), ...asTextList(d.other_ids).map((x) => x.trim())]);
  const passed = candidates.filter(
    (c) => c.source === 'Sales team' || (contactPriority(c.title, icp) < 99 && (c.source === 'LinkedIn' || vetted.has(c.id)) && !atOtherSite(c, lead.city, icp)),
  );
  // The main contact: at this site (or a P1 at another site), and no contradictory current job on their profile.
  const mainPool = passed.filter((c) => c.source !== 'LinkedIn' || (canBeMain(c, lead.city, icp) && !c.conflict));
  const manualPick = candidates.find((c) => c.source === 'Sales team');
  let chosen: Candidate | undefined = manualPick ?? rankCandidates(mainPool, icp, lead.city)[0];
  if (!manualPick && aiChosen && chosen && aiChosen !== chosen && mainPool.includes(aiChosen) && candidateRank(aiChosen, icp, lead.city) <= candidateRank(chosen, icp, lead.city)) chosen = aiChosen;
  if (chosen && tierOf(chosen.title, icp) === 'Avoid') chosen = undefined;
  const contact = chosen
    ? toContact(chosen, tierOf(chosen.title, icp) === 'P1', chosen.id === asText(d.chosen_id) ? asText(d.reason) : `Ranked first by INVECK's contact priority: ${chosen.title}`)
    : { ...EMPTY_CONTACT };

  // Everyone found, best first by INVECK's contact priority, the chosen contact on top.
  // Shown and kept: people with a LinkedIn profile at this company, and the sales team's own contact.
  // Someone named only in records or an email list is used only once LinkedIn confirms them (vetPick).
  const ranked = [...(chosen ? [chosen] : []), ...rankCandidates(passed.filter((c) => c !== chosen && (c.source === 'LinkedIn' || c.source === 'Sales team')), icp, lead.city)];
  // The others worth contacting: the next best on the ICP's lists, in the same order as the People card.
  const others = ranked
    .filter((c) => c !== chosen && contactPriority(c.title, icp) < 99)
    .slice(0, 4)
    .map((c) => [c.name, c.title, c.email || c.linkedin].filter(Boolean).join(' | '));
  const rolesToFind = asTextList(d.roles_to_find_on_linkedin);

  const notes: string[] = [];
  if (others.length) notes.push('Other decision-makers:\n' + others.join('\n'));
  if (rolesToFind.length) notes.push('Still to find on LinkedIn: ' + rolesToFind.join(', '));
  if (aiError) notes.push(`Contact picked by INVECK's ranking alone (the AI could not be reached: ${aiError})`);
  return { contact, notes, error: aiError, ranked };
}
