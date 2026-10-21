import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from './db';
import { leads, type Lead } from './db/schema';
import { logActivity } from './activity';
import { googleSearch, type Services } from './pipeline/services';
import { searchName } from './pipeline/text';
import { caFirmSql, WORKING_STATUSES } from './tasks';

/**
 * CA firms come from the database, so nothing about them is researched. The one thing looked up is the firm's LinkedIn
 * page, for the first step (the sheet has none): a single search for the firm's name, taken only when the page's
 * name carries the firm's own words. Nothing else is filled in: no people, phones or emails are searched for.
 */
const GENERIC = new Set(['and', 'co', 'company', 'chartered', 'accountant', 'accountants', 'associates', 'associate', 'partners', 'partner', 'llp', 'ca', 'firm', 'services', 'consultants', 'consultancy', 'advisors', 'advisory', 'the', 'of', 'cas', 'amp']);

/** The words of the firm's name that tell it apart from any other CA firm. */
export function distinctiveWords(firm: string): string[] {
  return searchName(firm)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !GENERIC.has(w));
}

const slugOf = (link: string) => /linkedin\.com\/company\/([^/?#]+)/i.exec(link)?.[1] ?? '';

/** The firm's LinkedIn company page from search results, or ''. */
export function pickFirmPage(firm: string, city: string, results: { title?: string; link?: string; snippet?: string }[]): string {
  const words = distinctiveWords(firm);
  if (!words.length) return '';
  const town = city.split(',')[0].trim().toLowerCase();
  for (const r of results) {
    const slug = slugOf(r.link ?? '');
    if (!slug) continue;
    const name = `${(r.title ?? '').replace(/\s*[|\-–]\s*LinkedIn.*$/i, '')} ${slug.replace(/-/g, ' ')}`.toLowerCase();
    if (!words.every((w) => name.includes(w))) continue;
    const text = `${r.title ?? ''} ${r.snippet ?? ''}`.toLowerCase();
    // A page for a CA / audit firm (or in the firm's town), not a namesake in another trade.
    if (/chartered|accountan|audit|\bca\b|tax|advisory/.test(text) || (town.length >= 3 && text.includes(town))) return `https://www.linkedin.com/company/${slug}`;
  }
  return '';
}

/**
 * Looks up the LinkedIn page of CA firms from the database that have none yet (each firm once; a firm not found is
 * left blank for the team to paste). Never throws for one firm. Returns how many pages were found.
 */
export async function findCaFirmLinkedin(db: Db, svc: Services, opts: { ownerId?: number; limit?: number; budgetLeft?: () => Promise<number> } = {}): Promise<number> {
  if (!svc.keys.serper) return 0;
  const due: Lead[] = await db
    .select()
    .from(leads)
    .where(and(caFirmSql, inArray(leads.status, [...WORKING_STATUSES]), eq(leads.contactName, ''), eq(leads.contactLinkedin, ''), isNull(leads.contactCheckedAt), opts.ownerId ? eq(leads.ownerId, opts.ownerId) : undefined))
    .orderBy(asc(leads.id))
    .limit(opts.limit ?? 10);
  let found = 0;
  for (const lead of due) {
    // The day's search budget (Settings) is respected: when it runs low, the rest wait for another visit.
    if (opts.budgetLeft && (await opts.budgetLeft()) < 30) break;
    let page = '';
    try {
      page = pickFirmPage(lead.company, lead.city, await googleSearch(svc, `site:linkedin.com/company "${searchName(lead.company)}"${lead.city ? ` ${lead.city.split(',')[0].trim()}` : ''}`));
    } catch {
      continue; // the search didn't answer: tried again next time
    }
    // Looked up once, found or not (contactCheckedAt), so a firm without a page isn't searched again and again.
    await db.update(leads).set({ contactCheckedAt: new Date(), ...(page ? { contactLinkedin: page } : {}), updatedAt: new Date() }).where(eq(leads.id, lead.id));
    if (page) {
      found++;
      await logActivity(db, lead.id, 'contact', `LinkedIn page found for the firm: ${page}`);
    }
  }
  return found;
}
