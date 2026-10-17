import type { EnrichmentCache, Services } from './services';
import { googleSearch } from './services';
import { registerFirmAliases, registerFirmWebsite } from './employer';
import { rootDomain } from './text';

/**
 * Who the company is on LinkedIn. Staff profiles name their employer as the company's LinkedIn page
 * does ("Micron Technology"), rarely as its legal name ("Micron Semiconductor Technology India Pvt
 * Ltd"). The page is found by its listed website, so only the company's own page counts, never a
 * similarly named one. Kept in the database: one search per company, ever (a year for "no page").
 */

const KEEP_DAYS = 365;
const DAY_MS = 86_400_000;

type Known = { names: string[]; at: string };

/** The page's name from a Google result, when the page lists this website ("Website: http://www.micron.com"). */
export function linkedinPageName(r: { title?: string; link?: string; snippet?: string }, domain: string): string {
  if (!/linkedin\.com\/company\//i.test(r.link || '')) return '';
  const site = /\bwebsite:\s*(\S+)/i.exec(r.snippet || '')?.[1] ?? '';
  if (!site || rootDomain(site.replace(/[.,;]+$/, '')) !== domain) return '';
  return String(r.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '').trim();
}

/**
 * What an earlier lookup found, with no search (for jobs that have only the database): true when
 * the company's LinkedIn page was looked up before.
 */
export async function recallFirm(cache: EnrichmentCache | undefined, company: string, website: string | null | undefined): Promise<boolean> {
  registerFirmWebsite(company, website);
  const domain = rootDomain(website);
  if (!domain || !company.trim()) return true;
  try {
    const known = (await cache?.get(`linkedin-page:v1:${domain}`)) as Known | null | undefined;
    if (known?.at && Date.now() - new Date(known.at).getTime() < KEEP_DAYS * DAY_MS) {
      registerFirmAliases(company, known.names ?? []);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Records what is known about the company for matching its people: its website name, and its
 * LinkedIn page's name (looked up once; `cacheOnly` uses only an earlier lookup). Never throws.
 */
export async function learnFirm(svc: Services, company: string, website: string | null | undefined, opts: { cacheOnly?: boolean } = {}): Promise<void> {
  if ((await recallFirm(svc.cache, company, website)) || opts.cacheOnly || !svc.keys.serper) return;
  const domain = rootDomain(website);
  if (!domain || !company.trim()) return;
  const key = `linkedin-page:v1:${domain}`;
  try {
    const results = await googleSearch(svc, `site:linkedin.com/company "${domain}"`);
    // Google's first page that lists the website is the company's own (a joint venture or a
    // reseller may list it too, further down).
    const name = results.map((r) => linkedinPageName(r, domain)).find(Boolean);
    const names = name ? [name] : [];
    registerFirmAliases(company, names);
    await svc.cache?.set(key, { names, at: new Date().toISOString() } satisfies Known).catch(() => {});
  } catch {
    // Not known this time; the legal name and website name still match.
  }
}
