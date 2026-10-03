import type { SerperResult, Services } from './services';
import { googleSearch } from './services';
import { rootDomain } from './text';

// Directories, social networks, marketplaces and news sites are never a company's own website.
export const BLOCKED_DOMAINS =
  /(^|\.)(linkedin|indiamart|justdial|naukri|wikipedia|zaubacorp|tofler|facebook|instagram|twitter|x|youtube|glassdoor|ambitionbox|crunchbase|tracxn|economictimes|moneycontrol|tradeindia|exportersindia|zoominfo|rocketreach|apollo|dnb|bloomberg|google|amazon|flipkart|business-standard|livemint|thehindu|ndtv|screener|bseindia|nseindia|falconebiz|thecompanycheck|instafinancials|signalhire|lusha)\.|\.gov\.in$/;

export function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.test(domain);
}

// Words that say what a company does rather than which company it is.
const GENERIC = new Set(
  'pvt private ltd limited llp inc india indian the and company group industries industry chemicals chemical pharma pharmaceuticals pharmaceutical works systems solutions technologies technology enterprises international global services logistics manufacturing products engineering corporation corp'.split(' '),
);

export function nameTokens(company: string): string[] {
  const words = company.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  const distinctive = words.filter((w) => !GENERIC.has(w) && (w.length >= 3 || /\d/.test(w)));
  return distinctive.length ? distinctive : words.filter((w) => w.length >= 3);
}

// Extra words in a domain that say it belongs to another organisation ("cumminscollege.org").
const OTHER_ORG = /(college|school|university|institute|academy|hospital|news|jobs|careers|alumni|foundation|trust|blog)/;
// Extra words that still mean the same company ("cumminsindia.com", "yazaki-group.com").
const SAME_ORG = /^(?:india|group|global|intl|international|in|ind|co|corp|ltd|pvt|hq|the|world|online)*$/;

/**
 * How well a domain matches a company name: 0 = not this company; 3+ = the domain is the
 * company's name, give or take words like "india" or "group" ("Honeywell" → honeywell.com).
 */
export function domainScore(company: string, domain: string): number {
  const tokens = nameTokens(company);
  const root = rootDomain(domain);
  if (!tokens.length || !root || isBlockedDomain(root)) return 0;
  const label = root.split('.')[0].replace(/-/g, '');
  const matched = tokens.filter((t) => label.includes(t));
  if (!matched.length) return 0;
  const rest = matched.reduce((r, t) => r.replace(t, ''), label);
  if (OTHER_ORG.test(rest) && !OTHER_ORG.test(company.toLowerCase())) return 0;
  // What's left of the domain must be the company's own other words, or short forms of them
  // ("bodalchem" for Bodal Chemicals), or harmless extras ("india", "group"). Anything else is another
  // company sharing a word: madrasfert.com is Madras Fertilizers, not Madras Engineering Industries.
  // A domain holding every distinctive word of a longer name (tatautocomp.com) needs no such check.
  const fullName = tokens.length >= 2 && matched.length === tokens.length;
  if (!fullName && !SAME_ORG.test(ownWordsRemoved(rest, company))) return 0;
  const clean = SAME_ORG.test(rest);
  return matched.length + (clean && matched.length === tokens.length ? 1 : 0) + (clean ? 1 : 0);
}

/** The domain's leftover letters with the company's own words (whole, or their first 3+ letters) and initials taken out. */
function ownWordsRemoved(rest: string, company: string): string {
  const words = company.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  let r = rest;
  const initials = words.map((w) => w[0]).join('');
  if (initials.length >= 2 && r.includes(initials)) r = r.replace(initials, '');
  for (const w of words) {
    for (let len = w.length; len >= 3; len--) {
      const piece = w.slice(0, len);
      if (r.includes(piece)) {
        r = r.replace(piece, '');
        break;
      }
    }
  }
  return r;
}

/**
 * The company's own domain among search results: the non-directory result whose domain best
 * matches the company name ("Bodal Chemicals" → bodal.com). Earlier results win ties.
 */
export function pickOfficialDomain(company: string, results: SerperResult[]): string {
  let best = '';
  let bestScore = 0;
  for (const r of results.slice(0, 10)) {
    const domain = rootDomain(r.link);
    const score = domain ? domainScore(company, domain) : 0;
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  return best;
}

/** Looks the company's website up on Google. Returns '' when nothing convincing turns up. */
export async function findOfficialWebsite(svc: Services, company: string, city: string): Promise<string> {
  try {
    const results = await googleSearch(svc, `${company} ${city} official website`.replace(/\s+/g, ' ').trim());
    return pickOfficialDomain(company, results);
  } catch {
    return '';
  }
}
