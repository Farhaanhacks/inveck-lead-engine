import type { SerperResult, Services } from './services';
import { googleSearch } from './services';
import { domainOf } from './text';

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

function nameTokens(company: string): string[] {
  const words = company.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  const distinctive = words.filter((w) => !GENERIC.has(w) && (w.length >= 3 || /\d/.test(w)));
  return distinctive.length ? distinctive : words.filter((w) => w.length >= 3);
}

/**
 * The company's own domain among search results: the first non-directory result whose
 * domain contains the most distinctive words of the company name ("Bodal Chemicals" → bodal.com).
 */
export function pickOfficialDomain(company: string, results: SerperResult[]): string {
  const tokens = nameTokens(company);
  if (!tokens.length) return '';
  let best = '';
  let bestScore = 0;
  for (const r of results.slice(0, 10)) {
    const domain = domainOf(r.link);
    if (!domain || isBlockedDomain(domain)) continue;
    const label = domain.split('.')[0].replace(/-/g, '');
    const score = tokens.filter((t) => label.includes(t)).length;
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
