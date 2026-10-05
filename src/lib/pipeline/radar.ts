import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { clients, icps, knownCompanies, leads, opportunities, settings, type Icp } from '../db/schema';
import { logActivity } from '../activity';
import { askJson } from './ai';
import { RADAR_PROMPT } from './prompts';
import type { NewsResult, Services } from './services';
import { mapLimit, newsSearch } from './services';
import { asList, asText } from './text';
import { KnownBranches } from '../branches';
import { canonicalSegment } from '../icp-match';

const KINDS = ['new_plant', 'new_warehouse', 'expansion'];
const SCAN_EVERY_MS = 12 * 60 * 60 * 1000;

export const RADAR_LABELS: Record<string, string> = { new_plant: 'New plant', new_warehouse: 'New warehouse', expansion: 'Expansion' };

/** News searches for facility openings, plus a few from the ICPs' industries. */
export function radarQueries(icpList: Icp[]): string[] {
  const base = [
    'inaugurates new manufacturing plant India',
    'foundation stone new plant India',
    'commences commercial production new plant India',
    'new warehouse OR distribution centre OR fulfilment centre opened India',
    'new cold storage facility India opens',
  ];
  const industries = icpList
    .flatMap((i) => i.industries.split(/[,;\n]/))
    .map((s) => s.replace(/\(.*?\)/g, '').trim())
    .filter((s) => s.length > 2 && s.length < 40)
    .slice(0, 3)
    .map((ind) => `${ind} new plant India`);
  return [...base, ...industries];
}

const schema = {
  type: 'object',
  properties: {
    openings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          company: { type: 'string' },
          headline: { type: 'string' },
          location: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          segment: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['id', 'company', 'headline', 'location', 'kind', 'segment', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['openings'],
  additionalProperties: false,
};

async function lastScan(db: Db): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'radarScannedAt'));
  return typeof row?.value === 'number' ? row.value : 0;
}

async function markScanned(db: Db) {
  await db
    .insert(settings)
    .values({ key: 'radarScannedAt', value: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value: Date.now() } });
}

/**
 * Scans the past month's news for new plants and warehouses and saves each real, new one as
 * an opportunity. Companies already on the lead list or the client sheet are skipped, and the
 * AI answers with item numbers, so every opportunity links to a real article.
 */
export async function scanRadar(
  db: Db,
  svc: Services,
  log: (m: string, level?: 'info' | 'warn' | 'error') => Promise<void> = async () => {},
  { force = false } = {},
): Promise<{ added: number; error: string }> {
  if (!force && Date.now() - (await lastScan(db)) < SCAN_EVERY_MS) return { added: 0, error: '' };
  const icpList = await db.select().from(icps).where(eq(icps.active, true));
  if (!icpList.length) return { added: 0, error: 'No active ICP' };

  const queries = radarQueries(icpList);
  const pages = await mapLimit(queries, 4, (q) => newsSearch(svc, q, 'qdr:m').catch((): NewsResult[] => []));
  const seenUrls = new Set<string>();
  const items = pages.flat().filter((n) => n.link && n.title && !seenUrls.has(n.link) && seenUrls.add(n.link)).slice(0, 40);
  await markScanned(db);
  if (!items.length) return { added: 0, error: '' };

  const segments = icpList.map((i) => i.segment);
  const list = items.map((n, i) => `${i + 1}. ${n.title} (${n.source || 'news'}, ${n.date || 'recent'})\n   ${n.snippet || ''}`).join('\n');
  const result = await askJson(svc, RADAR_PROMPT, `ICP segments: ${segments.join(', ')}\n\n## News\n${list}`, schema);
  if (result.error !== undefined) return { added: 0, error: result.error };

  // Skip what we already know: clients, companies already a lead (one company is one lead, whatever
  // the city) and earlier openings.
  const [leadRows, clientRows, ownLeads, earlier] = await Promise.all([
    db.select({ company: leads.company, website: leads.website, city: leads.city }).from(leads),
    db.select({ company: clients.company, website: clients.website }).from(clients),
    // Companies in INVECK's own lead lists.
    db.select({ company: knownCompanies.company, website: knownCompanies.website, city: knownCompanies.location }).from(knownCompanies),
    db.select({ company: opportunities.company, location: opportunities.location, url: opportunities.url }).from(opportunities).orderBy(desc(opportunities.id)).limit(2000),
  ]);
  const known = new KnownBranches([...leadRows, ...ownLeads, ...earlier.map((e) => ({ company: e.company, website: '', city: e.location }))], clientRows);
  const knownUrls = new Set(earlier.map((e) => e.url));

  const rows: (typeof opportunities.$inferInsert)[] = [];
  for (const raw of asList(result.data.openings)) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const item = items[Number(asText(o.id).replace(/\D/g, '')) - 1];
    const company = asText(o.company).replace(/\b(pvt|private|ltd|limited)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
    const location = asText(o.location).slice(0, 80);
    if (!item || !company || known.has(company, '', location) || knownUrls.has(item.link!)) continue;
    // The company must actually appear in the article's title or snippet.
    if (!`${item.title} ${item.snippet}`.toLowerCase().includes(company.toLowerCase().split(' ')[0])) continue;
    known.add(company, '', location);
    const segment = asText(o.segment);
    rows.push({
      company,
      headline: (asText(o.headline) || item.title!).slice(0, 160),
      location,
      kind: KINDS.includes(asText(o.kind)) ? asText(o.kind) : 'new_plant',
      // As given when no ICP has that name: research then flags it instead of using another ICP.
      segment: canonicalSegment(segment, segments),
      why: asText(o.why).slice(0, 300),
      url: item.link!,
      source: item.source || '',
      date: item.date || '',
    });
  }
  if (rows.length) await db.insert(opportunities).values(rows);
  if (rows.length) await log(`New facility radar: ${rows.length} new opening${rows.length === 1 ? '' : 's'} (${rows.map((r) => r.company).join(', ')})`);
  return { added: rows.length, error: '' };
}

/** Turns an opportunity into a lead to research, with the article as its buying signal. */
export async function addOpportunityAsLead(db: Db, id: number): Promise<number | null> {
  const [o] = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (!o || o.status !== 'new') return null;
  const signal = { headline: o.headline, date: o.date, url: o.url, source: o.source, kind: o.kind === 'expansion' ? 'expansion' : 'new_facility' };
  const [lead] = await db
    .insert(leads)
    .values({
      company: o.company,
      city: o.location.split(',')[0].trim(),
      segment: o.segment,
      source: `New facility in the news: ${o.headline}`,
      signals: [signal],
      signalsCheckedAt: new Date(),
    })
    .returning({ id: leads.id });
  await db.update(opportunities).set({ status: 'added', leadId: lead.id }).where(eq(opportunities.id, id));
  await logActivity(db, lead.id, 'added', `Added from the new facility radar: ${o.headline}${o.source ? ` (${o.source})` : ''}`);
  await logActivity(db, lead.id, 'signal', `${o.headline}${o.source ? ` (${o.source}${o.date ? `, ${o.date}` : ''})` : ''}`);
  return lead.id;
}
