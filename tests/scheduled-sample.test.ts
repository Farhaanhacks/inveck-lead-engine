import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, settings, sourcingTests, users } from '@/lib/db/schema';
import { settingsSchema, saveSettings } from '@/lib/settings';
import { runSourcingTest } from '@/lib/sourcing/test-run';
import { SCHEDULED_SAMPLES, startScheduledSample, type MorningSampleReport } from '@/lib/sourcing/sample-run';
import { drawShortfall } from '@/lib/sourcing/morning';
import { istDay } from '@/lib/tasks';
import { LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import type { FakeLog } from './fake-apis';
import { morningServices } from './morning-world';
import { legacyAllocation } from './legacy-allocation';

/** INVECK's evening run: a Morning Sample started on its own, its leads added and given out when it finishes. */

let db: Db;
let log: FakeLog;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  await legacyAllocation(db);
  log = { calls: [], verified: [], finder: [], apollo: [] };
  const team = await db.select().from(users).where(eq(users.role, 'bda')).orderBy(users.id);
  await db.update(users).set({ active: false }).where(inArray(users.id, team.filter((u) => !['Puja', 'Parimal'].includes(u.name)).map((u) => u.id)));
  await saveSettings(db, settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1 }));
});

describe('the scheduled evening run', () => {
  const at = new Date(SCHEDULED_SAMPLES[0]);

  it('starts once its time has come (not before, not hours late), once whoever checks', async () => {
    expect(await startScheduledSample(db, new Date(at.getTime() - 60_000))).toBeNull();
    expect(await startScheduledSample(db, new Date(at.getTime() + 4 * 3600_000))).toBeNull();
    const id = await startScheduledSample(db, new Date(at.getTime() + 10 * 60_000));
    expect(id).toBeGreaterThan(0);
    expect(await startScheduledSample(db, new Date(at.getTime() + 20 * 60_000))).toBeNull();
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id!));
    expect(row).toMatchObject({ mode: 'morning', status: 'running', report: { fresh: false, assign: true } });
  });

  it('runs as a sample and, when it finishes, its leads are approved and given out with no button pressed', async () => {
    const id = (await startScheduledSample(db, new Date(at.getTime() + 60_000)))!;
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row.status).toBe('done');
    expect(row.error).toBe('');
    const r = row.report as MorningSampleReport;
    expect(r.autoAssign).toBe(true);
    expect(r.assigned?.given.reduce((a, g) => a + g.leads, 0)).toBe(r.hands.reduce((a, h) => a + h.cards.length, 0));
    const given = await db.select().from(leads).where(eq(leads.drawnOn, r.assigned!.day));
    expect(given.length).toBeGreaterThan(0);
    expect(given.every((l) => l.status === 'Approved' && l.ownerId !== null)).toBe(true);
  });

  it("the next 6 am run counts leads already given out for that morning: it searches only for what's still missing", async () => {
    const [puja] = await db.select().from(users).where(eq(users.name, 'Puja'));
    const before = await drawShortfall(db, settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1 }));
    expect(before[MANUFACTURING].need).toBe(2);
    await db.insert(leads).values({ company: 'Given Co', segment: MANUFACTURING, status: 'Approved', ownerId: puja.id, drawnOn: istDay() });
    const after = await drawShortfall(db, settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1 }));
    expect(after[MANUFACTURING].need).toBe(1);
    expect(after[LOGISTICS].need).toBe(2);
    expect((await db.select().from(settings).where(eq(settings.key, 'nothing'))).length).toBe(0);
  });
});
