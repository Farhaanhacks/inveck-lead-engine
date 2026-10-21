import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { leads, settings, users } from '@/lib/db/schema';
import { LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { runDailyDraw, teamQuotas, topUpDraw } from '@/lib/draw';
import { drawShortfall } from '@/lib/sourcing/morning';
import { settingsSchema } from '@/lib/settings';

/**
 * Each associate's own daily list (INVECK, 20 Oct 2026): Anchal and Puja 40 Manufacturing each (their CA
 * firms come apart, from the sheet), Parimal and Anuradha 40 each in the 12:8 ratio, 24 Manufacturing and 16 3PL.
 */

const M = MANUFACTURING;
const P = LOGISTICS;
const nine = new Date('2026-09-28T03:30:00Z'); // Monday 09:00 India time
let db: Db;

const lead = (company: string, segment: string) => ({
  company, segment, status: 'Approved' as const, contactName: 'Ravi Shah', contactTitle: 'Plant Head', qualified: true, contactVerifiedAt: new Date(),
});
const many = (n: number, segment: string, tag = segment) => Array.from({ length: n }, (_, i) => lead(`${tag} ${i}`, segment));

/** The once-only statements that set the four lists, run again as on a deploy. */
async function setListsOnce() {
  for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes('drawQuotasV1'))) await db.execute(sql.raw(s));
}

async function byName() {
  const rows = await db.select().from(users).where(eq(users.role, 'bda'));
  return Object.fromEntries(rows.map((u) => [u.name, u]));
}

beforeEach(async () => {
  resetDbForTests();
  process.env.DATABASE_URL = 'memory://';
  db = await getDb();
  // As on the live database: the team existed before the lists were set.
  await db.delete(settings).where(eq(settings.key, 'drawQuotasV1'));
  await setListsOnce();
});

describe("each associate's own daily list", () => {
  it('sets the four lists once, and never again over a change made since', async () => {
    const u = await byName();
    expect([u.Anchal, u.Puja].map((x) => [x.drawManufacturing, x.drawLogistics])).toEqual([[40, 0], [40, 0]]);
    expect([u.Parimal, u.Anuradha].map((x) => [x.drawManufacturing, x.drawLogistics])).toEqual([[24, 16], [24, 16]]);
    // Changed on the Team page: the next start leaves it.
    await db.update(users).set({ drawManufacturing: 30 }).where(eq(users.id, u.Puja.id));
    await setListsOnce();
    expect((await byName()).Puja.drawManufacturing).toBe(30);
  });

  it('a new associate without their own list gets the Settings numbers', async () => {
    await db.insert(users).values({ username: 'neha@inveck', name: 'Neha', role: 'bda', passwordHash: 'x' });
    const quotas = await teamQuotas(db, settingsSchema.parse({ manufacturingPerAssociate: 12, logisticsPerAssociate: 8 }));
    const neha = (await byName()).Neha;
    expect(quotas.get(neha.id)).toEqual({ [M]: 12, [P]: 8 });
    expect(quotas.get((await byName()).Puja.id)).toEqual({ [M]: 40, [P]: 0 });
  });

  it('the draw gives Anchal and Puja 40 Manufacturing, Parimal and Anuradha 24 + 16', async () => {
    await db.insert(leads).values([...many(200, M), ...many(60, P), ...many(30, 'CA Firms')]);
    const drawn = await runDailyDraw(db, { now: nine });
    expect(drawn).toMatchObject({ wanted: 160, drawn: 160, short: false });
    const u = await byName();
    const hand = (name: string) => drawn!.perOwnerSegment![String(u[name].id)];
    expect(hand('Anchal')).toEqual({ [M]: 40, [P]: 0 });
    expect(hand('Puja')).toEqual({ [M]: 40, [P]: 0 });
    expect(hand('Parimal')).toEqual({ [M]: 24, [P]: 16 });
    expect(hand('Anuradha')).toEqual({ [M]: 24, [P]: 16 });
    // CA firms are never part of it.
    expect((await db.select().from(leads)).filter((l) => l.segment === 'CA Firms').every((l) => l.ownerId === null)).toBe(true);
  });

  it('short of leads: nobody gets more than their list, Anchal and Puja never 3PL, and a top-up fills the rest', async () => {
    await db.insert(leads).values([...many(100, M), ...many(10, P)]);
    const first = await runDailyDraw(db, { now: nine });
    expect(first).toMatchObject({ wanted: 160, drawn: 110, short: true });
    const u = await byName();
    const hand = (r: typeof first, name: string) => r!.perOwnerSegment![String(u[name].id)];
    for (const name of ['Anchal', 'Puja']) expect(hand(first, name)[P]).toBe(0);
    for (const name of ['Anchal', 'Puja']) expect(hand(first, name)[M]).toBeLessThanOrEqual(40);
    for (const name of ['Parimal', 'Anuradha']) expect(hand(first, name)[M]).toBeLessThanOrEqual(24);
    expect(hand(first, 'Parimal')[P] + hand(first, 'Anuradha')[P]).toBe(10);

    await db.insert(leads).values([...many(100, M, 'More M'), ...many(40, P, 'More P')]);
    const topped = await topUpDraw(db, { now: nine });
    expect(topped).toMatchObject({ wanted: 160, drawn: 160, short: false });
    expect(hand(topped, 'Puja')).toEqual({ [M]: 40, [P]: 0 });
    expect(hand(topped, 'Parimal')).toEqual({ [M]: 24, [P]: 16 });
  });

  it("the 6 am search aims for the team's real total: 128 Manufacturing and 32 3PL", async () => {
    const short = await drawShortfall(db, settingsSchema.parse({}));
    expect(short[M].need).toBe(128);
    expect(short[P].need).toBe(32);
  });
});
