import { asc } from 'drizzle-orm';
import type { Db } from './db';
import { knownCompanies } from './db/schema';
import { sameCity } from './branches';
import { domainOf, normCompany } from './pipeline/text';

export type KnownImport = { added: number; skipped: number };

const MAX = 300;
const clean = (s: string | undefined) => String(s ?? '').trim().slice(0, MAX);
const header = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const COMPANY = /^(company|company name|client|client name|customer|customer name|account|account name|organi[sz]ation|name|lead|lead name)$/;
const WEBSITE = /^(website|web site|website url|company website|company website url|domain|company domain|url|site|web)$/;
const LOCATION = /^(company location|location|city|plant|plant location|site|site location|branch|address|place|town)$/;

/**
 * Rows from INVECK's lead list: a header row with a Company column, and Website and Location columns
 * when there are; without recognised headers, the first three columns are read in that order.
 */
export function rowsToKnown(rows: string[][]): { company: string; website: string; location: string }[] {
  if (!rows.length) return [];
  const names = rows[0].map(header);
  const col = (re: RegExp) => names.findIndex((n) => re.test(n));
  const company = col(COMPANY);
  const body = company >= 0 ? rows.slice(1) : rows;
  const [c, w, l] = company >= 0 ? [company, col(WEBSITE), col(LOCATION)] : [0, 1, 2];
  return body
    .map((r) => ({ company: clean(r[c]), website: domainOf(clean(w >= 0 ? r[w] : '')), location: clean(l >= 0 ? r[l] : '') }))
    .filter((k) => k.company);
}

/**
 * Companies from INVECK's own lead lists, each at its location. The same company at the same location
 * (or by the same website, at the same location) is skipped; at another location it is a new entry.
 */
export async function importKnownCompanies(db: Db, rows: string[][]): Promise<KnownImport> {
  const records = rowsToKnown(rows);
  const have = await db.select().from(knownCompanies);
  const same = (a: { company: string; website: string; location: string }, b: { company: string; website: string; location: string }) =>
    (normCompany(a.company) === normCompany(b.company) || (!!a.website && a.website === b.website)) &&
    ((!a.location && !b.location) || sameCity(a.location, b.location));
  const add: { company: string; website: string; location: string }[] = [];
  let skipped = 0;
  for (const r of records) {
    if ([...have, ...add].some((k) => same(k, r))) {
      skipped++;
      continue;
    }
    add.push(r);
  }
  for (let i = 0; i < add.length; i += 500) await db.insert(knownCompanies).values(add.slice(i, i + 500));
  return { added: add.length, skipped };
}

/** The list as branches (company, website and city) for the prospect search and the radar. */
export async function listKnownCompanies(db: Db) {
  const rows = await db.select().from(knownCompanies).orderBy(asc(knownCompanies.id));
  return rows.map((k) => ({ company: k.company, website: k.website, city: k.location }));
}

export function describeKnownImport(r: KnownImport): string {
  const added = `Added ${r.added} ${r.added === 1 ? 'entry' : 'entries'}`;
  return r.skipped ? `${added}; ${r.skipped} already on the list (same company and location).` : `${added}.`;
}
