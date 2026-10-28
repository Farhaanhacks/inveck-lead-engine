import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests } from '@/lib/db';
import { icps, leads } from '@/lib/db/schema';
import { DEFAULT_ICPS } from '@/lib/db/seed';
import { dealCapped, drawPool, isTopContact, runDailyDraw, topAllowance, topUpDraw } from '@/lib/draw';
import { legacyAllocation } from './legacy-allocation';

/** The MD, CEO or owner as the main contact: a last resort, at most 10% of anyone's leads on a day. */

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
});
afterAll(() => vi.useRealTimers());

beforeEach(async () => {
  resetDbForTests();
  process.env.DATABASE_URL = 'memory://';
  process.env.APP_PASSWORD = 'test-secret';
  // Four associates, 12 Manufacturing + 8 3PL & Logistics each (20 a day).
  await legacyAllocation(await getDb());
});

const M = 'Manufacturing';
const P = '3PL & Logistics';
const lead = (company: string, title: string, segment = M) => ({
  company,
  segment,
  status: 'Approved' as const,
  contactName: 'Ravi Shah',
  contactTitle: title,
  researchSummary: `${company} makes things.`,
  qualified: true,
  contactVerifiedAt: new Date(),
});
const nine = new Date('2026-09-28T03:30:00Z'); // Monday 09:00 India time

describe('the 10% cap on the head of the company as the main contact', () => {
  it('is 10% of a day\'s list, rounded down: 2 of 20, 1 of 12, none of 8', () => {
    expect(topAllowance({ [M]: 12, [P]: 8 })).toBe(2);
    expect(topAllowance({ [M]: 12 })).toBe(1);
    expect(topAllowance({ [P]: 8 })).toBe(0);
  });

  it('knows the head of the company from the title, or from a tier set on the lead', () => {
    const list = DEFAULT_ICPS.map((i, n) => ({ ...i, id: n + 1, productId: 1, searchInstructions: '', createdAt: new Date() }));
    expect(isTopContact({ contactTier: '', contactTitle: 'Managing Director', segment: M }, list)).toBe(true);
    expect(isTopContact({ contactTier: '', contactTitle: 'Founder & CEO', segment: P }, list)).toBe(true);
    expect(isTopContact({ contactTier: '', contactTitle: 'Plant Head', segment: M }, list)).toBe(false);
    expect(isTopContact({ contactTier: 'P1', contactTitle: 'Managing Director', segment: M }, list)).toBe(false);
  });

  it('deals nobody more than their share; a lead over the cap goes to someone with room, else stays undealt', () => {
    const items = [
      { item: 'md1', top: true },
      { item: 'md2', top: true },
      { item: 'md3', top: true },
      { item: 'p1', top: false },
      { item: 'p2', top: false },
      { item: 'p3', top: false },
    ];
    const hands = dealCapped(items, new Map([[1, 3], [2, 3]]), new Map([[1, 1], [2, 0]]));
    expect(hands.get(1)!.filter((x) => x.startsWith('md'))).toHaveLength(1);
    expect(hands.get(2)!.filter((x) => x.startsWith('md'))).toHaveLength(0);
    expect([...hands.values()].flat()).toHaveLength(6 - 2);
    // With no head-of-company leads it deals exactly as before: in order, round the team.
    const plain = dealCapped(['a', 'b', 'c', 'd'].map((item) => ({ item, top: false })), new Map([[1, 2], [2, 2]]), new Map(), 1);
    expect([...plain.entries()]).toEqual([[1, ['b', 'd']], [2, ['a', 'c']]]);
  });

  it('the morning draw gives each associate at most 2 of 20 with the MD, CEO or owner as the contact; the rest wait in the pool', async () => {
    const db = await getDb();
    // The oldest leads are MD-only companies: without the cap they would go out first.
    await db.insert(leads).values([
      ...Array.from({ length: 20 }, (_, i) => lead(`MD Co ${i}`, i % 2 ? 'Managing Director' : 'CEO')),
      ...Array.from({ length: 60 }, (_, i) => lead(`Plant Co ${i}`, 'Plant Head')),
      ...Array.from({ length: 40 }, (_, i) => lead(`3PL Co ${i}`, 'Head - Logistics', P)),
    ]);
    const draw = await runDailyDraw(db, { now: nine });
    expect(draw).toMatchObject({ wanted: 80, drawn: 80, short: false });
    const icpList = await db.select().from(icps);
    const given = (await db.select().from(leads)).filter((l) => l.drawnOn === '2026-09-28');
    const owners = [...new Set(given.map((l) => l.ownerId))];
    expect(owners).toHaveLength(4);
    for (const o of owners) {
      const mine = given.filter((l) => l.ownerId === o);
      expect(mine).toHaveLength(20);
      expect(mine.filter((l) => isTopContact(l, icpList)).length).toBeLessThanOrEqual(2);
    }
    expect(given.filter((l) => isTopContact(l, icpList))).toHaveLength(8);
    // The other 12 MD-only leads are still in the pool for another day.
    const left = (await db.select().from(leads).where(eq(leads.status, 'Approved'))).filter((l) => l.ownerId === null && isTopContact(l, icpList));
    expect(left).toHaveLength(12);
    expect((await drawPool(db)).total).toBe(40);
  });

  it('with only MD-led companies in the pool, a list stays short rather than going over the cap, and a top-up keeps to it', async () => {
    const db = await getDb();
    await db.insert(leads).values(Array.from({ length: 30 }, (_, i) => lead(`MD Co ${i}`, 'Managing Director')));
    const draw = await runDailyDraw(db, { now: nine });
    expect(draw?.short).toBe(true);
    const given = () => db.select().from(leads).then((all) => all.filter((l) => l.drawnOn === '2026-09-28'));
    expect(await given()).toHaveLength(8);
    for (const o of new Set((await given()).map((l) => l.ownerId))) expect((await given()).filter((l) => l.ownerId === o)).toHaveLength(2);
    await topUpDraw(db, { now: nine, force: true });
    expect(await given()).toHaveLength(8);
  });
});
