import { eq } from 'drizzle-orm';
import type { Db } from './index';
import { icps, settings } from './schema';

export const DEFAULT_ICPS = [
  {
    segment: 'Manufacturing & 3PL',
    active: true,
    description:
      'Companies holding significant physical inventory or fixed assets across several plants, warehouses or branches, where stock and asset verification is slow, manual and hard to reconcile.',
    industries:
      'Manufacturing (automotive and auto components, engineering, FMCG, pharma, chemicals, electronics, steel, textiles), 3PL and warehousing, distribution, large retail with warehouses',
    companySize: '200+ employees or Rs 100 Cr+ revenue',
    geography: 'India',
    mustHaves:
      'Physical inventory or fixed assets to verify; at least 2 plants, warehouses or branches; ERP or WMS in use is a plus (SAP, Oracle, Microsoft Dynamics, Tally)',
    dealBreakers:
      'No physical inventory (pure software, services, consulting); a single small shop or outlet; companies that sell inventory or audit software themselves',
    targetTitles:
      'Plant Head, Plant Manager, Operations Head, Manufacturing Head, Supply Chain Head, Warehouse Head, Inventory Manager, COO, Business Head, CFO, Finance Controller',
    pitchAngle:
      'Physical stock and asset verification across plants takes weeks, relies on Excel and paper, and never matches the ERP. INVECK makes counts mobile, reconciles them against the ERP and leaves an audit trail.',
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
