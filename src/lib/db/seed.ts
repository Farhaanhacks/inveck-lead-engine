import { and, eq } from 'drizzle-orm';
import type { Db } from './index';
import { icps, leads, settings } from './schema';

export const MANUFACTURING = 'Manufacturing';
export const LOGISTICS = '3PL & Logistics';

/** The industries INVECK's team targets, from their list. */
export const MANUFACTURING_INDUSTRIES = [
  'Automotive and auto components (automobile, motor vehicle, transportation equipment)',
  'Engineering and heavy machinery, industrial manufacturing, forging',
  'Steel and metal, wire and cables',
  'Electrical and electronics',
  'Chemicals, paints and coatings, oil and gas / petrochemicals',
  'Pharmaceuticals and medical devices',
  'FMCG / consumer goods, personal care, food processing',
  'Textiles and garments',
  'Plastics and polymers, rubber',
  'Paper, pulp and packaging',
  'Cement and construction materials, glass and ceramics',
  'Furniture and wood products',
  'Aerospace, renewable energy equipment',
].join('; ');

export const DEFAULT_ICPS = [
  {
    segment: MANUFACTURING,
    active: true,
    description:
      'Manufacturers holding significant physical inventory (raw material, WIP, finished goods, spares) or fixed assets across plants and warehouses, where stock and asset verification is slow, manual and hard to reconcile.',
    industries: MANUFACTURING_INDUSTRIES,
    companySize: '200+ employees or Rs 100 Cr+ revenue',
    geography: 'India',
    mustHaves:
      'Manufactures physical goods, or holds significant physical inventory or fixed assets to verify; ERP or WMS in use is a plus (SAP, Oracle, Microsoft Dynamics, Tally)',
    dealBreakers:
      'No physical inventory (pure software, services, consulting, trading on paper); a single small shop; companies that sell inventory or audit software themselves',
    targetTitles: 'Plant Head, Head of Supply Chain, VP Supply Chain, Supply Chain Head, Operations Head, Manufacturing Head, VP Operations, AVP Operations, Managing Director',
    p2Titles: 'Inventory Manager, Warehouse Head, Procurement Head, Procurement Manager, Supply Chain Manager, General Manager, DGM, Senior Manager Inventory',
    p3Titles: 'Store Head, Store Manager, Logistics Manager',
    avoidTitles: 'HR, Human Resources, Admin, Administration, Quality Assurance, QA, Quality',
    pitchAngle:
      'Physical stock and asset verification across plants takes weeks, relies on Excel and paper, and never matches the ERP. INVECK makes counts mobile, reconciles them against the ERP and leaves an audit trail.',
  },
  {
    segment: LOGISTICS,
    active: true,
    description:
      '3PL, warehousing, logistics and distribution companies (and retailers with their own warehouses and DCs) that hold or manage stock for themselves or their clients across several sites.',
    industries: 'Third-party logistics (3PL), warehousing, cold chain, freight and express logistics, distribution, retail and e-commerce fulfilment',
    companySize: '100+ employees or 3+ warehouses',
    geography: 'India',
    mustHaves: 'Runs warehouses, distribution or fulfilment centres, or manages stock on behalf of clients',
    dealBreakers: 'Pure freight brokers or transporters with no warehousing; software-only logistics platforms',
    targetTitles: 'National Head, Regional Head, Head of Supply Chain, Head of Logistics, COO, CFO, Head of Finance, Finance Controller',
    p2Titles: 'Warehouse Head, Warehouse Manager, Supply Chain Manager, Logistics Head, Logistics Manager, General Manager, DGM',
    p3Titles: 'Store Head, Store Manager, Logistics Manager',
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

const LOGISTICS_HINT = /\b(3pl|logistics|warehous\w*|cold chain|freight|express|courier|supply chain solutions|fulfil+ment|distribution)\b/i;
