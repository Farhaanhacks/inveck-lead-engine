import type { EnrichmentCache, Services } from './services';
import { googleSearch } from './services';
import { brandOf, registerFirmAliases, registerFirmWebsite } from './employer';
import { rootDomain } from './text';

/**
 * Who the company is on LinkedIn. Staff profiles name their employer as the company's LinkedIn page
 * does ("Micron Technology"), rarely as its legal name ("Micron Semiconductor Technology India Pvt
 * Ltd"). The page is found by its listed website, or by its name when Google's result shows the
 * website or the company's town, so only the company's own page counts, never a similarly named one
 * (Brasstech Inc. in California is not Brasstech Engineering in Jamnagar). Google's result for the
 * page also says how big the company is ("Company size: 11-50 employees") and how many follow it:
 * evidence of size for the ICP. Kept in the database: one lookup per company (a year for "no page").
 */

const KEEP_DAYS = 365;
const DAY_MS = 86_400_000;

/** The company's LinkedIn page, as Google shows it. */
export type FirmPage = {
  name: string;
  url: string;
  /** LinkedIn's size band as shown ("11-50 employees"), '' when not shown. */
  size: string;
  /** Followers on LinkedIn, 0 when not shown. */
  followers: number;
  /** Google's text for the page, word for word (quoted as evidence). */
  text: string;
};

type Known = { names: string[]; page?: FirmPage | null; at: string };

const pageTitle = (r: { title?: string }) => String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '').trim();

/** The page's name from a Google result, when the page lists this website ("Website: http://www.micron.com"). */
export function linkedinPageName(r: { title?: string; link?: string; snippet?: string }, domain: string): string {
  if (!/linkedin\.com\/company\//i.test(r.link || '')) return '';
  const site = /\bwebsite:\s*(\S+)/i.exec(r.snippet || '')?.[1] ?? '';
  if (!site || rootDomain(site.replace(/[.,;]+$/, '')) !== domain) return '';
  return pageTitle(r);
}

/** "Company size: 51-200 employees" and "2,345 followers", from Google's text for a LinkedIn page. */
export function linkedinPageFacts(text: string): { size: string; followers: number } {
  const band = /\b(\d[\d,]*\s*[-–]\s*\d[\d,]*|\d[\d,]*\+)\s+employees\b/i.exec(text);
  const follow = /\b(\d[\d,.]*)\s*([km])?\s+followers\b/i.exec(text);
  const scale = follow?.[2]?.toLowerCase() === 'k' ? 1_000 : follow?.[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  const followers = follow ? Math.round(Number(follow[1].replace(/,/g, '')) * scale) : 0;
  return { size: band ? `${band[1].replace(/\s+/g, '').replace('–', '-')} employees` : '', followers: Number.isFinite(followers) ? followers : 0 };
}

function pageOf(r: { title?: string; link?: string; snippet?: string }): FirmPage {
  const text = [pageTitle(r), r.snippet || ''].filter(Boolean).join('. ');
  return { name: pageTitle(r), url: String(r.link || '').split('?')[0], ...linkedinPageFacts(text), text };
}

/** Each company's LinkedIn page, as recorded this run. */
const pages = new Map<string, FirmPage>();
const firmKey = (company: string) => company.trim().toLowerCase();

/** The company's LinkedIn page, when it was found (this run or an earlier one). */
export function firmPageOf(company: string): FirmPage | null {
  return pages.get(firmKey(company)) ?? null;
}

function remember(company: string, known: Known) {
  registerFirmAliases(company, known.names ?? []);
  if (known.page) pages.set(firmKey(company), known.page);
}

/**
 * A company's LinkedIn page found another way (by the people-first search): remembered as if it had
 * been looked up, so research doesn't search for it again.
 */
export async function knowFirmPage(svc: Pick<Services, 'cache'>, company: string, website: string | null | undefined, page: FirmPage): Promise<void> {
  registerFirmWebsite(company, website);
  const known: Known = { names: [page.name], page: { name: page.name, url: page.url, size: page.size, followers: page.followers, text: page.text }, at: new Date().toISOString() };
  remember(company, known);
  const domain = rootDomain(website);
  if (domain) await svc.cache?.set(`linkedin-page:v2:${domain}`, known).catch(() => {});
}

/**
 * What an earlier lookup found, with no search (for jobs that have only the database): true when
 * the company's LinkedIn page was looked up before. A lookup from before sizes were read gives its
 * names, and the page is looked up again when there is a search to spend.
 */
export async function recallFirm(cache: EnrichmentCache | undefined, company: string, website: string | null | undefined): Promise<boolean> {
  registerFirmWebsite(company, website);
  const domain = rootDomain(website);
  if (!domain || !company.trim()) return true;
  try {
    for (const key of [`linkedin-page:v2:${domain}`, `linkedin-page:v1:${domain}`]) {
      const known = (await cache?.get(key)) as Known | null | undefined;
      if (known?.at && Date.now() - new Date(known.at).getTime() < KEEP_DAYS * DAY_MS) {
        remember(company, known);
        return key.includes(':v2:');
      }
    }
  } catch {}
  return false;
}

/** The town of a place ("Belagavi, Karnataka" gives "belagavi"). */
const townOf = (city: string) => city.split(',')[0].trim().toLowerCase();

/**
 * Records what is known about the company for matching its people: its website name, and its
 * LinkedIn page's name and size (looked up once; `cacheOnly` uses only an earlier lookup). Never
 * throws. Returns the page when it is known.
 */
export async function learnFirm(svc: Services, company: string, website: string | null | undefined, opts: { cacheOnly?: boolean; city?: string } = {}): Promise<FirmPage | null> {
  if ((await recallFirm(svc.cache, company, website)) || opts.cacheOnly || !svc.keys.serper) return firmPageOf(company);
  const domain = rootDomain(website);
  if (!domain || !company.trim()) return null;
  try {
    // Google's first page that lists the website is the company's own (a joint venture or a
    // reseller may list it too, further down).
    let page = (await googleSearch(svc, `site:linkedin.com/company "${domain}"`)).map((r) => (linkedinPageName(r, domain) ? pageOf(r) : null)).find(Boolean) ?? null;
    // No page lists the website: one with the company's brand in its name whose result shows the
    // website or the company's town. The name a lead came with can be off ("Servocontrols Aerospace
    // And Technologies" for Servocontrols Aerospace India).
    const brand = brandOf(company);
    const town = townOf(opts.city ?? '');
    if (!page && brand) {
      const results = await googleSearch(svc, `site:linkedin.com/company "${brand}"${town ? ` ${town}` : ''}`);
      page =
        results
          .filter((r) => /linkedin\.com\/company\//i.test(r.link || ''))
          .map(pageOf)
          .find((p) => new RegExp(`\\b${brand}\\b`, 'i').test(p.name) && (p.text.toLowerCase().includes(domain) || (town.length >= 3 && p.text.toLowerCase().includes(town)))) ?? null;
    }
    const known: Known = { names: page ? [page.name] : [], page, at: new Date().toISOString() };
    remember(company, known);
    await svc.cache?.set(`linkedin-page:v2:${domain}`, known).catch(() => {});
    return page;
  } catch {
    // Not known this time; the legal name and website name still match.
    return firmPageOf(company);
  }
}
