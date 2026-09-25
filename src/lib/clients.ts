import { inArray } from 'drizzle-orm';
import type { Db } from './db';
import { clients, leads } from './db/schema';
import { domainOf, normCompany, rootDomain } from './pipeline/text';

export const CLIENT_FIELDS = ['company', 'website', 'industry', 'whyBought'] as const;
export type ClientField = (typeof CLIENT_FIELDS)[number];
export type ClientRecord = Record<ClientField, string>;

export const CLIENT_HEADERS: Record<ClientField, string> = {
  company: 'Company',
  website: 'Website',
  industry: 'Industry',
  whyBought: 'Why they bought',
};

// Column names people use for each field (Excel, Airtable, CRM exports).
const HEADER_NAMES: [ClientField, RegExp][] = [
  ['company', /^(company|company name|client|client name|customer|customer name|account|account name|organi[sz]ation|name)$/],
  ['website', /^(website|web site|website url|domain|company domain|url|site|web)$/],
  ['industry', /^(industry|sector|segment|vertical|business type|category)$/],
  ['whyBought', /^(why they bought( inveck)?|why bought|why|reasons?|reason for buying|use case|notes?|comments?|remarks)$/],
];

const MAX_LEN = 1000;
const clean = (s: string | undefined) => String(s ?? '').trim().slice(0, MAX_LEN);

/**
 * Spreadsheet rows → clients. A first row of column names is recognised in any order
 * ("Company Name", "Domain", "Sector"…); otherwise columns are read as
 * Company, Website, Industry, Why they bought (extra columns join the last one).
 */
export function rowsToClients(rows: string[][], { header = true }: { header?: boolean } = {}): ClientRecord[] {
  if (!rows.length) return [];
  const names = rows[0].map((h) => h.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim());
  const columns = new Map<ClientField, number>();
  if (header) {
    names.forEach((n, i) => {
      const field = HEADER_NAMES.find(([, re]) => re.test(n))?.[0];
      if (field && !columns.has(field)) columns.set(field, i);
    });
  }
  const byHeader = columns.has('company');
  const body = byHeader ? rows.slice(1) : rows;
  return body
    .map((r): ClientRecord =>
      byHeader
        ? {
            company: clean(r[columns.get('company')!]),
            website: domainOf(clean(r[columns.get('website') ?? -1])),
            industry: clean(r[columns.get('industry') ?? -1]),
            whyBought: clean(r[columns.get('whyBought') ?? -1]),
          }
        : {
            company: clean(r[0]),
            website: domainOf(clean(r[1])),
            industry: clean(r[2]),
            whyBought: clean(r.slice(3).filter(Boolean).join(', ')),
          },
    )
    .filter((c) => c.company);
}

/**
 * Leads that belong to these clients (won leads keep their Won stage) (same company name or website domain) are marked
 * "Existing Client" so nobody cold-emails a customer. Contacted leads are left alone.
 */
export async function markClientLeads(db: Db, list: { company: string; website: string }[]): Promise<number> {
  const names = new Set(list.map((c) => normCompany(c.company)).filter(Boolean));
  const domains = new Set(list.map((c) => rootDomain(c.website)).filter(Boolean));
  if (!names.size && !domains.size) return 0;
  const all = await db.select({ id: leads.id, company: leads.company, website: leads.website, status: leads.status }).from(leads);
  const clash = all.filter(
    (l) =>
      !['Contacted', 'Existing Client', 'Won'].includes(l.status) &&
      (names.has(normCompany(l.company)) || (l.website && domains.has(rootDomain(l.website)))),
  );
  if (clash.length) await db.update(leads).set({ status: 'Existing Client' }).where(inArray(leads.id, clash.map((l) => l.id)));
  return clash.length;
}

export type ImportResult = { added: number; updated: number; skipped: number; leadsMarked: number };

/**
 * Adds new clients. A client already on the list (same name, ignoring Pvt/Ltd…) is not
 * duplicated, but its empty cells are filled in from the import; filled cells are never overwritten.
 */
export async function importClients(db: Db, records: ClientRecord[]): Promise<ImportResult> {
  const existing = await db.select().from(clients);
  const byName = new Map(existing.map((c) => [normCompany(c.company), c]));
  const seen = new Set<string>();
  const fresh: ClientRecord[] = [];
  const touched: { company: string; website: string }[] = [];
  let updated = 0;
  let skipped = 0;

  for (const r of records) {
    const key = normCompany(r.company);
    if (!key || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const current = byName.get(key);
    if (!current) {
      fresh.push(r);
      continue;
    }
    const fill: Partial<ClientRecord> = {};
    for (const f of ['website', 'industry', 'whyBought'] as const) if (!current[f] && r[f]) fill[f] = r[f];
    if (Object.keys(fill).length) {
      await db.update(clients).set(fill).where(inArray(clients.id, [current.id]));
      updated++;
      touched.push({ company: current.company, website: fill.website || current.website });
    } else skipped++;
  }

  for (let i = 0; i < fresh.length; i += 500) await db.insert(clients).values(fresh.slice(i, i + 500));
  const leadsMarked = await markClientLeads(db, [...fresh, ...touched]);
  return { added: fresh.length, updated, skipped, leadsMarked };
}

/** "Added 12 clients, filled in details for 3, skipped 2 already on the list." */
export function describeImport(r: ImportResult): string {
  const parts: string[] = [];
  if (r.added) parts.push(`Added ${r.added} ${r.added === 1 ? 'client' : 'clients'}`);
  if (r.updated) parts.push(`filled in details for ${r.updated}`);
  if (r.skipped) parts.push(`skipped ${r.skipped} already on the list`);
  if (r.leadsMarked) parts.push(`marked ${r.leadsMarked} ${r.leadsMarked === 1 ? 'lead' : 'leads'} as Existing Client`);
  if (!parts.length) return 'Nothing new to add.';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}
