import { and, eq } from 'drizzle-orm';
import type { Db } from './index';
import { icps, leads, settings } from './schema';

export const MANUFACTURING = 'Manufacturing';
export const LOGISTICS = '3PL & Logistics';

/** INVECK's 3PL ICP: 3PL and warehousing first, then supply chain management and e-commerce logistics. */
export const LOGISTICS_ICP = {
  description:
    '3PL and warehousing companies (highest priority), supply chain management and e-commerce logistics providers that run warehouses or manage stock for B2B and enterprise clients across several locations.',
  industries: 'Third-party logistics (3PL), warehousing, supply chain management, e-commerce logistics and fulfilment, cold chain, distribution',
  companySize: '100+ employees',
  mustHaves:
    'Runs warehouses, distribution or fulfilment centres, or manages stock on behalf of clients; Operates from multiple locations or cities; Serves B2B or enterprise clients',
  targetTitles: 'National Head, Regional Head, Head - Supply Chain, Head - Logistics, CFO, Head of Finance, Finance Controller',
  p2Titles: 'Warehouse Head, Warehouse Manager, Supply Chain Manager, Logistics Head, Logistics Manager',
  p3Titles: 'Store Head, Store Manager, Logistics Manager',
};

/** The industries INVECK's team targets in manufacturing, from their list: the core, then strong adjacent sectors. */
export const MANUFACTURING_INDUSTRIES = [
  'Bearing manufacturers',
  'Automotive components, auto components, automotive',
  'Forging and forgers',
  'Foundries',
  'Engineering, heavy engineering, heavy industries',
  'Industrial machinery, machinery manufacturers, machine tools, industrial equipment',
  'Mechanical engineering, precision engineering',
  'Manufacturing, industrial manufacturing (heavy engineering only)',
  'Strong adjacent sectors: defence manufacturing, aerospace components',
].join('; ');

/** Heavy manufacturing only (INVECK's instruction): process and consumer industries are out. */
export const MANUFACTURING_ICP = {
  description:
    'Heavy manufacturing companies (engineering, metal and machinery makers) holding significant physical inventory (raw material, WIP, finished goods, spares) or fixed assets across plants and warehouses, where stock and asset verification is slow, manual and hard to reconcile.',
  industries: MANUFACTURING_INDUSTRIES,
  mustHaves:
    'A heavy manufacturing company in one of the listed industries (bearings, auto components, forgings, castings, heavy engineering, machinery, machine tools, industrial equipment, precision engineering, defence or aerospace components) that holds physical inventory or fixed assets to verify; ERP or WMS in use is a plus (SAP, Oracle, Microsoft Dynamics, Tally)',
  dealBreakers:
    "The company's own products are pharmaceuticals, life sciences, food and beverages, FMCG or consumer goods, chemicals, paints, plastics or packaging, textiles or apparel, cosmetics, agro products or paper (judged by what the company itself makes, not by the industries it sells to: a maker of machinery, equipment or components for these industries, such as dairy, food processing or pharma machinery, is heavy manufacturing and this does not apply); no physical inventory (pure software, services, consulting, trading on paper); a single small shop; companies that sell inventory or audit software themselves",
};

export const DEFAULT_ICPS = [
  {
    segment: MANUFACTURING,
    active: true,
    description: MANUFACTURING_ICP.description,
    industries: MANUFACTURING_ICP.industries,
    companySize: '200+ employees or Rs 100 Cr+ revenue',
    geography: 'India',
    mustHaves: MANUFACTURING_ICP.mustHaves,
    dealBreakers: MANUFACTURING_ICP.dealBreakers,
    targetTitles: 'Plant Head, Head of Supply Chain, VP Supply Chain, Supply Chain Head, Operations Head, Manufacturing Head, VP Operations, AVP Operations',
    p2Titles: 'Inventory Manager, Warehouse Head, Procurement Head, Procurement Manager, Supply Chain Manager, General Manager, DGM, Senior Manager Inventory',
    p3Titles: 'Store Head, Store Manager, Logistics Manager',
    avoidTitles: 'HR, Human Resources, Admin, Administration, Quality Assurance, QA, Quality',
    pitchAngle:
      'Physical stock and asset verification across plants takes weeks, relies on Excel and paper, and never matches the ERP. INVECK makes counts mobile, reconciles them against the ERP and leaves an audit trail.',
  },
  {
    segment: LOGISTICS,
    active: true,
    description: LOGISTICS_ICP.description,
    industries: LOGISTICS_ICP.industries,
    companySize: LOGISTICS_ICP.companySize,
    geography: 'India',
    mustHaves: LOGISTICS_ICP.mustHaves,
    dealBreakers: 'Pure freight brokers or transporters with no warehousing; software-only logistics platforms; manufacturers, traders and retailers (they belong to their own ICP, not 3PL)',
    targetTitles: LOGISTICS_ICP.targetTitles,
    p2Titles: LOGISTICS_ICP.p2Titles,
    p3Titles: LOGISTICS_ICP.p3Titles,
    avoidTitles: 'HR, Human Resources, Admin, Administration, Quality Assurance, QA, Quality',
    pitchAngle:
      'Cycle counts and client stock reconciliations across warehouses eat days and still leave disputes. INVECK makes warehouse counts mobile, reconciles them against the WMS or client records and gives an audit trail clients trust.',
  },
  {
    segment: 'CA Firms',
    active: true,
    description:
      'Chartered accountant firms whose audit teams do physical verification of inventory and fixed assets for clients (statutory, internal, stock and bank stock audits).',
    industries: 'Chartered accountancy and audit firms; internal audit and risk advisory practices',
    companySize: '3+ partners or 25+ audit staff',
    geography: 'India',
    mustHaves: 'Runs statutory, internal, stock or bank stock audits that include physical verification of inventory or fixed assets',
    dealBreakers: 'Sole practitioners doing only tax filing or GST returns; firms with no audit practice',
    targetTitles: 'Managing Partner, Senior Partner, Audit Partner, Head of Assurance, Internal Audit Partner, Director - Risk Advisory',
    p2Titles: 'Partner, Director, Audit Manager',
    p3Titles: 'Senior Audit Associate',
    avoidTitles: 'HR, Admin',
    pitchAngle:
      'Audit teams still verify stock and assets with registers and Excel, then reconcile by hand. INVECK gives them a mobile verification, reconciliation and reporting workflow with a full audit trail, which is faster to deliver and easier to defend.',
  },
];

/** Adds the starter ICPs once, on a brand-new database. */
export async function seedIfEmpty(db: Db) {
  const seeded = await db.select().from(settings).where(eq(settings.key, 'seeded'));
  if (seeded.length) return;
  const existing = await db.select({ id: icps.id }).from(icps).limit(1);
  if (!existing.length) await db.insert(icps).values(DEFAULT_ICPS);
  await db.insert(settings).values({ key: 'seeded', value: true }).onConflictDoNothing();
}

/**
 * One-time: replaces the old combined "Manufacturing & 3PL" ICP with the two the team uses, with
 * P1/P2/P3 titles, and moves its leads to whichever of the two fits their company.
 */
export async function upgradeIcpsV2(db: Db) {
  const done = await db.select().from(settings).where(eq(settings.key, 'icpV2'));
  if (done.length) return;
  const [man, log] = DEFAULT_ICPS;
  const old = await db.select().from(icps).where(eq(icps.segment, 'Manufacturing & 3PL'));
  if (old.length) await db.update(icps).set(man).where(eq(icps.id, old[0].id));
  else if (!(await db.select({ id: icps.id }).from(icps).where(eq(icps.segment, MANUFACTURING))).length) await db.insert(icps).values(man);
  if (!(await db.select({ id: icps.id }).from(icps).where(eq(icps.segment, LOGISTICS))).length) await db.insert(icps).values(log);
  const ca = DEFAULT_ICPS[2];
  await db.update(icps).set({ p2Titles: ca.p2Titles, p3Titles: ca.p3Titles, avoidTitles: ca.avoidTitles }).where(and(eq(icps.segment, 'CA Firms'), eq(icps.p2Titles, '')));
  const moved = await db.select({ id: leads.id, company: leads.company, summary: leads.researchSummary }).from(leads).where(eq(leads.segment, 'Manufacturing & 3PL'));
  for (const l of moved) {
    await db.update(leads).set({ segment: LOGISTICS_HINT.test(`${l.company} ${l.summary.slice(0, 600)}`) ? LOGISTICS : MANUFACTURING }).where(eq(leads.id, l.id));
  }
  await db.insert(settings).values({ key: 'icpV2', value: true }).onConflictDoNothing();
}

/**
 * INVECK's manufacturing focus (engineering, auto components, forgings, castings, machinery and the
 * sectors next to them) on the Manufacturing ICP already in the database: once.
 */
export async function upgradeManufacturingIndustriesV3(db: Db) {
  const key = 'icpManufacturingIndustriesV3';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  await db.update(icps).set({ industries: MANUFACTURING_INDUSTRIES }).where(eq(icps.segment, MANUFACTURING));
  await db.insert(settings).values({ key, value: true }).onConflictDoNothing();
}

/** The Manufacturing ICP narrowed to heavy manufacturing (no pharma, food, FMCG...) in the database, once. */
export async function upgradeManufacturingHeavyV4(db: Db) {
  const key = 'icpManufacturingHeavyV4';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  await db.update(icps).set(MANUFACTURING_ICP).where(eq(icps.segment, MANUFACTURING));
  await db.insert(settings).values({ key, value: true }).onConflictDoNothing();
}

/** The process-industry deal-breaker judged by what a company makes, not whom it sells to (machinery for food plants is heavy manufacturing), once. */
export async function upgradeManufacturingDealBreakersV5(db: Db) {
  const key = 'icpManufacturingDealBreakersV5';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  await db.update(icps).set({ dealBreakers: MANUFACTURING_ICP.dealBreakers }).where(eq(icps.segment, MANUFACTURING));
  await db.insert(settings).values({ key, value: true }).onConflictDoNothing();
}

/** The 3PL ICP set to INVECK's spec (size, locations, B2B clients, P1/P2/P3) in the database, once. */
export async function upgradeLogisticsIcpV2(db: Db) {
  const key = 'icpLogisticsV2';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  await db.update(icps).set(LOGISTICS_ICP).where(eq(icps.segment, LOGISTICS));
  await db.insert(settings).values({ key, value: true }).onConflictDoNothing();
}

/** The MD and CEO aren't P1 (INVECK's instruction): taken off every ICP's P1 list in the database, once. */
export async function removeTopFromP1(db: Db) {
  const key = 'icpNoMdCeoInP1';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  for (const icp of await db.select().from(icps)) {
    const kept = icp.targetTitles
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t && !/^(managing director|md|ceo|chief executive officer)$/i.test(t));
    const next = kept.join(', ');
    if (next !== icp.targetTitles) await db.update(icps).set({ targetTitles: next }).where(eq(icps.id, icp.id));
  }
  await db.insert(settings).values({ key, value: true }).onConflictDoNothing();
}

const LOGISTICS_HINT = /\b(3pl|logistics|warehous\w*|cold chain|freight|express|courier|supply chain solutions|fulfil+ment|distribution)\b/i;
