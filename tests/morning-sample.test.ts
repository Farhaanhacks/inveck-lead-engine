import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, icps, leads, people, prospectSearches, settings, sourcingTests, tasks, users } from '@/lib/db/schema';
import { LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { settingsSchema, saveSettings } from '@/lib/settings';
import { runSourcingTest } from '@/lib/sourcing/test-run';
import { cardLead, isMorningSample, sampleMorning, type MorningSampleReport, type MorningSampleStart } from '@/lib/sourcing/sample-run';
import { MorningSample } from '@/app/(app)/sourcing/morning-sample';
import type { FakeLog } from './fake-apis';
import { morningServices } from './morning-world';
import { dbSearchMeter, searchesUsed } from '@/lib/search-budget';

/**
 * The Morning Sample Run: tomorrow's 6 am run and 8 am draw on paper. The made-up Google (see
 * morning-world.ts) has one right-sized forging company and one 3PL; one researched lead is already
 * waiting in the pool.
 */

let db: Db;
let log: FakeLog;

/** Everything the sample must never touch. */
async function counts() {
  const n = async (t: typeof leads | typeof people | typeof prospectSearches | typeof activities | typeof tasks) => Number((await db.select({ n: sql<number>`count(*)::int` }).from(t))[0].n);
  return { leads: await n(leads), people: await n(people), searches: await n(prospectSearches), activities: await n(activities), tasks: await n(tasks) };
}

async function startSample(fresh = false): Promise<number> {
  const start: MorningSampleStart = { mode: 'morning', phase: 'init', fresh };
  const [t] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, report: start }).returning({ id: sourcingTests.id });
  return t.id;
}

async function reportOf(id: number): Promise<MorningSampleReport> {
  const [t] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
  expect(t.error).toBe('');
  expect(isMorningSample(t.report)).toBe(true);
  return t.report as MorningSampleReport;
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  log = { calls: [], verified: [], finder: [], apollo: [] };
  // Two associates (Puja, who also works CA firms, and Parimal), one lead a day in each segment.
  const team = await db.select().from(users).where(eq(users.role, 'bda')).orderBy(users.id);
  await db.update(users).set({ active: false }).where(inArray(users.id, team.filter((u) => !['Puja', 'Parimal'].includes(u.name)).map((u) => u.id)));
  await saveSettings(db, settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1 }));
  // Already a lead: never found again. And one researched Manufacturing lead waiting for the draw.
  await db.insert(leads).values([
    { company: 'Known Gears', segment: MANUFACTURING, status: 'Disqualified' },
    { company: 'Ready Pool Co', segment: MANUFACTURING, status: 'Approved', qualified: true, contactName: 'Asha Kulkarni', contactTitle: 'Plant Head', contactVerifiedAt: new Date(), emailSubject: 'Stock checks', emailBody: 'Hi Asha' },
  ]);
});

describe('the morning a sample shows', () => {
  it("is this morning's when run before its 8 am draw, else the next working day's", () => {
    // Wednesday 21 Oct 2026, 12:45 am India time: this morning's draw.
    expect(sampleMorning(new Date('2026-10-20T19:15:00Z'), new Set())).toBe('2026-10-21');
    // The same Wednesday at 10 am: Thursday's.
    expect(sampleMorning(new Date('2026-10-21T04:30:00Z'), new Set())).toBe('2026-10-22');
    // Friday evening: Monday's. Saturday 1 am: Monday's too.
    expect(sampleMorning(new Date('2026-10-23T13:00:00Z'), new Set())).toBe('2026-10-26');
    expect(sampleMorning(new Date('2026-10-23T19:30:00Z'), new Set())).toBe('2026-10-26');
    // A holiday this morning: the next working day's.
    expect(sampleMorning(new Date('2026-10-20T19:15:00Z'), new Set(['2026-10-21']))).toBe('2026-10-22');
  });
});

describe('the Morning Sample Run', () => {
  it("shows each associate's day tomorrow, and saves nothing but its report", async () => {
    const before = await counts();
    const id = await startSample();
    expect(await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY)).toBe('done');
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row.status).toBe('done');
    const r = await reportOf(id);

    // Nothing saved anywhere but the report: no lead, no person, no search remembered, nothing on a timeline or a Today.
    expect(await counts()).toEqual(before);
    const [pooled] = await db.select().from(leads).where(eq(leads.company, 'Ready Pool Co'));
    expect(pooled.ownerId).toBeNull();

    expect(r.day).toBe(sampleMorning(new Date(), new Set()));
    // Two associates, one of each a day: the pool has one Manufacturing lead, so the search was asked for the rest (plus a quarter).
    expect(r.start[MANUFACTURING]).toMatchObject({ need: 2, pool: 1, wanted: 2 });
    expect(r.start[LOGISTICS]).toMatchObject({ need: 2, pool: 0, wanted: 3 });
    // Researched exactly as the run does: the right-sized forging company is approved with the plant head found.
    const forgeline = r.companies.find((c) => c.page.name === 'Forgeline Components')!;
    expect(forgeline).toMatchObject({ outcome: 'approved', segment: MANUFACTURING });
    expect(forgeline.lead).toMatchObject({ contactName: 'Rahul Patil', contactTitle: 'Plant Head', status: 'Approved' });
    expect(forgeline.lead!.emailBody).toBeTruthy();
    expect(r.companies.some((c) => c.page.name === 'Tiny Tools' || c.page.name === 'Known Gears')).toBe(false);
    // The 3PL was short after research, so it searched again, as the run would.
    expect(r.search!.round).toBe(2);

    // Dealt as the draw would: each person one Manufacturing (the pool lead and the sample's), and the one 3PL to one of them.
    expect(r.hands.map((h) => h.name).sort()).toEqual(['Parimal', 'Puja']);
    const mfg = r.hands.flatMap((h) => h.cards.filter((c) => cardLead(r, c)!.lead.segment === MANUFACTURING).map((c) => cardLead(r, c)!.lead.company)).sort();
    expect(mfg).toEqual(['Forgeline Components', 'Ready Pool Co']);
    expect(r.hands.reduce((a, h) => a + h.short[LOGISTICS], 0)).toBe(1);
    expect(r.hands.every((h) => h.short[MANUFACTURING] === 0)).toBe(true);
    // Puja works CA firms too: her ten from the sheet come on top, outside the sample.
    expect(r.hands.find((h) => h.name === 'Puja')!.ca).toBe(true);
    expect(r.hands.find((h) => h.name === 'Parimal')!.ca).toBe(false);

    // The page: switch to Puja and see her day as Today would show it.
    const puja = r.hands.find((h) => h.name === 'Puja')!;
    const html = renderToStaticMarkup(
      createElement(MorningSample, { test: row, running: false, earlier: [], person: puja.userId, senderName: 'INVECK Sales Team', icps: await db.select().from(icps) }),
    );
    expect(html).toContain('Puja&#x27;s Today on');
    expect(html).toContain('Leads assigned today');
    expect(html).toContain('from the Google Sheet at 8 am');
    for (const c of puja.cards) expect(html).toContain(cardLead(r, c)!.lead.company.replace(/&/g, '&amp;'));
    // The overview: what each person gets, then every lead person by person.
    expect(html).toContain('Who gets what on');
    expect(html).toContain('Every lead, person by person');
    for (const h of r.hands) for (const c of h.cards) expect(html).toContain(cardLead(r, c)!.lead.contactName);
    expect(html).toContain('Talk track');
    expect(html).toContain('Connection note');
    expect(html).toContain('Parimal');
  });

  it('can fill every list from the search alone, leaving the pool out', async () => {
    const id = await startSample(true);
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    expect(r.fresh).toBe(true);
    expect(r.start[MANUFACTURING].wanted).toBe(3);
    expect(r.pool).toEqual([]);
    expect(r.hands.flatMap((h) => h.cards).every((c) => c.from === 'sample')).toBe(true);
  });

  it('carries on in a new invocation when out of time, and gets to the same end', async () => {
    const id = await startSample();
    let steps = 0;
    for (; steps < 300; steps++) if ((await runSourcingTest(db, morningServices(log), id, 0)) === 'done') break;
    expect(steps).toBeGreaterThan(2);
    expect(steps).toBeLessThan(300);
    const r = await reportOf(id);
    expect(r.phase).toBe('done');
    expect(r.companies.find((c) => c.page.name === 'Forgeline Components')?.outcome).toBe('approved');
    expect(r.hands.reduce((a, h) => a + h.cards.length, 0)).toBe(3);
  });

  it("stopped by the server partway (Vercel ending its chain), it carries on from where it got to and gets to the same end", async () => {
    const { reopenTest } = await import('@/lib/sourcing/test-run');
    const id = await startSample();
    // Two invocations' worth, then the old way of stopping: failed, with the report kept.
    for (let i = 0; i < 2; i++) expect(await runSourcingTest(db, morningServices(log), id, 0)).toBe('continue');
    const before = (await reportOf(id)).companies.length;
    await db.update(sourcingTests).set({ status: 'failed', error: "Could not carry on after the server's time limit: 508 Infinite loop detected. The report shows what it got to.", finishedAt: new Date() }).where(eq(sourcingTests.id, id));
    expect(await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY)).toBe('done');
    // The page offers to carry on.
    const [stopped] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    const page = (running: boolean) => renderToStaticMarkup(createElement(MorningSample, { test: stopped, running, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
    expect(page(false)).toContain('Carry on from here');
    expect(page(true)).not.toContain('Carry on from here');
    expect(await reopenTest(db, id)).toBe(true);
    const searchesBefore = log.calls.length;
    expect(await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY)).toBe('done');
    const r = await reportOf(id);
    expect(r.phase).toBe('done');
    expect(r.companies.length).toBeGreaterThanOrEqual(before);
    expect(r.companies.find((c) => c.page.name === 'Forgeline Components')?.outcome).toBe('approved');
    expect(r.hands.reduce((a, h) => a + h.cards.length, 0)).toBe(3);
    expect(log.calls.length).toBeGreaterThan(searchesBefore);
  });

  it('tries the cheaper rules (the 6 am run does not): 100-result searches, rule-outs remembered, no repeat lookups, a 2,300 budget', async () => {
    const store = new Map<string, unknown>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))) };
    const sent: { q: string; num: number }[] = [];
    const watched = () => {
      const base = morningServices(log, [], { cache });
      return {
        ...base,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes('google.serper.dev/search')) sent.push(JSON.parse(String(init?.body)));
          return base.fetch(input, init);
        }) as typeof fetch,
      };
    };
    const first = await startSample(true);
    await runSourcingTest(db, watched(), first, Number.POSITIVE_INFINITY);
    const r = await reportOf(first);
    expect(r.budget).toBe(2300);
    expect(r.companies.find((c) => c.page.name === 'Forgeline Components')?.outcome).toBe('approved');
    // People searches ask for a hundred results.
    const people = sent.filter((b) => b.q.startsWith('site:linkedin.com/in ') && /"(forging|warehousing)"/.test(b.q));
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((b) => b.num === 100)).toBe(true);
    // Research doesn't look the company's LinkedIn page up again (the search found it), nor its officers in the news and filings.
    expect(sent.some((b) => b.q === 'site:linkedin.com/company "forgeline.in"')).toBe(false);
    expect(sent.some((b) => b.q.includes('"company secretary"'))).toBe(false);
    // Tiny Tools was too small: the next sample doesn't check it again.
    expect(sent.some((b) => b.q.startsWith('site:linkedin.com/company') && b.q.includes('Tiny Tools'))).toBe(true);
    sent.length = 0;
    const second = await startSample(true);
    await runSourcingTest(db, watched(), second, Number.POSITIVE_INFINITY);
    expect((await reportOf(second)).phase).toBe('done');
    expect(sent.some((b) => b.q.startsWith('site:linkedin.com/company') && b.q.includes('Tiny Tools'))).toBe(false);
  });

  it('asks for ten results instead when Serper refuses a hundred, and still gets to the end', async () => {
    const base = morningServices(log);
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('google.serper.dev/search') && JSON.parse(String(init?.body)).num > 10) {
          return new Response(JSON.stringify({ message: 'Query pattern not allowed for free accounts.', statusCode: 400 }), { status: 400 });
        }
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const id = await startSample();
    await runSourcingTest(db, svc, id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    expect(r.phase).toBe('done');
    expect(r.companies.find((c) => c.page.name === 'Forgeline Components')?.outcome).toBe('approved');
  });

  it("shows the first morning the draw runs, when that's later than the next one", async () => {
    await db.insert(settings).values({ key: 'morningStartsOn', value: '2030-01-10' });
    const id = await startSample();
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    expect((await reportOf(id)).day).toBe('2030-01-10');
  });

  it("keeps to the day's Google search budget, as the run does", async () => {
    const id = await startSample(true);
    await runSourcingTest(db, morningServices(log, [], { meter: dbSearchMeter(db), budget: 150 }), id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    expect(r.budget).toBe(150);
    expect(r.credits).toBeGreaterThan(0);
    expect(r.credits!).toBeLessThanOrEqual(150);
    // Its searches are real: they count in the day's total too.
    expect(await searchesUsed(db)).toBe(r.credits);
  });

  it('fails with the reason when Google refuses every search, and saves nothing', async () => {
    const before = await counts();
    const id = await startSample();
    const svc = morningServices(log);
    await runSourcingTest(db, { ...svc, keys: { ...svc.keys, serper: 'wrong-key' } }, id, Number.POSITIVE_INFINITY);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^Google search failed/);
    expect(await counts()).toEqual(before);
  });
});
