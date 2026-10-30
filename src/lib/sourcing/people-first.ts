import { LOGISTICS, MANUFACTURING } from '../db/seed';
import type { Icp } from '../db/schema';
import { toLinkedInPeople } from '../pipeline/contacts';
import { isPlace, snippetRoles, subtitleJob } from '../pipeline/employer';
import type { SerperResult } from '../pipeline/services';
import { normCompany, searchName } from '../pipeline/text';
import { contactPriority, noDepartment, tierOf, titlePhrase } from '../tiers';
import { readCompanyPage, SEGMENT_SEARCH, shuffled, type CompanyPage, type SourcingSegment } from './linkedin-pages';

/**
 * People first: search LinkedIn (through Google) for the job titles on the ICP's lists, in the
 * segment's industries and clusters, then check each person's company. Every company found this way
 * comes with a named contact, so none of them waits for someone to find one.
 */

type TitleIcp = Pick<Icp, 'segment' | 'targetTitles' | 'p2Titles' | 'p3Titles' | 'avoidTitles'>;

/**
 * Words for what the company makes or does, from INVECK's ICP list, as people write them in their own
 * profiles. Every people search has one: a title and a place alone bring every hotel and app company.
 */
export const PEOPLE_KEYWORDS: Record<SourcingSegment, string[]> = {
  [MANUFACTURING]: [
    'bearings', 'auto components', 'automotive components', 'forging', 'foundry', 'castings', 'heavy engineering', 'industrial machinery', 'machine tools', 'industrial equipment', 'precision engineering', 'defence manufacturing', 'aerospace components',
    // More words for the same ICP industries (INVECK, 28 Oct 2026): what their people write instead.
    'auto parts', 'auto ancillary', 'engine components', 'tractor components', 'gears', 'gearbox', 'transmission components', 'fasteners', 'sheet metal', 'pressings',
    'die casting', 'investment casting', 'precision machining', 'CNC machining', 'machined components', 'hydraulics', 'pumps', 'valves', 'compressors',
    'material handling equipment', 'construction equipment', 'earthmoving equipment', 'heavy fabrication', 'railway components', 'defence equipment', 'aircraft components',
  ],
  [LOGISTICS]: [
    '3PL', 'warehousing', 'contract logistics', 'third party logistics', 'supply chain solutions', 'cold chain',
    // More words for the same ICP industries (INVECK, 28 Oct 2026).
    'warehousing and distribution', 'distribution centre', 'logistics park', 'integrated logistics', 'cold storage', 'fulfilment centre', 'in-plant logistics', 'temperature controlled logistics',
    // What 3PL staff write on their profiles (INVECK, 30 Oct 2026); no freight or transport words (a freight broker with
    // no warehousing is a deal-breaker).
    'warehouse operations', 'multi-client warehouse', 'bonded warehouse', 'FTWZ', 'free trade warehousing zone', 'pharma logistics', 'pharma warehousing', 'automotive logistics',
    'inbound logistics', 'contract warehousing', 'warehousing services', 'logistics service provider', 'supply chain services', 'cross docking', 'distribution center',
    'FMCG logistics', 'healthcare logistics', 'spare parts logistics', 'industrial logistics', 'temperature controlled warehousing', 'value added logistics',
  ],
};

const listOf = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * The titles searched for, most wanted first: the ICP's P1 list (plant heads first for manufacturers),
 * then P2. A bare level ("General Manager", "DGM") would bring every department, so it isn't searched.
 */
export function searchTitles(icp: TitleIcp): string[] {
  const floor = icp.segment === MANUFACTURING ? ['Plant Head', 'Plant Manager'] : [];
  return [...new Set([...floor, ...listOf(icp.targetTitles), ...listOf(icp.p2Titles)])].filter((t) => ['P1', 'P2'].includes(tierOf(t, icp)) && !noDepartment(t));
}

export type PeopleQuery = {
  q: string;
  /** Always 'industry': the title with a word for what the company makes or does (tests from before kept 'open' ones). */
  form: 'industry' | 'open';
  title: string;
  keyword: string;
  place: string;
  /** The page of Google's results to read (the first when absent): a search made in the last days is read further down, not again (see planFromMemory). */
  page?: number;
  /** Results asked for (ten when absent); a hundred to read a rich search deep in one search, 2 credits (see planFromMemory). */
  num?: number;
  /** The page of ten to read instead, when Serper refuses a hundred results. */
  fallbackPage?: number;
};

/**
 * The searches for one test: a title, a word for the industry and a place. Titles go round in the
 * ICP's order (P1 first), words and places in an order that changes from one test to the next.
 */
export function planPeopleQueries(segment: SourcingSegment, icp: TitleIcp, count: number, seed = 0): PeopleQuery[] {
  const titles = searchTitles(icp);
  const ks = shuffled(PEOPLE_KEYWORDS[segment], seed);
  const ps = shuffled(SEGMENT_SEARCH[segment].places, seed + 7);
  const out: PeopleQuery[] = [];
  if (!titles.length) return out;
  for (let i = 0; out.length < count && i < count * 4; i++) {
    const title = titles[i % titles.length];
    const keyword = ks[i % ks.length];
    const place = ps[(i + Math.floor(i / ps.length)) % ps.length];
    const q = ['site:linkedin.com/in', `"${titlePhrase(title)}"`, `"${keyword}"`, place].join(' ');
    if (!out.some((o) => o.q === q)) out.push({ q, form: 'industry', title, keyword, place });
  }
  return out;
}

/** Someone found, and what was made of them. */
export type FoundContact = {
  name: string;
  title: string;
  /** P1, P2 or P3 when on the ICP's lists. */
  tier: string;
  /** Their current employer as the profile shows it. */
  employer: string;
  location: string;
  linkedin: string;
  /** Why they can't be a contact; '' when they can. */
  why: string;
  /** What their own LinkedIn result says of their company's industry (see industryHint): only the order companies are checked in. */
  hint?: 'icp' | 'other' | '';
};

/** A current employer no company can be: self-employed, between jobs, undisclosed. */
const NO_EMPLOYER = /\b(self[- ]?employed|freelanc\w*|retired|looking for|open to (?:work|opportunities|new)|seeking|career break|confidential|stealth|various)\b/i;

/**
 * The person's current job as Google shows it: the line under the result ("Pune, Maharashtra, India ·
 * Plant Head · Acme Forgings"), else a current job in the snippet, else the title ("Name - Plant Head -
 * Acme Forgings" or "Name - Plant Head at Acme Forgings").
 */
export function currentJobOf(r: SerperResult): { role: string; company: string } | null {
  const line = subtitleJob(r.subtitle);
  if (line) return line;
  const now = snippetRoles(r.snippet || '').find((j) => j.current);
  if (now) return { role: now.role, company: now.company };
  const parts = String(r.title || '')
    .replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '')
    .split(/\s+[-–—]\s+/)
    .map((p) => p.split(/\s*\|\s*/)[0].trim())
    .filter(Boolean);
  if (parts.length >= 3) return { role: parts[1], company: parts[parts.length - 1] };
  const at = parts.length === 2 ? /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(parts[1]) : null;
  return at ? { role: at[1].trim(), company: at[2].trim() } : null;
}

/**
 * A person from a Google result, with whether they can be a contact: their profile shows a current
 * employer (the same strict reading as the contact search: one current job there, no conflicting
 * one), they are in India, and their title is on the ICP's P1/P2/P3 lists. Null for a result that
 * isn't a profile.
 */
export function readPerson(r: SerperResult, icp: TitleIcp): FoundContact | null {
  const linkedin = String(r.link || '').split('?')[0];
  if (!/linkedin\.com\/in\//i.test(linkedin)) return null;
  const job = currentJobOf(r);
  const employer = (job?.company ?? '').replace(/\s*(\.\.\.|…)\s*$/, '').replace(/[\s,.]+$/, '').trim();
  const name = String(r.title || '').split(/\s+[-–—|]\s+/)[0].trim();
  if (!employer || NO_EMPLOYER.test(employer) || isPlace(employer)) {
    return { name, title: job?.role ?? '', tier: '', employer: '', location: '', linkedin, why: 'no current employer shown' };
  }
  const [p] = toLinkedInPeople([r], employer);
  // The contact search leaves out profiles on another country's LinkedIn (uk., ae., pk.) and nameless ones.
  if (!p) {
    const host = /^https?:\/\/([a-z]{2,3})\.linkedin\.com\//i.exec(linkedin)?.[1]?.toLowerCase() ?? '';
    const why = host && host !== 'www' && host !== 'in' ? `based outside India (a profile on ${host}.linkedin.com)` : 'no name shown';
    return { name, title: job?.role ?? '', tier: '', employer, location: '', linkedin, why };
  }
  const tier = tierOf(p.title, icp);
  const base = { name: p.name || name, title: p.title, tier: ['P1', 'P2', 'P3'].includes(tier) ? tier : '', employer, location: p.location ?? '', linkedin };
  if (p.abroad) return { ...base, why: `based outside India (${p.location || 'another country'})` };
  if (p.employer !== 'here') return { ...base, why: p.evidence || `the profile doesn't show ${employer} as the current employer` };
  if (p.conflict) return { ...base, why: p.conflict };
  if (!base.tier || contactPriority(p.title, icp) >= 99) return { ...base, tier: '', why: p.title ? `${p.title}: not on the ICP's lists` : 'no job title shown' };
  return { ...base, why: '' };
}

/** The search for a company's LinkedIn page by the name its staff write. */
export function companyQuery(employer: string): string {
  return `site:linkedin.com/company "${(searchName(employer) || employer).replace(/"/g, '')}"`;
}

/** One search for several companies' LinkedIn pages at once: `site:linkedin.com/company ("A" OR "B" OR "C")`. */
export function companiesQuery(employers: string[]): string {
  if (employers.length === 1) return companyQuery(employers[0]);
  return `site:linkedin.com/company (${employers.map((e) => `"${(searchName(e) || e).replace(/"/g, '')}"`).join(' OR ')})`;
}

/** Companies whose LinkedIn pages are looked up in one search (see companiesQuery): up to this many, as Google's 32 words allow. */
export const PAGES_PER_SEARCH = 6;

/**
 * The next companies to check, taken from the front of `pending`: up to PAGES_PER_SEARCH, the ones looked up together
 * (not those whose page is already known, or that are looked up on their own) within Google's 32 words.
 */
export function lookupBatch<T extends { employer: string; page?: unknown; alone?: boolean }>(pending: T[]): T[] {
  let words = 1;
  let n = 0;
  for (const c of pending) {
    if (n >= PAGES_PER_SEARCH) break;
    if (!c.page && !c.alone) {
      const w = (searchName(c.employer) || c.employer).split(/\s+/).filter((x) => /[a-z0-9]/i.test(x)).length + (words > 1 ? 1 : 0);
      if (n && words + w > 32) break;
      words += w;
    }
    n++;
  }
  return pending.splice(0, Math.max(1, n));
}

/** The order to check companies in: any whose people's own results show another industry last, then by their best contact. */
export function hintRank(contacts: Pick<FoundContact, 'hint'>[]): number {
  return contacts.some((p) => p.hint === 'icp') || !contacts.some((p) => p.hint === 'other') ? 0 : 1;
}

/**
 * The company's own page among the results: the same name (legal suffixes aside), else a page whose
 * name starts with the one the person wrote, or the other way round ("Acme Forgings" and "Acme
 * Forgings India"), never a short one inside a longer one ("Tata" is not Tata Motors).
 */
export function matchingPage(results: SerperResult[], employer: string): CompanyPage | null {
  const want = normCompany(employer);
  if (!want) return null;
  const pages = results.map(readCompanyPage).filter((p): p is CompanyPage => !!p);
  const close = (n: string) => Math.min(n.length, want.length) >= 6 && (n.startsWith(want) || want.startsWith(n));
  return pages.find((p) => normCompany(p.name) === want) ?? pages.find((p) => close(normCompany(p.name))) ?? null;
}
