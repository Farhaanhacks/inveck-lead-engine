import { asc } from 'drizzle-orm';
import type { Db } from './db';
import { knownCompanies } from './db/schema';
import { rowsToClients } from './clients';
import { normCompany, rootDomain } from './pipeline/text';

export type KnownImport = { added: number; skipped: number };

/**
 * Companies from INVECK's own lead lists (CSV rows: a Company column, and a Website column when there
 * is one). Already on the list (same name or website): skipped.
 */
export async function importKnownCompanies(db: Db, rows: string[][]): Promise<KnownImport> {
  const records = rowsToClients(rows);
  const existing = await db.select().from(knownCompanies);
  const names = new Set(existing.map((k) => normCompany(k.company)).filter(Boolean));
  const domains = new Set(existing.map((k) => rootDomain(k.website)).filter(Boolean));
  const add: { company: string; website: string }[] = [];
  let skipped = 0;
  for (const r of records) {
    const name = normCompany(r.company);
    const domain = rootDomain(r.website);
    if (!name || names.has(name) || (domain && domains.has(domain))) {
      skipped++;
      continue;
    }
    names.add(name);
    if (domain) domains.add(domain);
    add.push({ company: r.company.slice(0, 300), website: r.website.slice(0, 300) });
  }
  for (let i = 0; i < add.length; i += 500) await db.insert(knownCompanies).values(add.slice(i, i + 500));
  return { added: add.length, skipped };
}

export async function listKnownCompanies(db: Db) {
  return db.select({ company: knownCompanies.company, website: knownCompanies.website }).from(knownCompanies).orderBy(asc(knownCompanies.id));
}

export function describeKnownImport(r: KnownImport): string {
  const added = `Added ${r.added} ${r.added === 1 ? 'company' : 'companies'}`;
  return r.skipped ? `${added}; ${r.skipped} already on the list or without a company name.` : `${added}.`;
}
