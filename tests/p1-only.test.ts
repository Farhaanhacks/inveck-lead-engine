import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { icps, leads, people, products, settings } from '@/lib/db/schema';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { DEFAULT_ICPS, LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { contactPriority, icpFor, tierOf, titlePhrase } from '@/lib/tiers';
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
// 26 Oct 2026: Finance Head and Finance Controller added to Manufacturing; Store Incharge never a contact.
const MFG_P1_26 =
  'Plant Head, Plant Manager, Head of Manufacturing, Head of Operations, Head of Supply Chain, Supply Chain Manager, General Manager – Operations, General Manager – Supply Chain, Head of Warehouse & Logistics, Director of Operations, Chief Operating Officer (COO), Finance Head, Finance Controller, Head of Procurement & Supply Chain';
const mfg26 = { ...mfg, targetTitles: MFG_P1_26, avoidTitles: `${mfg.avoidTitles}, Store Incharge` };
const log26 = { ...log, avoidTitles: `${log.avoidTitles}, Store Incharge` };
// 29 Oct 2026: INVECK's new 3PL & Logistics P1 list, for new leads ("VP – Operations / Logistics" as two designations).
const LOG_P1_29 = 'National Head – Operations, Regional Head – Warehouse Operations, Head – Supply Chain, VP – Operations, VP – Logistics, Logistics Head, Head – Contract Logistics';
const log29 = { ...log26, targetTitles: LOG_P1_29 };

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

describe('Finance Head and Finance Controller on the Manufacturing list; a Store Incharge never a contact (26 Oct)', () => {
  it('a Store Incharge, however written, is not a contact, so never the P1 a search stops at', () => {
    for (const icp of [mfg26, log26]) {
      for (const t of ['Store Incharge', 'Stores Incharge', 'Incharge - Stores', 'Store & Dispatch Incharge']) {
        expect([t, tierOf(t, icp)]).toEqual([t, 'Avoid']);
        expect(contactPriority(t, icp)).toBe(99);
      }
      expect(tierOf('Store In-charge', icp)).not.toBe('P1');
      expect(contactPriority('Store In-charge', icp)).toBe(99);
    }
    // Before (the function rule read "store" as supply chain and "incharge" as head level).
    expect(tierOf('Store Incharge', mfg)).toBe('P1');
  });

  it('finance heads and controllers are P1 for Manufacturing (not 3PL), searched after the operations and supply chain heads', () => {
    for (const t of ['Finance Head', 'Finance Controller', 'Head - Finance', 'Head of Finance']) {
      expect([t, tierOf(t, mfg26)]).toEqual([t, 'P1']);
      expect([t, tierOf(t, log26)]).toEqual([t, '']);
    }
    const plan = contactSearchPlan('Acme Forgings', 'Pune', mfg26).map((s) => s.designation);
    expect(plan).toEqual(expect.arrayContaining(['Finance Head', 'Finance Controller', 'Chief Operating Officer (COO)']));
    expect(plan.indexOf('Finance Head')).toBeGreaterThan(plan.indexOf('Plant Head'));
    expect(plan.indexOf('Finance Head')).toBeGreaterThan(plan.indexOf('Head of Operations'));
  });

  it('the COO comes before finance: as the main contact, and in the order designations are searched', () => {
    for (const t of ['Finance Head', 'Finance Controller', 'Head - Finance']) expect(contactPriority('Chief Operating Officer', mfg26)).toBeLessThan(contactPriority(t, mfg26));
    expect(contactPriority('COO', mfg26)).toBeLessThan(contactPriority('Finance Controller', mfg26));
    const plan = contactSearchPlan('Acme Forgings', 'Pune', mfg26).map((s) => s.designation);
    expect(plan.indexOf('Chief Operating Officer (COO)')).toBeLessThan(plan.indexOf('Finance Head'));
    expect(plan.indexOf('Chief Operating Officer (COO)')).toBeLessThan(plan.indexOf('Finance Controller'));
    // Finance is still a P1 contact, ahead of the head of the company.
    expect(contactPriority('Finance Controller', mfg26)).toBeLessThan(contactPriority('Managing Director', mfg26));
  });
});

describe("INVECK's new 3PL P1 list (29 Oct): for new leads", () => {
  it('their designations, however LinkedIn writes them, are P1; managers are not contacts and the COO is the last resort', () => {
    for (const t of [
      'National Head - Operations',
      'Regional Head - Warehouse Operations',
      'Head - Supply Chain',
      'Head of Supply Chain',
      'VP Operations',
      'Vice President - Logistics',
      'Logistics Head',
      'Head of Logistics',
      'Head - Contract Logistics',
      'Contract Logistics Head',
    ])
      expect([t, tierOf(t, log29)]).toEqual([t, 'P1']);
    for (const t of ['Warehouse Manager', 'Regional Operations Manager', 'National Operations Manager', 'Operations Manager']) {
      expect([t, tierOf(t, log29)]).toEqual([t, '']);
      expect(contactPriority(t, log29)).toBe(99);
    }
    expect(contactPriority('Chief Operating Officer', log29)).toBe(50);
  });

  it('searched: only the new designations, VP – Operations and VP – Logistics each on its own', () => {
    expect(searchTitles(log29)).toEqual(LOG_P1_29.split(', '));
    const queries = morningPlan(LOGISTICS, log29, 1).map((q) => q.q);
    expect(queries.some((q) => q.includes('"Warehouse Manager"'))).toBe(false);
    expect(queries.some((q) => q.includes('"VP – Operations"'))).toBe(true);
    const plan = contactSearchPlan('Acme Logistics', 'Pune', log29).map((s) => s.designation);
    expect([...plan].sort()).toEqual(LOG_P1_29.split(', ').sort());
  });

  it('a 3PL lead made before it keeps the contacts it was given; new leads and searches use the new list', () => {
    const before = { segment: LOGISTICS, createdAt: new Date('2026-10-28T10:00:00Z') };
    const after = { segment: LOGISTICS, createdAt: new Date('2026-10-29T15:30:00Z') };
    expect(contactPriority('Warehouse Manager', icpFor(before, [log29]))).toBe(3);
    expect(tierOf('Regional Operations Manager', icpFor(before, [log29]))).toBe('P1');
    expect(contactPriority('Chief Operating Officer', icpFor(before, [log29]))).toBeLessThan(50);
    expect(tierOf('Head - Contract Logistics', icpFor(before, [log29]))).toBe('P1');
    expect(contactPriority('Warehouse Manager', icpFor(after, [log29]))).toBe(99);
    expect(contactPriority('Warehouse Manager', icpFor(LOGISTICS, [log29]))).toBe(99);
    // Manufacturing leads keep their own ICP as it is.
    expect(icpFor({ segment: MANUFACTURING, createdAt: before.createdAt }, [mfg26, log29])).toBe(mfg26);
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

  it('26 Oct: Finance Head and Finance Controller go on the Manufacturing list and Store Incharge on both avoid lists, once; CA firms untouched', async () => {
    const step = SCHEMA_STATEMENTS.filter((s) => s.includes('icpFinanceStoreV1'));
    expect(step).toHaveLength(4);
    const version = async () => (await db.select({ v: products.configVersion }).from(products))[0]?.v ?? 0;
    const caBefore = (await db.select().from(icps).where(eq(icps.segment, 'CA Firms')))[0];
    const [logBefore] = await db.select().from(icps).where(eq(icps.segment, LOGISTICS));
    await db.delete(settings).where(eq(settings.key, 'icpFinanceStoreV1'));
    const before = await version();
    for (let i = 0; i < 2; i++) for (const s of step) await db.execute(sql.raw(s));
    const [m] = await db.select().from(icps).where(eq(icps.segment, MANUFACTURING));
    const [l] = await db.select().from(icps).where(eq(icps.segment, LOGISTICS));
    expect(m.targetTitles).toBe(MFG_P1_26);
    expect(m.avoidTitles.match(/Store Incharge/g)).toHaveLength(1);
    expect(l.avoidTitles.match(/Store Incharge/g)).toHaveLength(1);
    expect(l.targetTitles).toBe(logBefore.targetTitles);
    expect(tierOf('Store Incharge', m)).toBe('Avoid');
    expect(tierOf('Finance Controller', m)).toBe('P1');
    expect((await db.select().from(icps).where(eq(icps.segment, 'CA Firms')))[0]).toEqual(caBefore);
    expect(await version()).toBe(before + 1);
  });

  it("29 Oct: the 3PL P1 list becomes INVECK's new one, once; Manufacturing and CA firms untouched; 3PL leads made before keep their contacts", async () => {
    const step = SCHEMA_STATEMENTS.filter((s) => s.includes('icp3plP1V2'));
    expect(step).toHaveLength(3);
    const version = async () => (await db.select({ v: products.configVersion }).from(products))[0]?.v ?? 0;
    // As on the live database: P1 only since 25 Oct.
    await db.delete(settings).where(eq(settings.key, 'icpP1OnlyV1'));
    for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes('icpP1OnlyV1'))) await db.execute(sql.raw(s));
    const [mfgBefore] = await db.select().from(icps).where(eq(icps.segment, MANUFACTURING));
    const caBefore = (await db.select().from(icps).where(eq(icps.segment, 'CA Firms')))[0];
    const [logBefore] = await db.select().from(icps).where(eq(icps.segment, LOGISTICS));
    await db.delete(settings).where(eq(settings.key, 'icp3plP1V2'));
    const before = await version();
    for (let i = 0; i < 2; i++) for (const s of step) await db.execute(sql.raw(s));
    const [l] = await db.select().from(icps).where(eq(icps.segment, LOGISTICS));
    expect(l).toMatchObject({ targetTitles: LOG_P1_29, p2Titles: logBefore.p2Titles, p3Titles: logBefore.p3Titles, avoidTitles: logBefore.avoidTitles });
    expect((await db.select().from(icps).where(eq(icps.segment, MANUFACTURING)))[0]).toEqual(mfgBefore);
    expect((await db.select().from(icps).where(eq(icps.segment, 'CA Firms')))[0]).toEqual(caBefore);
    expect(await version()).toBe(before + 1);

    // A Warehouse Manager stays the main contact of a 3PL lead made before; on a new lead they aren't a contact.
    const { tidyContacts } = await import('@/lib/verify-contacts');
    const lead = async (company: string, createdAt: Date) => {
      const [row] = await db
        .insert(leads)
        .values({ company, city: 'Pune', segment: LOGISTICS, status: 'Approved', contactName: 'Vikas Rao', contactTitle: 'Warehouse Manager', contactLinkedin: `https://in.linkedin.com/in/vikas-${row0(company)}`, createdAt })
        .returning();
      await db.insert(people).values({ leadId: row.id, name: 'Vikas Rao', title: 'Warehouse Manager', linkedin: `https://in.linkedin.com/in/vikas-${row0(company)}`, location: 'Pune', source: 'LinkedIn', isPrimary: true });
      return row.id;
    };
    const row0 = (s: string) => s.toLowerCase().replace(/\W+/g, '-');
    const old = await lead('Old Freight Lines', new Date('2026-10-28T10:00:00Z'));
    const fresh = await lead('New Freight Lines', new Date('2026-10-29T15:30:00Z'));
    await tidyContacts(db, {});
    const person = async (id: number) => (await db.select().from(people).where(eq(people.leadId, id)))[0];
    expect(await person(old)).toMatchObject({ isPrimary: true, passedReason: '' });
    expect((await db.select().from(leads).where(eq(leads.id, old)))[0].contactName).toBe('Vikas Rao');
    expect(await person(fresh)).toMatchObject({ isPrimary: false, passedReason: 'excluded' });
  });
});
