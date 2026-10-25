import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { icps, products, settings } from '@/lib/db/schema';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { DEFAULT_ICPS, LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { contactPriority, tierOf, titlePhrase } from '@/lib/tiers';
import { contactSearchPlan, designationQuery } from '@/lib/pipeline/contacts';
import { searchTitles } from '@/lib/sourcing/people-first';
import { morningPlan } from '@/lib/sourcing/morning';

/** INVECK's P1-only ICPs (25 Oct 2026): their P1 designations, no P2 or P3. */

const MFG_P1 =
  'Plant Head, Plant Manager, Head of Manufacturing, Head of Operations, Head of Supply Chain, Supply Chain Manager, General Manager – Operations, General Manager – Supply Chain, Head of Warehouse & Logistics, Director of Operations, Chief Operating Officer (COO), Head of Procurement & Supply Chain';
const LOG_P1 =
  'National Head – Operations, Regional Head – Operations, Head of Operations, Head of Logistics, Head of Supply Chain, National Operations Manager, Regional Operations Manager, General Manager – Operations, General Manager – Logistics, Chief Operating Officer (COO), Head of Warehouse Operations, Warehouse Manager, Head of Procurement & Supply Chain';
const mfg = { ...DEFAULT_ICPS[0], targetTitles: MFG_P1, p2Titles: '', p3Titles: '' };
const log = { ...DEFAULT_ICPS[1], targetTitles: LOG_P1, p2Titles: '', p3Titles: '' };
const ca = DEFAULT_ICPS[2];

describe('P1 only', () => {
  it('their designations, however LinkedIn writes them, are P1', () => {
    for (const t of [
      'Plant Head',
      'Plant Manager',
      'Head - Manufacturing',
      'Operations Head',
      'Supply Chain Manager',
      'GM - Operations',
      'General Manager Supply Chain',
      'Head - Warehouse and Logistics',
      'Director of Operations',
      'Chief Operating Officer',
      'COO',
      'Head of Procurement and Supply Chain',
    ])
      expect([t, tierOf(t, mfg)]).toEqual([t, 'P1']);
    for (const t of ['National Head - Operations', 'Regional Operations Manager', 'General Manager - Logistics', 'Warehouse Manager', 'Head Warehouse Operations', 'Head of Logistics'])
      expect([t, tierOf(t, log)]).toEqual([t, 'P1']);
  });

  it('nobody at P2 or P3 level: managers and leads not on the list are not contacts', () => {
    for (const t of ['Logistics Manager', 'Store Manager', 'Inventory Manager', 'Production Supervisor', 'Materials Manager']) {
      expect([t, tierOf(t, mfg)]).toEqual([t, '']);
      expect(contactPriority(t, mfg)).toBe(99);
    }
    expect(tierOf('Logistics Manager', log)).toBe('');
    // An ICP that still has P2 and P3 titles places them as before.
    expect(tierOf('Inventory Manager', DEFAULT_ICPS[0])).toBe('P2');
  });

  it('a director is a contact only as a director designation on the P1 list; CA firms keep their rules', () => {
    expect(tierOf('Director', mfg)).toBe('Avoid');
    expect(tierOf('Director - Finance', mfg)).toBe('Avoid');
    expect(tierOf('Director of Operations', mfg)).toBe('P1');
    // However it is written: "Operations Director", "Director - Operations", "Director, Operations".
    for (const t of ['Operations Director', 'Director - Operations', 'Director Operations', 'Director, Operations', 'Director – Operations']) expect([t, tierOf(t, mfg)]).toEqual([t, 'P1']);
    expect(tierOf('Director of Operations', DEFAULT_ICPS[0])).toBe('Avoid');
    expect(tierOf('Director - Risk Advisory', ca)).toBe('Avoid');
  });

  it('the COO on the P1 list is a P1 contact, not the last resort; the MD and CEO still are', () => {
    expect(contactPriority('Chief Operating Officer', mfg)).toBeLessThan(50);
    expect(contactPriority('COO', log)).toBeLessThan(50);
    expect(contactPriority('Managing Director', mfg)).toBe(50);
    expect(contactPriority('CEO', mfg)).toBe(50);
    // Hands-on heads still come first.
    expect(contactPriority('Plant Head', mfg)).toBeLessThan(contactPriority('Chief Operating Officer', mfg));
  });

  it('searches: only P1 designations, and "(COO)" is searched as the title people write', () => {
    expect(titlePhrase('Chief Operating Officer (COO)')).toBe('Chief Operating Officer');
    expect(designationQuery('Acme Forgings', 'Chief Operating Officer (COO)', 'Pune')).toBe('site:linkedin.com/in "Acme Forgings" "Chief Operating Officer" Pune');
    const plan = contactSearchPlan('Acme Forgings', 'Pune', mfg);
    expect(plan.every((s) => s.tier === 'P1')).toBe(true);
    expect(plan.map((s) => s.designation)).toEqual(expect.arrayContaining(['Director of Operations', 'Chief Operating Officer (COO)', 'Supply Chain Manager']));
    const titles = searchTitles(mfg);
    expect(titles.every((t) => tierOf(t, mfg) === 'P1')).toBe(true);
    const queries = morningPlan(MANUFACTURING, mfg, 1).map((q) => q.q);
    expect(queries.some((q) => q.includes('"Chief Operating Officer" '))).toBe(true);
    expect(queries.some((q) => q.includes('(COO)'))).toBe(false);
  });
});

describe('set once on the live database', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  it('the two ICPs get their P1 lists and no P2 or P3; CA firms are untouched; the configuration version goes up once', async () => {
    const step = SCHEMA_STATEMENTS.filter((s) => s.includes('icpP1OnlyV1'));
    expect(step).toHaveLength(4);
    const version = async () => (await db.select({ v: products.configVersion }).from(products))[0]?.v ?? 0;
    const before = await version();
    const caBefore = (await db.select().from(icps).where(eq(icps.segment, 'CA Firms')))[0];
    // A new database's first start has no team yet; the live one has.
    await db.delete(settings).where(eq(settings.key, 'icpP1OnlyV1'));
    for (let i = 0; i < 2; i++) for (const s of step) await db.execute(sql.raw(s));
    const [m] = await db.select().from(icps).where(eq(icps.segment, MANUFACTURING));
    const [l] = await db.select().from(icps).where(eq(icps.segment, LOGISTICS));
    expect(m).toMatchObject({ targetTitles: MFG_P1, p2Titles: '', p3Titles: '' });
    expect(l).toMatchObject({ targetTitles: LOG_P1, p2Titles: '', p3Titles: '' });
    expect((await db.select().from(icps).where(eq(icps.segment, 'CA Firms')))[0]).toEqual(caBefore);
    expect(await version()).toBe(before + 1);
  });
});
