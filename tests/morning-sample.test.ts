import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, enrichmentCache, icps, leads, people, prospectSearches, settings, sourcingTests, tasks, users } from '@/lib/db/schema';
import { LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { settingsSchema, saveSettings } from '@/lib/settings';
import { runSourcingTest } from '@/lib/sourcing/test-run';
import { cardLead, isMorningSample, rejectionReason, sampleMorning, segmentsToSearchAgain, spendStep, startProspectSearch, SAMPLE_3PL_RULES, SAMPLE_RULES, type MorningSampleReport, type MorningSampleStart } from '@/lib/sourcing/sample-run';
import { MorningSample } from '@/app/(app)/sourcing/morning-sample';
import type { FakeLog } from './fake-apis';
import { morningServices } from './morning-world';
import { dbSearchMeter, searchesUsed } from '@/lib/search-budget';
import { verifyContacts } from '@/lib/verify-contacts';
import { normQuery } from '@/lib/pipeline/query-history';
import { normCompany } from '@/lib/pipeline/text';
import { DROP_REASONS, morningPlan, searchRound, startRound } from '@/lib/sourcing/morning';
import { companiesQuery, lookupBatch, PAGES_PER_SEARCH, PEOPLE_KEYWORDS } from '@/lib/sourcing/people-first';
import { rememberKept, rememberSearch } from '@/lib/sourcing/search-memory';
import { dbEnrichmentCache } from '@/lib/enrichment-cache';

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

/** The services, with every Google search (Serper) query written to `sink`. */
function recording(base: ReturnType<typeof morningServices>, sink: string[]) {
  return {
    ...base,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('google.serper.dev')) sink.push(String(JSON.parse(String(init?.body ?? '{}')).q ?? ''));
      return base.fetch(input, init);
    }) as typeof fetch,
  };
}

async function reportOf(id: number): Promise<MorningSampleReport> {
  const [t] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
  expect(t.error).toBe('');
  expect(isMorningSample(t.report)).toBe(true);
  return t.report as MorningSampleReport;
}

import { legacyAllocation } from './legacy-allocation';

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  log = { calls: [], verified: [], finder: [], apollo: [] };
  await legacyAllocation(db);
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

    // Nothing saved anywhere but the report: no lead, no person, nothing in the 6 am run's search memory, nothing on a timeline or a Today.
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
    expect(r.search!.round).toBeGreaterThanOrEqual(2);

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

  it('tries the cheaper rules (the 6 am run does not): 10-result searches, rule-outs remembered, no repeat lookups, a 4,000 budget', async () => {
    const store = new Map<string, unknown>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))) };
    const sent: { q: string; num: number }[] = [];
    const news: string[] = [];
    const watched = () => {
      const base = morningServices(log, [], { cache });
      return {
        ...base,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes('google.serper.dev/search')) sent.push(JSON.parse(String(init?.body)));
          if (String(input).includes('google.serper.dev/news')) news.push(JSON.parse(String(init?.body)).q);
          return base.fetch(input, init);
        }) as typeof fetch,
      };
    };
    const first = await startSample(true);
    await runSourcingTest(db, watched(), first, Number.POSITIVE_INFINITY);
    const r = await reportOf(first);
    expect(r.budget).toBe(SAMPLE_RULES.credits);
    expect(SAMPLE_RULES.credits).toBe(4000);
    expect(r.companies.find((c) => c.page.name === 'Forgeline Components')?.outcome).toBe('approved');
    // People searches ask for ten results; 3PL's with no town (in India), a hundred (30 Oct).
    const people = sent.filter((b) => b.q.startsWith('site:linkedin.com/in ') && /"(forging|warehousing)"/.test(b.q));
    expect(people.length).toBeGreaterThan(0);
    expect(people.filter((b) => !b.q.endsWith(' India')).every((b) => b.num === 10)).toBe(true);
    expect(people.filter((b) => b.q.endsWith(' India')).every((b) => b.num === 100)).toBe(true);
    // Research doesn't look the company's LinkedIn page up again (the search found it), nor its officers in the news and filings.
    expect(sent.some((b) => b.q === 'site:linkedin.com/company "forgeline.in"')).toBe(false);
    expect(sent.some((b) => b.q.includes('"company secretary"'))).toBe(false);
    // Tiny Tools was too small: the next sample doesn't check it again.
    expect(sent.some((b) => b.q.startsWith('site:linkedin.com/company') && b.q.includes('Tiny Tools'))).toBe(true);
    expect(news.some((q) => q.includes('"Forgeline Components"'))).toBe(true);
    sent.length = 0;
    news.length = 0;
    const second = await startSample(true);
    await runSourcingTest(db, watched(), second, Number.POSITIVE_INFINITY);
    const again = await reportOf(second);
    expect(again.phase).toBe('done');
    expect(sent.some((b) => b.q.startsWith('site:linkedin.com/company') && b.q.includes('Tiny Tools'))).toBe(false);
    // Researched again in the next sample: its news, checked days ago at most, isn't checked again.
    expect(again.companies.find((c) => c.page.name === 'Forgeline Components')?.outcome).toBe('approved');
    expect(news.some((q) => q.includes('"Forgeline Components"'))).toBe(false);
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

  it('stops where it is when the admin presses Stop, and is not picked up again', async () => {
    const { stopSample } = await import('@/lib/sourcing/sample-run');
    const { canCarryOn, claimStalledTests } = await import('@/lib/sourcing/test-run');
    const id = await startSample();
    expect(await runSourcingTest(db, morningServices(log), id, 0)).toBe('continue');
    expect(await stopSample(db, id)).toBe(true);
    const calls = log.calls.length;
    expect(await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY)).toBe('done');
    expect(log.calls.length).toBe(calls);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    expect(row).toMatchObject({ status: 'failed', error: 'Stopped by you. The report shows what it got to.' });
    expect(canCarryOn(row)).toBe(false);
    expect(await claimStalledTests(db, new Date(Date.now() + 60 * 60_000))).toEqual([]);
    expect(await stopSample(db, id)).toBe(false);
  });

  it('pushes the companies ticked into the pipeline: an approved one ready for the draw, one not researched as New with its people', async () => {
    const { pushSampleCompanies, stopSample } = await import('@/lib/sourcing/sample-run');
    const { peopleFirstContacts } = await import('@/lib/sourcing/morning');
    // A finished sample: Forgeline was researched and approved.
    const done = await startSample(true);
    await runSourcingTest(db, morningServices(log), done, Number.POSITIVE_INFINITY);
    const forgeline = (await reportOf(done)).companies.find((c) => c.page.name === 'Forgeline Components')!;
    expect(forgeline.outcome).toBe('approved');
    expect(await pushSampleCompanies(db, done, [forgeline.key])).toEqual({ pushed: 1, skipped: [] });
    const [lead] = await db.select().from(leads).where(eq(leads.company, 'Forgeline Components'));
    expect(lead).toMatchObject({ status: 'Approved', contactName: 'Rahul Patil', ownerId: null, companyLinkedin: forgeline.page.url });
    expect(lead.contactVerifiedAt).toBeInstanceOf(Date);
    expect(lead.emailBody).toBeTruthy();
    expect((await db.select().from(people).where(eq(people.leadId, lead.id))).some((p) => p.name === 'Rahul Patil' && p.isPrimary)).toBe(true);
    expect((await db.select().from(activities).where(eq(activities.leadId, lead.id))).some((a) => a.text.includes(`Morning Sample Run ${done}`))).toBe(true);
    // Shown as in the pipeline, and never pushed twice.
    expect((await reportOf(done)).companies.find((c) => c.key === forgeline.key)?.pushed).toBe(lead.id);
    expect(await pushSampleCompanies(db, done, [forgeline.key])).toEqual({ pushed: 0, skipped: [] });

    // A sample stopped before research: the company goes in as New, with the people found there for research to start from.
    const stopped = await startSample(true);
    const raw = async () => (await db.select().from(sourcingTests).where(eq(sourcingTests.id, stopped)))[0].report as MorningSampleReport;
    await runSourcingTest(db, morningServices(log), stopped, 0);
    for (let i = 0; i < 20 && !(await raw()).companies.some((c) => c.segment === LOGISTICS); i++) await runSourcingTest(db, morningServices(log), stopped, 0);
    const swift = (await raw()).companies.find((c) => c.segment === LOGISTICS)!;
    expect(swift.outcome).toBeUndefined();
    // Not while it runs.
    expect(await pushSampleCompanies(db, stopped, [swift.key])).toEqual({ pushed: 0, skipped: [] });
    await stopSample(db, stopped);
    // Forgeline is in the pipeline already: left out.
    const again = (await raw()).companies.find((c) => c.page.name === 'Forgeline Components');
    const result = await pushSampleCompanies(db, stopped, [swift.key, ...(again ? [again.key] : [])]);
    expect(result.pushed).toBe(1);
    if (again) expect(result.skipped).toEqual(['Forgeline Components']);
    const [fresh] = await db.select().from(leads).where(eq(leads.company, swift.page.name));
    expect(fresh).toMatchObject({ status: 'New', ownerId: null, segment: LOGISTICS });
    expect(fresh.source.startsWith('People-first search')).toBe(true);
    expect((await peopleFirstContacts(db, fresh)).map((p) => p.name)).toEqual(swift.contacts.map((p) => p.name));
  });

  it('a company with no LinkedIn page is kept aside, not ruled out (30 Oct), and researched when Manufacturing would end short; an employer that is only an industry word is not looked up', async () => {
    // Two more people in the forging search: a plant head at a company with no LinkedIn page, and one whose employer is just "Foundry".
    const extra = [
      { title: 'Kiran Rao - Plant Head - Pageless Forge Works | LinkedIn', link: 'https://in.linkedin.com/in/kiran-rao', subtitle: 'Pune, Maharashtra, India · Plant Head · Pageless Forge Works', snippet: '' },
      { title: 'Hemant D - Plant Head - Foundry | LinkedIn', link: 'https://in.linkedin.com/in/hemant-d', subtitle: 'Pune, Maharashtra, India · Plant Head · Foundry', snippet: '' },
    ];
    const asked: string[] = [];
    const svc = () => {
      const base = morningServices(log);
      return {
        ...base,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = String(input).includes('google.serper.dev/search') ? JSON.parse(String(init?.body)) : null;
          if (body) asked.push(body.q);
          const res = await base.fetch(input, init);
          if (body?.q.startsWith('site:linkedin.com/in ') && /"forging"/.test(body.q)) {
            const data = await res.json();
            return new Response(JSON.stringify({ ...data, organic: [...(data.organic ?? []), ...extra] }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return res;
        }) as typeof fetch,
      };
    };
    const id = await startSample(true);
    await runSourcingTest(db, svc(), id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    // Checked and kept aside; the made-up world leaves Manufacturing short, so it went to research by its name.
    expect(r.search!.segments.find((x) => x.segment === MANUFACTURING)!.checked).toContain(normCompany('Pageless Forge Works'));
    expect(r.search!.drops![MANUFACTURING]?.[DROP_REASONS.kept]).toBeGreaterThanOrEqual(1);
    expect(r.search!.drops![MANUFACTURING]?.[DROP_REASONS.noPage]).toBeUndefined();
    expect(r.companies.find((c) => c.employer === 'Pageless Forge Works')?.note).toContain('no LinkedIn company page found');
    // "Foundry" has no name to look up: never searched for, never kept.
    expect(asked.some((q) => q === 'site:linkedin.com/company "Foundry"')).toBe(false);
    expect(r.companies.some((c) => c.employer === 'Foundry')).toBe(false);
  });

  describe('3PL & Logistics searches longer and screens strictly (26 Oct)', () => {
    const TPL = new RegExp(`^site:linkedin\\.com\\/in .*"(${PEOPLE_KEYWORDS[LOGISTICS].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})"`);
    const MFG_PEOPLE = /^site:linkedin\.com\/in /;
    /** The world, with `extra` people added to the people searches `match` picks, or none at all there with `empty`. */
    const withPeople = (asked: string[], match: RegExp, extra: unknown[], empty = false) => {
      const base = morningServices(log);
      return {
        ...base,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = String(input).includes('google.serper.dev/search') ? JSON.parse(String(init?.body)) : null;
          if (body) asked.push(body.q);
          const res = await base.fetch(input, init);
          if (body && match.test(body.q)) {
            const data = await res.json();
            return new Response(JSON.stringify({ ...data, organic: empty ? [] : [...(data.organic ?? []), ...extra] }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return res;
        }) as typeof fetch,
      };
    };

    it('a 3PL company with no LinkedIn page is kept aside and researched when 3PL would end short (30 Oct); an employer that is only an industry word still is not looked up', async () => {
      const extra = [
        { title: 'Asha K - Head of Logistics - Pageless Warehousing Co | LinkedIn', link: 'https://in.linkedin.com/in/asha-k', subtitle: 'Pune, Maharashtra, India · Head of Logistics · Pageless Warehousing Co', snippet: '' },
        { title: 'Vivek M - Head of Logistics - Logistics | LinkedIn', link: 'https://in.linkedin.com/in/vivek-m', subtitle: 'Pune, Maharashtra, India · Head of Logistics · Logistics', snippet: '' },
      ];
      const asked: string[] = [];
      const id = await startSample(true);
      await runSourcingTest(db, withPeople(asked, TPL, extra), id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      expect(r.phase).toBe('done');
      // The search did see her: the company was checked, kept aside, and (3PL short in the made-up world) researched.
      expect(r.search!.segments.find((x) => x.segment === LOGISTICS)!.checked).toContain(normCompany('Pageless Warehousing Co'));
      expect(r.companies.find((c) => c.employer === 'Pageless Warehousing Co')?.note).toContain('no LinkedIn company page found');
      // An employer that is only an industry word is still not looked up (no credit spent on it).
      expect(asked.some((q) => q === 'site:linkedin.com/company "Logistics"')).toBe(false);
    });

    it('a company ruled out before for having no LinkedIn page is no longer kept out by that (30 Oct)', async () => {
      const extra = [{ title: 'Asha K - Head of Logistics - Pageless Warehousing Co | LinkedIn', link: 'https://in.linkedin.com/in/asha-k', subtitle: 'Pune, Maharashtra, India · Head of Logistics · Pageless Warehousing Co', snippet: '' }];
      const [icp] = await db.select().from(icps).where(eq(icps.segment, LOGISTICS));
      const cache = dbEnrichmentCache(db);
      await cache.set(`company-check:v1:${LOGISTICS}:${icp.companySize}:${normCompany('Pageless Warehousing Co')}`, { at: new Date().toISOString(), why: 'no LinkedIn page' });
      const id = await startSample(true);
      await runSourcingTest(db, { ...withPeople([], TPL, extra), cache }, id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      expect(r.search?.drops?.[LOGISTICS]?.['ruled out in the last 90 days']).toBeUndefined();
      expect(r.companies.find((c) => c.employer === 'Pageless Warehousing Co')?.note).toContain('no LinkedIn company page found');
    });

    it('asks for a quarter more 3PL companies than it is short of (Manufacturing 10%), and gives up on 3PL only after 50 searches find nobody new', async () => {
      const asked: string[] = [];
      const id = await startSample(true);
      await runSourcingTest(db, withPeople(asked, TPL, [], true), id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      expect(r.phase).toBe('done');
      const short = (s: typeof LOGISTICS | typeof MANUFACTURING) => r.start[s].need - (r.fresh ? 0 : r.start[s].pool);
      expect(r.start[LOGISTICS].wanted).toBe(Math.ceil(short(LOGISTICS) * 1.25));
      expect(r.start[MANUFACTURING].wanted).toBe(Math.ceil(short(MANUFACTURING) * 1.1));
      const tplSearches = asked.filter((q) => TPL.test(q));
      expect(tplSearches.length).toBeGreaterThanOrEqual(50);
      expect(tplSearches.length).toBeLessThan(50 + 8 * 2);
      expect(r.search!.history.find((h) => h.segment === LOGISTICS)).toMatchObject({ stopped: 'nonePassed', added: 0 });
    });

    /**
     * Each 3PL people search finds someone at a new company, `kind(n)` for the n-th search: one whose LinkedIn page shows
     * another industry ('other', ruled out at its check), a 3PL with its page ('good'), one with no LinkedIn page
     * ('pageless'), or Swift ('swift', the made-up world's 3PL).
     */
    const tplWorld = (asked: string[], kind: (n: number) => 'other' | 'good' | 'pageless' | 'swift' | 'vague') => {
      const base = morningServices(log);
      // A different letters-only tag for every n (base 26).
      const tag = (n: number) => [...n.toString(26)].map((ch) => 'abcdefghijklmnopqrstuvwxyz'['0123456789abcdefghijklmnop'.indexOf(ch)]).join('');
      const pages = new Map<string, string>();
      let n = 0;
      const json = (organic: unknown[]) => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });
      return {
        ...base,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = String(input).includes('google.serper.dev/search') ? JSON.parse(String(init?.body)) : null;
          if (body) asked.push(body.q);
          if (body?.q.startsWith('site:linkedin.com/company')) {
            const shown = [...pages].filter(([word]) => new RegExp(`\\b${word}\\b`).test(body.q));
            if (shown.length)
              return json(
                shown.map(([word, industry]) => ({
                  title: `${word} Group | LinkedIn`,
                  link: `https://in.linkedin.com/company/${word.toLowerCase()}`,
                  snippet: `${word} Group | 1,234 followers on LinkedIn. Website: http://www.${word.toLowerCase()}.in.${industry ? ` Industry: ${industry}.` : ''} Company size: 201-500 employees. Headquarters: Pune, Maharashtra`,
                })),
              );
          }
          if (!body || !TPL.test(body.q)) return base.fetch(input, init);
          n++;
          const k = kind(n);
          const word = `${k === 'good' ? 'Harbor' : k === 'other' ? 'Mercury' : k === 'vague' ? 'Orbit' : 'Pageless'}${tag(n)}`;
          if (k === 'good') pages.set(word, 'Warehousing and Storage');
          if (k === 'vague') pages.set(word, '');
          if (k === 'other') pages.set(word, 'Retail Apparel and Fashion');
          const [name, company] = k === 'swift' ? ['Deepak Nair', 'Swift Warehousing Solutions'] : [`Asha ${word}`, `${word} Group`];
          return json([{ title: `${name} - Head of Logistics - ${company} | LinkedIn`, link: `https://in.linkedin.com/in/${name.toLowerCase().replace(/ /g, '-')}`, subtitle: `Pune, Maharashtra, India · Head of Logistics · ${company}`, snippet: '' }]);
        }) as typeof fetch,
      };
    };
    const newButRuledOut = (asked: string[], passAt = 0) => tplWorld(asked, (n) => (n === passAt ? 'swift' : 'other'));

    it("3PL: a company whose industry shows nowhere goes to research, as Manufacturing's does (30 Oct)", async () => {
      const asked: string[] = [];
      const id = await startSample(true);
      await runSourcingTest(db, tplWorld(asked, () => 'vague'), id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      const vague = r.companies.filter((c) => c.segment === LOGISTICS && c.employer.startsWith('Orbit'));
      expect(vague.length).toBeGreaterThan(0);
      // Approved only if research confirms the industry (the same guard as Manufacturing's).
      expect(vague.every((c) => /industry not shown on LinkedIn or its website: research checks it/.test(c.note))).toBe(true);
      expect(r.search?.drops?.[LOGISTICS]?.[DROP_REASONS.industry]).toBeUndefined();
    });

    it('3PL: when research approves none of a round\'s companies (here it fails on every one), no further round is searched (30 Oct)', async () => {
      const world = tplWorld([], () => 'good');
      const failing = {
        ...world,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const host = new URL(String(input instanceof Request ? input.url : input)).host;
          if (host === 'api.deepseek.com' || host === 'api.anthropic.com') return new Response('{"error":"down"}', { status: 500 });
          return world.fetch(input, init);
        }) as typeof fetch,
      };
      const id = await startSample(true);
      await runSourcingTest(db, failing, id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      const tpl = r.companies.filter((c) => c.segment === LOGISTICS);
      expect(tpl.length).toBeGreaterThan(0);
      expect(tpl.some((c) => c.outcome === 'approved')).toBe(false);
      expect(r.search!.history.filter((h) => h.segment === LOGISTICS).map((h) => h.round)).toEqual([1]);
    });

    it('3PL: a company with no LinkedIn page is not researched when the list fills without it (30 Oct)', async () => {
      const asked: string[] = [];
      const id = await startSample(true);
      // The first eight searches (the first batch) find companies with no LinkedIn page: looked up while companies are
      // still needed, and kept aside; the next ones find 3PLs with their pages, which fill the list.
      await runSourcingTest(db, tplWorld(asked, (n) => (n <= 8 ? 'pageless' : 'good')), id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      const tpl = r.search!.history.find((h) => h.segment === LOGISTICS && h.round === 1)!;
      expect(tpl).toMatchObject({ stopped: 'target' });
      expect(tpl.added).toBe(tpl.wanted);
      expect(r.search!.drops![LOGISTICS]?.[DROP_REASONS.kept]).toBeGreaterThanOrEqual(1);
      expect(r.companies.some((c) => c.employer.startsWith('Pageless'))).toBe(false);
      expect(r.companies.filter((c) => c.segment === LOGISTICS).every((c) => c.employer.startsWith('Harbor'))).toBe(true);
    });

    it('3PL: a new company that is then ruled out does not keep the search going; 50 searches with none passing stop it (29 Oct)', async () => {
      const asked: string[] = [];
      const id = await startSample(true);
      await runSourcingTest(db, newButRuledOut(asked), id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      expect(r.phase).toBe('done');
      const tplSearches = asked.filter((q) => TPL.test(q));
      expect(tplSearches.length).toBeGreaterThanOrEqual(SAMPLE_3PL_RULES.quietSearches);
      expect(tplSearches.length).toBeLessThan(SAMPLE_3PL_RULES.quietSearches + 8 * 2);
      // Nearly every search found a new company (before, each of them started the 50 again).
      expect(r.search!.segments.find((x) => x.segment === LOGISTICS)!.checked.length).toBeGreaterThanOrEqual(SAMPLE_3PL_RULES.quietSearches - 8);
      expect(r.search!.history.find((h) => h.segment === LOGISTICS)).toMatchObject({ stopped: 'nonePassed', added: 0 });
      // Manufacturing keeps its rule: a new company is what counts.
      expect(r.search!.history.find((h) => h.segment === MANUFACTURING)?.stopped).not.toBe('nonePassed');
    });

    it('3PL: a company that passes the check starts the 50 again (29 Oct)', async () => {
      const asked: string[] = [];
      const id = await startSample(true);
      await runSourcingTest(db, newButRuledOut(asked, 30), id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      const first = r.search!.history.find((h) => h.segment === LOGISTICS && h.round === 1)!;
      expect(first.added).toBe(1);
      if (first.wanted > 1) {
        expect(first.stopped).toBe('nonePassed');
        expect(asked.filter((q) => TPL.test(q)).length).toBeGreaterThanOrEqual(30 + SAMPLE_3PL_RULES.quietSearches);
      }
    });

    it('3PL gets up to five rounds, each only while its last round found companies; Manufacturing keeps three', async () => {
      const short = { [MANUFACTURING]: 2, [LOGISTICS]: 3 } as Record<typeof MANUFACTURING | typeof LOGISTICS, number>;
      const found = [{ segment: MANUFACTURING, added: 1 }, { segment: LOGISTICS, added: 2 }];
      expect(segmentsToSearchAgain(short, found, 1)).toEqual([MANUFACTURING, LOGISTICS]);
      expect(segmentsToSearchAgain(short, found, 3)).toEqual([LOGISTICS]);
      expect(segmentsToSearchAgain(short, [{ segment: LOGISTICS, added: 1 }], 4)).toEqual([LOGISTICS]);
      expect(segmentsToSearchAgain(short, [{ segment: LOGISTICS, added: 1 }], 5)).toEqual([]);
      // 30 Oct: found companies, but research approved none of them (ruled out, or failed): not searched again.
      expect(segmentsToSearchAgain(short, [{ segment: LOGISTICS, added: 14, approved: 0 }], 2)).toEqual([MANUFACTURING]);
      expect(segmentsToSearchAgain(short, [{ segment: LOGISTICS, added: 14, approved: 1 }], 2)).toEqual([MANUFACTURING, LOGISTICS]);
      // Manufacturing keeps its rule.
      expect(segmentsToSearchAgain(short, [{ segment: MANUFACTURING, added: 3, approved: 0 }, { segment: LOGISTICS, added: 14, approved: 0 }], 1)).toEqual([MANUFACTURING]);
      // 3PL found nobody last round: not searched again, whatever Manufacturing found.
      expect(segmentsToSearchAgain(short, [{ segment: MANUFACTURING, added: 1 }, { segment: LOGISTICS, added: 0 }], 1)).toEqual([MANUFACTURING]);
      // Not searched last round (it wasn't short then): searched now.
      expect(segmentsToSearchAgain(short, [{ segment: MANUFACTURING, added: 1 }], 1)).toEqual([MANUFACTURING, LOGISTICS]);
      // Nothing short: nothing searched.
      expect(segmentsToSearchAgain({ [MANUFACTURING]: 0, [LOGISTICS]: 0 } as typeof short, found, 1)).toEqual([]);
    });

    it(`Manufacturing with nobody to find still gives up, after ${SAMPLE_RULES.quietSearches} (28 Oct; 15 before)`, async () => {
      const asked2: string[] = [];
      const id2 = await startSample(true);
      await runSourcingTest(db, withPeople(asked2, MFG_PEOPLE, [], true), id2, Number.POSITIVE_INFINITY);
      const r2 = await reportOf(id2);
      const mfgSearches = asked2.filter((q) => MFG_PEOPLE.test(q) && !TPL.test(q));
      expect(r2.search!.history.find((h) => h.segment === MANUFACTURING)).toMatchObject({ stopped: 'dry', added: 0 });
      expect(mfgSearches.length).toBeGreaterThanOrEqual(SAMPLE_RULES.quietSearches);
      expect(mfgSearches.length).toBeLessThan(SAMPLE_RULES.quietSearches + 8 * 2);
    });
  });

  it('counts what every credit was spent on, step by step, and shows it on the report (27 Oct)', async () => {
    const at = (phase: 'search' | 'research', q: string, path = 'search') =>
      spendStep({ phase, companies: [{ employer: 'Forgeline Components Pvt Ltd', page: { name: 'Forgeline Components' } } as never] }, `https://google.serper.dev/${path}`, { body: JSON.stringify({ q }) });
    expect(at('search', 'site:linkedin.com/in "Plant Head" "forging" Pune')).toBe('Finding companies: people searches');
    expect(at('search', 'site:linkedin.com/company ("A" OR "B")')).toBe('Finding companies: their LinkedIn pages');
    expect(at('research', 'site:linkedin.com/in "Forgeline Components" "Plant Head" Pune')).toBe('Research: contact search');
    expect(at('research', 'site:linkedin.com/in "Forgeline Components" Pune')).toBe('Research: contact search');
    expect(at('research', 'site:linkedin.com/in "Ravi Kumar" Forgeline Components')).toBe('Research: contact checks (profile look-ups)');
    expect(at('research', '"Forgeline" (plant OR expansion)', 'news')).toBe('Research: news');
    expect(at('research', 'Pune, India', 'maps')).toBe('Research: towns on the map');
    expect(at('research', 'site:linkedin.com/company "forgeline.in"')).toBe('Research: company LinkedIn page');
    expect(at('research', 'site:forgeline.in')).toBe('Research: website');
    expect(at('research', 'Forgeline Components Pune official website')).toBe('Research: website');
    expect(at('research', '"Forgeline Components" Pune company profile products')).toBe('Research: must-have checks');
    // A whole run: every credit counted under a step, and the report shows them.
    const id = await startSample(true);
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    expect(Object.values(r.spend ?? {}).reduce((a, n) => a + n, 0)).toBe(r.credits);
    expect(r.spend?.['Finding companies: people searches']).toBeGreaterThan(0);
    expect(Object.keys(r.spend ?? {}).some((k) => k.startsWith('Research: '))).toBe(true);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    const html = renderToStaticMarkup(createElement(MorningSample, { test: row, running: false, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
    expect(html).toContain('Where the credits went');
    expect(html).toContain('per company researched');
    // Its people searches: how many found a new company (28 Oct).
    expect(r.yields?.[MANUFACTURING]?.found).toBeGreaterThan(0);
    expect(html).toContain('people searches: ');
    expect(html).toContain('found a new company');
  });

  it('gives up on a segment after its searches in a row find no new company, even when they show new people at companies INVECK already has (28 Oct)', async () => {
    const base = morningServices(log);
    let n = 0;
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const q = String(JSON.parse(String(init?.body ?? '{}')).q ?? '');
        // Every people search shows someone new on the lists, at Known Gears (a lead already).
        if (String(input).includes('google.serper.dev') && q.startsWith('site:linkedin.com/in "')) {
          n++;
          const who = { title: `Person ${n} - Plant Head - Known Gears | LinkedIn`, subtitle: 'Pune, Maharashtra, India · Plant Head · Known Gears', link: `https://in.linkedin.com/in/person-${n}`, snippet: '' };
          return new Response(JSON.stringify({ organic: [who] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const id = await startSample(true);
    await runSourcingTest(db, svc, id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    // 60 in a row, in steps of eight: 64, not the whole plan.
    expect(r.yields?.[MANUFACTURING]).toEqual({ found: 0, none: 64 });
    expect(r.yields?.[LOGISTICS]?.found).toBe(0);
    expect(r.yields?.[LOGISTICS]?.none).toBeLessThanOrEqual(56);
  });

  it('a people search whose first page of ten is full and finds new companies is read on at once: its first hundred, 2 credits (28 Oct)', async () => {
    const sent: [string, number, number][] = [];
    const base = morningServices(log);
    let n = 0;
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const q = String(body.q ?? '');
        if (String(input).includes('google.serper.dev') && q.startsWith('site:linkedin.com/in "')) {
          const num = Number(body.num ?? 10);
          sent.push([q, Number(body.page ?? 1), num]);
          // The forging searches: a full page of ten people at new companies (and more further down).
          if (/"forging"/.test(q)) {
            const people = Array.from({ length: num }, () => {
              n++;
              return { title: `Person ${n} - Plant Head - Gear Works ${n} | LinkedIn`, subtitle: `Pune, Maharashtra, India · Plant Head · Gear Works ${n}`, link: `https://in.linkedin.com/in/p-${n}`, snippet: '' };
            });
            return new Response(JSON.stringify({ organic: people }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
        }
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const id = await startSample(true);
    await runSourcingTest(db, svc, id, Number.POSITIVE_INFINITY);
    const forging = sent.filter(([q]) => /"forging"/.test(q));
    const first = forging.find(([, , num]) => num === 10)!;
    expect(first).toBeDefined();
    // Read on in the same run, its first hundred.
    expect(forging).toContainEqual([first[0], 1, 100]);
    // Not for a search that found nothing new, or whose page wasn't full.
    const empty = sent.filter(([q]) => !/"forging"/.test(q));
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every(([, , num]) => num === 10)).toBe(true);
  });

  it("a company ruled out before because its industry showed nowhere isn't kept out now such companies go to research; one showing another industry still is (30 Oct)", async () => {
    const base = morningServices(log);
    let n = 0;
    const person = (who: string, company: string) => ({ title: `${who} - Plant Head - ${company} | LinkedIn`, subtitle: `Pune, Maharashtra, India · Plant Head · ${company}`, link: `https://in.linkedin.com/in/${who.toLowerCase().replace(/ /g, '-')}`, snippet: '' });
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const q = String(JSON.parse(String(init?.body ?? '{}')).q ?? '');
        if (String(input).includes('google.serper.dev') && q.startsWith('site:linkedin.com/in "')) {
          n++;
          return new Response(JSON.stringify({ organic: [person(`Vague ${n}`, 'Vague Works'), person(`Fashion ${n}`, 'Fashion House')] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const [icp] = await db.select().from(icps).where(eq(icps.segment, MANUFACTURING));
    const cache = dbEnrichmentCache(db);
    const key = (c: string) => `company-check:v1:${MANUFACTURING}:${icp.companySize}:${normCompany(c)}`;
    await cache.set(key('Vague Works'), { at: new Date().toISOString(), why: "industry not shown on its LinkedIn page, and nothing on it shows it's in the ICP" });
    await cache.set(key('Fashion House'), { at: new Date().toISOString(), why: 'industry not in the ICP: Retail Apparel and Fashion' });
    const id = await startSample(true);
    await runSourcingTest(db, { ...svc, cache }, id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    // Fashion House: still ruled out. Vague Works: checked again (no LinkedIn page in this made-up world, so kept aside).
    expect(r.search?.drops?.[MANUFACTURING]?.['ruled out in the last 90 days']).toBe(1);
    expect(r.search?.drops?.[MANUFACTURING]?.[DROP_REASONS.kept]).toBe(1);
  });

  it('a company ruled out in the last 90 days is not a new company when a search finds it again (28 Oct)', async () => {
    const base = morningServices(log);
    let n = 0;
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const q = String(JSON.parse(String(init?.body ?? '{}')).q ?? '');
        // Every people search shows someone new at Tiny Tools, too small and ruled out before.
        if (String(input).includes('google.serper.dev') && q.startsWith('site:linkedin.com/in "')) {
          n++;
          return new Response(JSON.stringify({ organic: [{ title: `Person ${n} - Plant Head - Tiny Tools | LinkedIn`, subtitle: 'Pune, Maharashtra, India · Plant Head · Tiny Tools', link: `https://in.linkedin.com/in/tiny-${n}`, snippet: '' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const [icp] = await db.select().from(icps).where(eq(icps.segment, MANUFACTURING));
    const cache = dbEnrichmentCache(db);
    await cache.set(`company-check:v1:${MANUFACTURING}:${icp.companySize}:${normCompany('Tiny Tools')}`, { at: new Date().toISOString(), why: 'too small' });
    const id = await startSample(true);
    // The database's memory of companies ruled out, as the live run has it.
    await runSourcingTest(db, { ...svc, cache }, id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    expect(r.yields?.[MANUFACTURING]).toEqual({ found: 0, none: 64 });
    expect(r.companies.some((c) => c.employer === 'Tiny Tools')).toBe(false);
    // The report says why: dropped as ruled out before, and the segment stopped dry.
    expect(r.search?.drops?.[MANUFACTURING]?.['ruled out in the last 90 days']).toBeGreaterThan(0);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    const html = renderToStaticMarkup(createElement(MorningSample, { test: row, running: false, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
    expect(html).toContain('The company check, before research');
    expect(html).toContain('ruled out in the last 90 days');
    expect(html).toContain('stopped: searches in a row found no new company');
  });

  it("a Manufacturing company whose industry shows nowhere goes to research, and is approved only if research confirms the industry (28 Oct)", async () => {
    const { industryConfirmed } = await import('@/lib/sourcing/sample-run');
    expect(industryConfirmed([{ kind: 'industry', status: 'met' } as never])).toBe(true);
    expect(industryConfirmed([{ kind: 'industry', status: 'unknown' } as never, { kind: 'requirement', status: 'met' } as never])).toBe(false);
    expect(industryConfirmed([])).toBe(false);
    // Through research: Forgeline, as if its industry had shown nowhere.
    const plain = await startSample(true);
    await runSourcingTest(db, morningServices(log), plain, Number.POSITIVE_INFINITY);
    const done = await reportOf(plain);
    const forgeline = done.companies.find((c) => c.page.name === 'Forgeline Components')!;
    const unclear = { ...forgeline, note: `${forgeline.note}; industry not shown on LinkedIn or its website: research checks it`, outcome: undefined, why: undefined, lead: undefined, people: undefined, researchedAt: undefined };
    const report: MorningSampleReport = { ...done, phase: 'research', companies: [unclear], hands: [] };
    const [row] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, report: JSON.parse(JSON.stringify(report)) }).returning({ id: sourcingTests.id });
    await runSourcingTest(db, morningServices(log), row.id, Number.POSITIVE_INFINITY);
    const [c] = (await reportOf(row.id)).companies;
    // Research confirmed its industry: approved.
    expect(industryConfirmed(c.lead?.fitEvidence)).toBe(true);
    expect(c.outcome).toBe('approved');
    // Research couldn't confirm it (everything else as before): not approved, and not a lead for the pipeline.
    const base = morningServices(log);
    const vague = (text: string) => {
      try {
        const a = JSON.parse(text);
        if (!Array.isArray(a.criteria)) return text;
        return JSON.stringify({ ...a, criteria: a.criteria.map((x: { id: string }) => (x.id === 'IND' ? { ...x, status: 'unknown', evidence: 'Not stated', source: '' } : x)) });
      } catch {
        return text;
      }
    };
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await base.fetch(input, init);
        const host = new URL(String(input instanceof Request ? input.url : input)).host;
        if (host !== 'api.deepseek.com' && host !== 'api.anthropic.com') return res;
        const body = await res.json();
        for (const m of body.choices ?? []) m.message.content = vague(m.message.content);
        for (const m of body.content ?? []) if (m.type === 'text') m.text = vague(m.text);
        return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    };
    const [again] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, report: JSON.parse(JSON.stringify(report)) }).returning({ id: sourcingTests.id });
    await runSourcingTest(db, svc, again.id, Number.POSITIVE_INFINITY);
    const [d] = (await reportOf(again.id)).companies;
    expect(industryConfirmed(d.lead?.fitEvidence)).toBe(false);
    expect(d.outcome).toBe('ruled_out');
    expect(d.why).toMatch(/industry isn't shown on LinkedIn or its website, and research couldn't confirm it/);
    expect(d.lead).toMatchObject({ status: 'Disqualified', qualified: false });
  });

  it('reads a people search made in the last week that found companies further down (its first hundred results), not again (28 Oct)', async () => {
    const [icp] = await db.select().from(icps).where(eq(icps.segment, MANUFACTURING));
    const pq = morningPlan(MANUFACTURING, icp, 1)[0];
    await rememberSearch(db, MANUFACTURING, pq, { listed: 3, fresh: 2, results: 10 });
    await rememberKept(db, MANUFACTURING, normQuery(pq.q));
    await new Promise((done) => setTimeout(done, 5));
    const sent: [string, number, number][] = [];
    let cost = 0;
    const base = morningServices(log);
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (String(input).includes('google.serper.dev')) cost += Number(body.num ?? 10) > 10 ? 2 : 1;
        if (String(input).includes('google.serper.dev') && String(body.q ?? '').startsWith('site:linkedin.com/in ')) sent.push([String(body.q), Number(body.page ?? 1), Number(body.num ?? 10)]);
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const id = await startSample(true);
    await runSourcingTest(db, svc, id, Number.POSITIVE_INFINITY);
    // Its first hundred results in one search (2 credits), not its first ten again.
    expect(sent).toContainEqual([pq.q, 1, 100]);
    expect(sent).not.toContainEqual([pq.q, 1, 10]);
    // Every search counted at what it costs: 2 credits for a hundred results.
    expect((await reportOf(id)).credits).toBe(cost);
    // A hundred refused (Serper doesn't allow it on some accounts): its next ten instead.
    sent.length = 0;
    await rememberSearch(db, MANUFACTURING, pq, { listed: 3, fresh: 2, results: 10 });
    await new Promise((done) => setTimeout(done, 5));
    const refusing = {
      ...svc,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (Number(JSON.parse(String(init?.body ?? '{}')).num ?? 10) > 10) return new Response(JSON.stringify({ message: 'num > 10 is not allowed on this plan' }), { status: 400 });
        return svc.fetch(input, init);
      }) as typeof fetch,
    };
    const again = await startSample(true);
    await runSourcingTest(db, refusing, again, Number.POSITIVE_INFINITY);
    expect(sent).toContainEqual([pq.q, 2, 10]);
    expect(sent).not.toContainEqual([pq.q, 1, 10]);
  });

  it(`looks up to ${PAGES_PER_SEARCH} companies' pages in one search, within Google's 32 words`, () => {
    const six = ['Alpha Forge', 'Beta Cast', 'Gamma Gear', 'Delta Shaft', 'Epsilon Valve', 'Zeta Pump', 'Eta Bolt'].map((employer) => ({ employer }));
    expect(lookupBatch([...six]).length).toBe(PAGES_PER_SEARCH);
    const long = Array.from({ length: 6 }, (_, i) => ({ employer: `Shree Precision Engineering Auto Components Works ${'ABCDEF'[i]}` }));
    const batch = lookupBatch([...long]);
    expect(batch.length).toBeLessThan(6);
    expect(companiesQuery(batch.map((c) => c.employer)).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length).toBeLessThanOrEqual(32);
    // Those already found, or looked up on their own, don't take up words.
    expect(lookupBatch([...long.slice(0, 2).map((c) => ({ ...c, alone: true })), ...long]).length).toBeGreaterThan(batch.length);
  });

  it('looks a company up on its own, and checks its size, only while companies are still needed; the others wait their turn (28 Oct)', async () => {
    const names = ['Alpha Forge Components', 'Beta Cast Components', 'Gamma Gear Components', 'Delta Shaft Components', 'Epsilon Valve Components', 'Zeta Pump Components', 'Eta Bolt Components'];
    const pageOf = (n: string) => ({ title: `${n} | LinkedIn`, link: `https://in.linkedin.com/company/${n.toLowerCase().replace(/ /g, '-')}`, snippet: `${n} | 1,234 followers on LinkedIn. Website: http://www.${n.split(' ')[0].toLowerCase()}.in. Industry: Motor Vehicle Parts Manufacturing. Company size: 501-1,000 employees. Headquarters: Pune, Maharashtra` });
    const sent: string[] = [];
    const base = morningServices(log);
    const reply = (organic: unknown[]) => new Response(JSON.stringify({ organic }), { status: 200, headers: { 'content-type': 'application/json' } });
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const q = String(JSON.parse(String(init?.body ?? '{}')).q ?? '');
        if (String(input).includes('google.serper.dev')) sent.push(q);
        // The search for several shows two of them; nothing else is found.
        if (q.startsWith('site:linkedin.com/company (')) return reply([pageOf(names[0]), pageOf(names[1])]);
        if (q.startsWith('site:linkedin.com/')) return reply([]);
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    const state = startRound(null, { [MANUFACTURING]: 1, [LOGISTICS]: 0 });
    const seg = state.segments.find((s) => s.segment === MANUFACTURING)!;
    seg.pending = names.map((employer, i) => ({ employer, contacts: [{ name: `Person ${i}`, title: 'Plant Head', tier: 'P1', employer, location: 'Pune, Maharashtra, India', linkedin: `https://in.linkedin.com/in/person-${i}`, why: '' }] }));
    const added: string[] = [];
    await searchRound(db, svc, state, { started: Date.now(), budgetMs: 60_000, log: async () => {}, seed: 1, budgetLeft: async () => 10_000, recent: new Set(), cheaperChecks: true, sink: { add: async (c) => void added.push(c.name), save: async () => {} } });
    // One search for the first six; the one needed found there; nobody looked up on their own, no people searched.
    expect(sent).toEqual([companiesQuery(names.slice(0, 6))]);
    expect(added).toHaveLength(1);
    // The other one found waits with its page; the four not shown wait to be looked up on their own; the seventh, its turn.
    expect(seg.pending.filter((c) => c.page).map((c) => c.employer)).toEqual(names.slice(0, 2).filter((n) => !added.includes(n)));
    expect(seg.pending.filter((c) => c.alone).map((c) => c.employer)).toEqual(names.slice(2, 6));
    expect(seg.pending.map((c) => c.employer)).toContain(names[6]);
  });

  it('tallies why the companies it checked were not approved, per segment, on the report (27 Oct)', async () => {
    expect(rejectionReason({ outcome: 'approved', why: 'Fits' })).toBeNull();
    expect(rejectionReason({ outcome: undefined, why: '' })).toBeNull();
    expect(rejectionReason({ outcome: 'approved', why: "Approved, but the contact isn't confirmed on LinkedIn yet, so the draw would hold it back" })).toBe("Approved, but the contact isn't confirmed on LinkedIn");
    expect(rejectionReason({ outcome: 'no_contact', why: 'No contact found' })).toBe('No acceptable contact found');
    expect(rejectionReason({ outcome: 'waiting', why: 'Over the Google search budget' })).toBe('Not researched: over the credit limit');
    expect(rejectionReason({ outcome: 'ruled_out', why: "Not a fit: too small for the ICP's size target (200+ employees)" })).toBe('Too small');
    expect(rejectionReason({ outcome: 'ruled_out', why: 'Not a fit: deal-breaker “pharma” applies: “makes tablets”' })).toBe('A deal-breaker applies');
    expect(rejectionReason({ outcome: 'ruled_out', why: 'Not a fit: fails must-have “heavy manufacturing”: “a trading house”' })).toBe('Shown to fail a must-have');
    expect(rejectionReason({ outcome: 'ruled_out', why: "Needs review: couldn't confirm must-have “holds inventory”" })).toBe('A must-have not confirmed');
    // On the report, with the counts per segment.
    const id = await startSample(true);
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    const extra = { ...r.companies[0], key: 9001, outcome: 'ruled_out' as const, why: 'Not a fit: too small for the ICP size target' };
    const withRejects = { ...row, report: JSON.parse(JSON.stringify({ ...r, companies: [...r.companies, extra, { ...extra, key: 9002 }] })) };
    const html = renderToStaticMarkup(createElement(MorningSample, { test: withRejects, running: false, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
    expect(html).toContain('Why companies weren&#x27;t approved');
    expect(html).toMatch(/2<\/span> Too small/);
  });

  describe('Find new prospects on the one capped engine (26 Oct)', () => {
    it('finds the leads asked for within the credit limit, deals nothing, and adds the approved ones for the person chosen', async () => {
      const [parimal] = await db.select().from(users).where(eq(users.name, 'Parimal'));
      const search = await startProspectSearch(db, { wanted: { [MANUFACTURING]: 1 }, to: String(parimal.id) });
      expect(search.created).toBe(true);
      await runSourcingTest(db, morningServices(log, [], { meter: dbSearchMeter(db) }), search.id, Number.POSITIVE_INFINITY);
      const r = await reportOf(search.id);
      expect(r).toMatchObject({ phase: 'done', fresh: true, find: { to: String(parimal.id) }, hands: [] });
      expect(r.start[MANUFACTURING].need).toBe(1);
      expect(r.start[LOGISTICS]).toMatchObject({ need: 0, wanted: 0 });
      expect(r.budget).toBeLessThanOrEqual(SAMPLE_RULES.credits);
      expect(r.credits).toBeLessThanOrEqual(r.budget!);
      const approved = r.companies.filter((c) => c.outcome === 'approved');
      expect(approved.length).toBeGreaterThan(0);
      expect(r.added?.leads).toBe(approved.length);
      const added = await db.select().from(leads).where(inArray(leads.id, approved.map((c) => c.pushed!)));
      expect(added).toHaveLength(approved.length);
      expect(added.every((l) => l.status === 'Approved' && l.ownerId === parimal.id)).toBe(true);
      const html = renderToStaticMarkup(createElement(MorningSample, { test: (await db.select().from(sourcingTests).where(eq(sourcingTests.id, search.id)))[0], running: false, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
      expect(html).toContain(`Prospect search ${search.id}`);
      expect(html).toContain('approved leads into the pipeline, given to Parimal');
      expect(html).not.toContain('No active associates to deal leads to');
    });

    it('with nothing asked for, finds what the morning draw is short of; its leads go to the draw (nobody yet); one at a time', async () => {
      const search = await startProspectSearch(db, { wanted: null, to: '' });
      expect(await startProspectSearch(db, { wanted: { [LOGISTICS]: 3 }, to: 'team' })).toEqual({ id: search.id, created: false });
      await runSourcingTest(db, morningServices(log), search.id, Number.POSITIVE_INFINITY);
      const r = await reportOf(search.id);
      expect(r.fresh).toBe(false);
      expect(r.start[MANUFACTURING].need).toBe(2);
      expect(r.added?.given).toBe('');
      const added = await db.select().from(leads).where(inArray(leads.id, r.companies.filter((c) => c.pushed).map((c) => c.pushed!)));
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((l) => l.status === 'Approved' && l.ownerId === null)).toBe(true);
    });
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

  it('never spends more than its budget: 4,000 at most, a hard limit, and a company whose research reaches it waits for the next day', async () => {
    // No daily limit set (the default): 4,000. A higher one: still 4,000. A lower one: that.
    const plain = await startSample(true);
    await runSourcingTest(db, morningServices(log), plain, Number.POSITIVE_INFINITY);
    expect((await reportOf(plain)).budget).toBe(4000);
    const high = await startSample(true);
    await runSourcingTest(db, morningServices(log, [], { budget: 5000 }), high, Number.POSITIVE_INFINITY);
    expect((await reportOf(high)).budget).toBe(4000);

    // Every Serper request counted where it is sent, against budgets that stop the search at different points.
    for (const budget of [110, 115, 150, 160, 200]) {
      let sent = 0;
      const base = morningServices(log, [], { budget });
      const svc = {
        ...base,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes('google.serper.dev')) sent += JSON.parse(String(init?.body ?? '{}')).num > 10 ? 2 : 1;
          return base.fetch(input, init);
        }) as typeof fetch,
      };
      const id = await startSample(true);
      await runSourcingTest(db, svc, id, Number.POSITIVE_INFINITY);
      const r = await reportOf(id);
      expect(r.phase).toBe('done');
      expect(r.budget).toBe(budget);
      expect(sent).toBeLessThanOrEqual(budget);
      expect(r.credits).toBe(sent);
      for (const c of r.companies) expect(c.outcome).toBeDefined();
    }

    // Research that needs more than is left: the searches over the limit aren't made, and the company waits
    // for the next day rather than being kept half researched. (Forgeline with only people off the ICP's
    // lists found there, and the grouped designation searches full of people at other companies: research searches
    // every designation and each grouped search's second page.)
    const done = await reportOf(plain);
    const forgeline = done.companies.find((c) => c.page.name === 'Forgeline Components')!;
    const offList = forgeline.contacts.map((p) => ({ ...p, title: 'HR Manager', tier: '' }));
    const report: MorningSampleReport = {
      ...done,
      phase: 'research',
      companies: [{ ...forgeline, contacts: offList, outcome: undefined, why: undefined, lead: undefined, people: undefined, researchedAt: undefined }],
      hands: [],
      credits: 4000 - 26,
      budget: 4000,
    };
    const [row] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, report: JSON.parse(JSON.stringify(report)) }).returning({ id: sourcingTests.id });
    let sent = 0;
    const base = morningServices(log);
    const elsewhere = Array.from({ length: 10 }, (_, i) => ({ title: `Person ${i} - Plant Head - Other Gears`, subtitle: 'Chennai, Tamil Nadu, India · Plant Head · Other Gears', link: `https://in.linkedin.com/in/other-${i}`, snippet: '' }));
    const svc = {
      ...base,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('google.serper.dev')) sent++;
        const q = String(JSON.parse(String(init?.body ?? '{}')).q ?? '');
        if (q.startsWith('site:linkedin.com/in') && q.includes(' OR ')) return new Response(JSON.stringify({ organic: elsewhere }), { status: 200, headers: { 'content-type': 'application/json' } });
        return base.fetch(input, init);
      }) as typeof fetch,
    };
    await runSourcingTest(db, svc, row.id, Number.POSITIVE_INFINITY);
    const r = await reportOf(row.id);
    expect(r.phase).toBe('done');
    expect(sent).toBe(26);
    expect(r.credits).toBe(4000);
    expect(r.companies[0]).toMatchObject({ outcome: 'waiting', why: 'Over the Google search budget: the run would research it the next day' });
    expect([r.companies[0].lead, r.companies[0].people]).toEqual([undefined, undefined]);
  });

  it("remembers its own people searches (never the 6 am run's): the next sample leaves out those that found no new company, and finds the same", async () => {
    const sent: string[] = [];
    const svc = () => recording(morningServices(log), sent);
    const first = await startSample(true);
    await runSourcingTest(db, svc(), first, Number.POSITIVE_INFINITY);
    const one = await reportOf(first);
    // The 6 am run's memory is untouched; the sample's own is kept apart.
    expect(await db.select().from(prospectSearches)).toEqual([]);
    const memory = await db.select().from(enrichmentCache);
    const remembered = memory.filter((m) => m.key.startsWith('sample-search:v1:'));
    expect(remembered.length).toBeGreaterThan(0);
    const dead = new Set(remembered.filter((m) => (m.value as { outcomes: { fresh: number }[] }).outcomes.at(-1)!.fresh === 0).map((m) => m.key.split(':').slice(3).join(':')));
    expect(dead.size).toBeGreaterThan(0);
    // Forgeline passed: counted on the search that found it.
    expect(remembered.some((m) => (m.value as { outcomes: { kept: number }[] }).outcomes.some((o) => o.kept > 0))).toBe(true);

    sent.length = 0;
    const second = await startSample(true);
    await runSourcingTest(db, svc(), second, Number.POSITIVE_INFINITY);
    const two = await reportOf(second);
    expect(two.phase).toBe('done');
    expect(Object.values(two.skipped ?? {}).reduce((a, n) => a + n, 0)).toBeGreaterThan(0);
    expect(sent.some((q) => dead.has(normQuery(q)))).toBe(false);
    // The same leads, for fewer credits.
    expect(two.companies.filter((c) => c.outcome === 'approved').map((c) => c.page.name).sort()).toEqual(one.companies.filter((c) => c.outcome === 'approved').map((c) => c.page.name).sort());
    expect(two.credits!).toBeLessThan(one.credits!);
  });

  it("pushed, the people research found at a company count as checked on LinkedIn that day: the 8 am check doesn't look them up again", async () => {
    const { pushSampleCompanies } = await import('@/lib/sourcing/sample-run');
    const id = await startSample(true);
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const forgeline = (await reportOf(id)).companies.find((c) => c.page.name === 'Forgeline Components')!;
    expect(forgeline.researchedAt).toBeTruthy();
    await pushSampleCompanies(db, id, [forgeline.key]);
    const [lead] = await db.select().from(leads).where(eq(leads.company, 'Forgeline Components'));
    const found = await db.select().from(people).where(eq(people.leadId, lead.id));
    const others = found.filter((p) => !p.isPrimary && !p.passedAt);
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(p.checkedAt?.toISOString()).toBe(new Date(forgeline.researchedAt!).toISOString());

    // The contact check finds nothing due here, so it searches nothing.
    const searched: string[] = [];
    await verifyContacts(db, recording(morningServices(log), searched));
    expect(searched).toEqual([]);
    // Someone added since, never checked: due, and looked up.
    await db.insert(people).values({ leadId: lead.id, name: 'New Person', title: 'Plant Manager', source: 'LinkedIn' });
    await verifyContacts(db, recording(morningServices(log), searched));
    expect(searched.some((q) => q.includes('"New Person"'))).toBe(true);
  });

  it('adds the leads it dealt as approved leads, each given to the person it was dealt to, for a morning with no draw', async () => {
    const { assignSampleLeads } = await import('@/lib/sourcing/sample-run');
    const { handedOut } = await import('@/lib/draw');
    const { istDay, firstWorkingDay } = await import('@/lib/tasks');
    const id = await startSample();
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    const r = await reportOf(id);
    const dealt = r.hands.flatMap((h) => h.cards.map((c) => ({ owner: h.userId, company: cardLead(r, c)!.lead.company })));
    expect(dealt.length).toBe(3);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    const page = () => renderToStaticMarkup(createElement(MorningSample, { test: row, running: false, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
    expect(page()).toContain('Add as approved leads and assign them');

    const done = await assignSampleLeads(db, id);
    const day = r.day > istDay() ? r.day : istDay();
    expect(done).toMatchObject({ day, skipped: [] });
    expect(done!.given.reduce((a, g) => a + g.leads, 0)).toBe(3);
    for (const d of dealt) {
      const [lead] = await db.select().from(leads).where(eq(leads.company, d.company));
      // Approved, researched, with its contact and drafts, and given to the person the sample dealt it to.
      expect(lead).toMatchObject({ status: 'Approved', ownerId: d.owner, drawnOn: day });
      expect(lead.contactName).toBeTruthy();
      // Its Day 1 steps on that morning, on that person's Today.
      const steps = await db.select().from(tasks).where(eq(tasks.leadId, lead.id));
      expect(steps.length).toBe(4);
      expect(steps.every((t) => t.ownerId === d.owner && t.dueDate === firstWorkingDay(day, new Set()) && t.step === 'Day 1')).toBe(true);
      expect((await db.select().from(activities).where(eq(activities.leadId, lead.id))).some((a) => a.text.startsWith(`Given to `) && a.text.includes(`Morning Sample Run ${id}`))).toBe(true);
    }
    // Counted as that morning's hand-out, so a draw by hand then only fills what is still short.
    const hands = await handedOut(db, day);
    for (const h of r.hands) expect(Object.values(hands[String(h.userId)] ?? {}).reduce((a, n) => a + n, 0)).toBe(h.cards.length);

    // Pressed again: nothing changes.
    const before = await counts();
    expect(await assignSampleLeads(db, id)).toEqual(done);
    expect(await counts()).toEqual(before);
    const [after] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
    const html = renderToStaticMarkup(createElement(MorningSample, { test: after, running: false, earlier: [], person: 0, senderName: 'INVECK Sales Team', icps: [] }));
    expect(html).toContain('Added and assigned');
    expect(html).not.toContain('Add as approved leads and assign them');
  });

  it('leaves a lead someone already has as it is, and does nothing while the sample runs', async () => {
    const { assignSampleLeads } = await import('@/lib/sourcing/sample-run');
    const running = await startSample();
    expect(await runSourcingTest(db, morningServices(log), running, 0)).toBe('continue');
    expect(await assignSampleLeads(db, running)).toBeNull();
    await db.delete(sourcingTests).where(eq(sourcingTests.id, running));

    const id = await startSample();
    await runSourcingTest(db, morningServices(log), id, Number.POSITIVE_INFINITY);
    // Given out by hand meanwhile.
    const [someone] = await db.select().from(users).where(eq(users.name, 'Puja'));
    await db.update(leads).set({ ownerId: someone.id }).where(eq(leads.company, 'Ready Pool Co'));
    const done = await assignSampleLeads(db, id);
    expect(done!.skipped).toEqual(['Ready Pool Co']);
    expect(done!.given.reduce((a, g) => a + g.leads, 0)).toBe(2);
    expect((await db.select().from(leads).where(eq(leads.company, 'Ready Pool Co')))[0].ownerId).toBe(someone.id);
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
