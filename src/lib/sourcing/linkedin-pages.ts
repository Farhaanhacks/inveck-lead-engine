import { LOGISTICS, MANUFACTURING } from '../db/seed';
import { linkedinPageFacts } from '../pipeline/firm-identity';
import { employeeTarget, sizeBandTop } from '../pipeline/fit';
import { basedAbroad, namesIndianPlace, placeNamedIn } from '../pipeline/employer';
import { normCompany, rootDomain } from '../pipeline/text';
import type { SerperResult } from '../pipeline/services';

/**
 * Finding companies through their LinkedIn pages. Google's result for a company page shows what the
 * ICP screens on first: the company's size band, its industry and its headquarters ("Industry:
 * Machinery Manufacturing; Company size: 201-500 employees; Headquarters: Pune, Maharashtra"). So the
 * cheap, decisive checks (size, industry, location, already known) come before any research.
 */

export const SOURCING_SEGMENTS = [MANUFACTURING, LOGISTICS] as const;
export type SourcingSegment = (typeof SOURCING_SEGMENTS)[number];

/** LinkedIn's size bands as its pages write them, smallest first. */
export const LINKEDIN_BANDS = ['2-10', '11-50', '51-200', '201-500', '501-1,000', '1,001-5,000', '5,001-10,000', '10,001+'] as const;

/** What to search for and where, per segment: LinkedIn's own industry names and the words companies use, and the clusters. */
export const SEGMENT_SEARCH: Record<SourcingSegment, { keywords: string[]; places: string[] }> = {
  [MANUFACTURING]: {
    keywords: [
      'Industrial Machinery Manufacturing',
      'Motor Vehicle Parts Manufacturing',
      'Machinery Manufacturing',
      'Automation Machinery Manufacturing',
      'Defense and Space Manufacturing',
      'Aviation and Aerospace Component Manufacturing',
      'Engines and Power Transmission Equipment Manufacturing',
      'forgings',
      'castings',
      'foundry',
      'bearings',
      'auto components',
      'machine tools',
      'precision engineering',
      'heavy engineering',
      'industrial equipment',
    ],
    places: ['Pune', 'Chakan', 'Pimpri-Chinchwad', 'Kolhapur', 'Rajkot', 'Ludhiana', 'Coimbatore', 'Belagavi', 'Chennai', 'Hosur', 'Sriperumbudur', 'Bengaluru', 'Tumakuru', 'Gurugram', 'Manesar', 'Faridabad', 'Noida', 'Sanand', 'Ahmedabad', 'Vadodara', 'Halol', 'Hyderabad', 'Kolkata', 'Nagpur'],
  },
  [LOGISTICS]: {
    keywords: ['Warehousing and Storage', '3PL', 'third party logistics', 'contract logistics', 'warehousing', 'cold chain', 'distribution centre', 'supply chain solutions'],
    places: ['Gurugram', 'Faridabad', 'Noida', 'Bhiwandi', 'Navi Mumbai', 'Mumbai', 'Chennai', 'Sriperumbudur', 'Pune', 'Chakan', 'Bengaluru', 'Hyderabad', 'Ahmedabad', 'Vadodara', 'Kolkata'],
  },
};

/** The bands big enough for the target: their top is above it (the top band has none). */
export function bandsFor(target: number | null): string[] {
  if (!target) return LINKEDIN_BANDS.slice(3).map(String);
  return LINKEDIN_BANDS.filter((b) => {
    const top = sizeBandTop(b);
    return top == null || top > target;
  }).map(String);
}

export type PlannedQuery = {
  q: string;
  /** 'band': the size bands are in the query; 'open': any size, read from the result afterwards. */
  form: 'band' | 'open';
  keyword: string;
  place: string;
};

/** A stable shuffle, different for each seed, so each test searches other keywords and places. */
export function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = (seed * 2654435761 + 1013904223) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The searches for one test: keyword and place pairs, every place and keyword used before any is used
 * twice. Most searches name the size bands; every fourth is open (any size) so the two can be compared.
 */
export function planQueries(segment: SourcingSegment, companySize: string, count: number, seed = 0): PlannedQuery[] {
  const { keywords, places } = SEGMENT_SEARCH[segment];
  const bands = bandsFor(employeeTarget(companySize)).map((b) => `"${b} employees"`);
  const ks = shuffled(keywords, seed);
  const ps = shuffled(places, seed + 7);
  const out: PlannedQuery[] = [];
  for (let i = 0; out.length < count && i < ks.length * ps.length; i++) {
    const keyword = ks[i % ks.length];
    const place = ps[(i + Math.floor(i / ps.length)) % ps.length];
    const form = i % 4 === 3 ? 'open' : 'band';
    const q = ['site:linkedin.com/company', `"${keyword}"`, `"${place}"`, form === 'band' ? `(${bands.join(' OR ')})` : ''].filter(Boolean).join(' ');
    if (!out.some((o) => o.q === q)) out.push({ q, form, keyword, place });
  }
  return out;
}

/** A company page as Google shows it. */
export type CompanyPage = {
  name: string;
  /** Google cut the name short ("Prospira India Automotive Products Pvt. Ltd., (Ex. ..."). */
  nameCut?: boolean;
  url: string;
  /** LinkedIn's band as shown ("201-500 employees"), '' when the result doesn't show it. */
  size: string;
  industry: string;
  /** Headquarters as shown ("Pune, Maharashtra"), '' when not shown. */
  hq: string;
  website: string;
  followers: number;
  /** Google's text for the page, word for word. */
  text: string;
};

// LinkedIn's labels, capitalised as the page writes them ("Industry: Machinery Manufacturing" or
// "Industry Machinery Manufacturing, Company size 201-500 employees"): prose ("the auto industry") isn't one.
const LABELS = 'Company size|Headquarters|Industry|Type\\b|Founded|Specialties|Website|Locations?\\b';
const field = (label: string, text: string) =>
  new RegExp(`\\b${label}:?\\s+(.+?)(?=[\\s,]*(?:[.;|·•\\n]|\\s-\\s|${LABELS}|$))`).exec(text)?.[1].replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim() ?? '';

/** The company page's own address ("https://in.linkedin.com/company/acme-forge"), '' for a post, a job or a showcase page. */
export function companyPageUrl(link: string | undefined): string {
  const m = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(String(link ?? '').trim());
  return m ? `https://www.linkedin.com/company/${m[1].toLowerCase()}` : '';
}

/**
 * The page's name from Google's title, without " | LinkedIn" and without the part Google cut off
 * ("Prospira India Automotive Products Pvt. Ltd., (Ex. ..." gives "Prospira India Automotive Products Pvt. Ltd.").
 */
export function pageName(title: string | undefined): { name: string; cut: boolean } {
  let name = String(title || '')
    .replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '')
    .replace(/\s*\|\s*[\d,.]+[km]?\s+followers.*$/i, '')
    .trim();
  const cut = /(\.\.\.|…)$/.test(name);
  // A bracket opened and never closed: the rest was cut off.
  name = name.replace(/\s*(\.\.\.|…)$/, '').replace(/\s*[([][^)\]]*$/, '');
  return { name: name.replace(/[\s,;:|\-–]+$/, '').trim(), cut };
}

/**
 * LinkedIn's header line, when Google shows it: "Motor Vehicle Parts Manufacturing · Sheffield, South
 * Yorkshire · 794 followers" (the industry, then the headquarters).
 */
const HEADER = /([A-Z][^·•|\n.]{2,80}?)\s+[·•]\s+([^·•|\n.]{2,60}?)\s+[·•]\s+[\d,.]+\s*[KkMm]?\s+followers/;

/** A company page from a Google result, or null when the result is not one. */
export function readCompanyPage(r: SerperResult): CompanyPage | null {
  const url = companyPageUrl(r.link);
  if (!url) return null;
  const { name, cut } = pageName(r.title);
  if (!name) return null;
  const text = [name, r.snippet || '', r.subtitle || ''].filter(Boolean).join('. ');
  const facts = linkedinPageFacts(text);
  const website = /\bWebsite:?\s+(https?:\/\/\S+|www\.\S+|[a-z0-9-]+\.[a-z.]{2,}\S*)/.exec(text)?.[1].replace(/[.,;)]+$/, '') ?? '';
  const header = HEADER.exec(text);
  return {
    name,
    ...(cut ? { nameCut: true } : {}),
    url,
    size: facts.size,
    industry: field('Industry', text) || header?.[1].trim() || '',
    hq: field('Headquarters', text) || header?.[2].trim() || '',
    website,
    followers: facts.followers,
    text,
  };
}

/** Size or headquarters missing from Google's text: worth a second search for the page's facts. */
export const needsFacts = (p: CompanyPage) => !p.size || !p.hq || !p.industry;

/**
 * The search that brings a page's About facts into Google's text: the page's own address, and
 * "Company size" (Google shows the part of the page with the words searched for).
 */
export function factsQuery(p: Pick<CompanyPage, 'url'>): string {
  return `site:${p.url.replace(/^https?:\/\/(www\.)?/, '')} "Company size"`;
}

/** The page with what the second search showed: size, industry, headquarters and website where they were missing. */
export function withFacts(p: CompanyPage, results: SerperResult[]): CompanyPage {
  const again = results.map(readCompanyPage).find((r) => r?.url === p.url);
  if (!again) return p;
  return {
    ...p,
    ...(p.nameCut && !again.nameCut && again.name.length > p.name.length ? { name: again.name, nameCut: undefined } : {}),
    size: p.size || again.size,
    industry: p.industry || again.industry,
    hq: p.hq || again.hq,
    website: p.website || again.website,
    followers: p.followers || again.followers,
    text: again.text === p.text ? p.text : `${p.text}\n${again.text}`,
  };
}

/** Headquarters outside India: a foreign place, or a "Town, Region" that names no Indian place ("Sheffield, South Yorkshire"). */
export function hqAbroad(hq: string): boolean {
  return basedAbroad(hq) || (hq.includes(',') && !namesIndianPlace(hq));
}

/**
 * The industries the ICP covers, by LinkedIn's own label (current and older names). Manufacturing is
 * INVECK's list: bearings, auto components, forgings, foundries, heavy engineering, industrial
 * machinery and machine tools, industrial equipment, precision engineering, defence and aerospace
 * components. Every other label is out: hotels, internet, retail, staffing, ceramics, electrical...
 */
const ICP_INDUSTRY: Record<SourcingSegment, RegExp> = {
  [MANUFACTURING]:
    /\b(motor vehicle|automotive|machinery|mechanical or industrial engineering|industrial automation|engines and power transmission|fabricated metal|primary metal|metal treatments|defen[cs]e|aerospace|railroad equipment|transportation equipment|shipbuilding)\b/i,
  [LOGISTICS]: /\b(logistics|supply chain|warehous\w*|storage|freight|truck\w*)\b/i,
};

/** LinkedIn's catch-all labels: they say nothing of what the company makes. */
const GENERIC_INDUSTRY = /^(industrial\s+)?manufacturing$/i;

/** What a company in the ICP says about itself, for a page with no label or a catch-all one. */
const ICP_WORDS: Record<SourcingSegment, RegExp> = {
  [MANUFACTURING]:
    /\b(bearings?|auto(?:motive)?[\s-]?(?:components?|parts|ancillar\w*)|forg(?:e|ed|ings?|ers?)|foundr(?:y|ies)|castings?|die[\s-]?cast\w*|machine tools?|machinery|heavy engineering|precision engineering|precision components?|industrial equipment|defen[cs]e|aerospace|gears?|gearbox\w*|crankshafts?|axles?)\b/i,
  [LOGISTICS]: /\b(3pl|third[\s-]party logistics|contract logistics|warehous\w*|supply chain solutions|cold chain|freight|logistics)\b/i,
};

/** Words that mark a company as something else, whatever else its page says. */
const OTHER_WORDS: Record<SourcingSegment, RegExp> = {
  [MANUFACTURING]:
    /\b(pharma\w*|food|beverages?|fmcg|chemicals?|plastics?|packaging|textiles?|apparel|garments?|cosmetics?|software|it services|saas|staffing|recruit\w*|hospitals?|healthcare|hotels?|hospitality|retail|e-?commerce|grocery|real estate|ceramics?|tiles|cement)\b/i,
  [LOGISTICS]: /\b(software|it services|saas|staffing|recruit\w*|hospitals?|healthcare|hotels?|hospitality|real estate|travel)\b/i,
};

/**
 * Whether the company is in the segment's industries: its LinkedIn label is one the ICP covers; or the
 * label is a catch-all ("Manufacturing") or missing, and its page says what it makes in the ICP's
 * words, with nothing marking it as something else. '' when it is; why not when it isn't.
 */
/** The industry LinkedIn doesn't settle: no label (or only "Manufacturing"), and nothing in the page's text either way. */
export function industryUnclear(p: CompanyPage, segment: SourcingSegment): boolean {
  const label = p.industry.trim();
  if (label && !GENERIC_INDUSTRY.test(label)) return false;
  const text = `${p.name}. ${p.text}`;
  return !OTHER_WORDS[segment].test(text) && !ICP_WORDS[segment].test(text);
}

/** A company the search found without a LinkedIn page: its name only (its website and research tell the rest). */
export function pagelessCompany(employer: string): CompanyPage {
  return { name: employer, url: '', size: '', industry: '', hq: '', website: '', followers: 0, text: '' };
}

const NAME_FILLER = /\b(foundry|foundries|forging|forgings|casting|castings|manufacturing|manufacturer|manufacturers|industries|industry|industrial|engineering|works|company|co|corp|corporation|group|pvt|private|ltd|limited|llp|inc|india|the|and|of|plant|factory|logistics|warehouse|warehousing)\b/gi;

/** An employer written as an industry word, not a name ("Foundry", "Manufacturing Industry"): nothing to look up. */
export function noCompanyName(employer: string): boolean {
  return employer.replace(/[^a-z0-9\s]/gi, ' ').replace(NAME_FILLER, ' ').trim().length < 2;
}

export function industryProblem(p: CompanyPage, segment: SourcingSegment): string {
  const label = p.industry.trim();
  if (label && !GENERIC_INDUSTRY.test(label)) return ICP_INDUSTRY[segment].test(label) ? '' : `industry not in the ICP: ${label}`;
  const text = `${p.name}. ${p.text}`;
  const other = OTHER_WORDS[segment].exec(text)?.[0];
  if (other) return `${label ? `LinkedIn says only "${label}"` : 'industry not shown'}, and its page mentions "${other}"`;
  if (!ICP_WORDS[segment].test(text)) return label ? `LinkedIn says only "${label}", and nothing on its page shows it's in the ICP` : "industry not shown on its LinkedIn page, and nothing on it shows it's in the ICP";
  return '';
}

/** Consumer delivery, out for 3PL: courier, parcel, last mile, B2C or D2C fulfilment. */
const CONSUMER_DELIVERY = /\b(courier|parcel|last[\s-]?mile|hyperlocal|quick commerce|b2c|d2c|e-?commerce delivery|express delivery|food delivery|packers? (?:and|&) movers)\b/i;

export type Known = { names: Set<string>; domains: Set<string> };

export type Screen =
  | { pass: true; note: string }
  | { pass: false; reason: 'abroad' | 'small' | 'industry' | 'known'; note: string };

/**
 * The first checks, from the page alone: based in India, big enough (a band at half the target or
 * less is out; up to the target is borderline and kept), new to INVECK (not a lead in any state, a
 * client or on INVECK's own lists), and shown to be in an industry the ICP covers (see industryProblem).
 * `passUnclearIndustry` (the Sourcing tests' rule): an industry nothing shows either way doesn't rule it
 * out; research checks it on the company's website.
 */
export function screenPage(p: CompanyPage, segment: SourcingSegment, companySize: string, known: Known, opts: { passUnclearIndustry?: boolean } = {}): Screen {
  // Based abroad with a site in India (MEI Brakes: Sheffield and Chennai) is a prospect for that site;
  // with none named, it isn't.
  let abroad = '';
  if (p.hq && hqAbroad(p.hq)) {
    const site = placeNamedIn(p.text);
    if (!site) return { pass: false, reason: 'abroad', note: `headquartered abroad (${p.hq}), no site in India named` };
    abroad = `headquartered abroad (${p.hq}), with a site in ${site}; `;
  }
  const target = employeeTarget(companySize);
  const top = p.size ? sizeBandTop(p.size) : null;
  if (target && top != null && top <= target / 2) return { pass: false, reason: 'small', note: `too small: ${p.size} against ${companySize}` };
  const domain = rootDomain(p.website);
  if (known.names.has(normCompany(p.name)) || (domain && known.domains.has(domain))) return { pass: false, reason: 'known', note: 'already known to INVECK (a lead, a client or on its own lists)' };
  const industry = industryProblem(p, segment);
  const unclear = !!industry && !!opts.passUnclearIndustry && industryUnclear(p, segment);
  if (industry && !unclear) return { pass: false, reason: 'industry', note: industry };
  if (segment === LOGISTICS && CONSUMER_DELIVERY.test(`${p.name} ${p.industry} ${p.text}`)) return { pass: false, reason: 'industry', note: `consumer delivery (courier, parcel, last mile or B2C), out of the 3PL ICP` };
  const note = !p.size
    ? 'size not shown'
    : target && top != null && top <= target
      ? `borderline size: ${p.size} against ${companySize}`
      : `size ${p.size}`;
  return { pass: true, note: abroad + note + (unclear ? '; industry not shown on LinkedIn or its website: research checks it' : '') };
}

/** Big enough for certain (a band above the target), borderline, or not shown: the order companies are checked for people. */
export function sizeRank(p: CompanyPage, companySize: string): number {
  const target = employeeTarget(companySize);
  const top = p.size ? sizeBandTop(p.size) : null;
  if (!p.size) return 2;
  if (/\+/.test(p.size) || top == null || !target || top > target) return 0;
  return 1;
}
