import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, prospectResults, sourcingTests } from '@/lib/db/schema';
import { DEFAULT_ICPS, LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { settingsSchema } from '@/lib/settings';
import type { Services } from '@/lib/pipeline/services';
import { bandsFor, companyPageUrl, planQueries, readCompanyPage, screenPage, type Known } from '@/lib/sourcing/linkedin-pages';
import { activeSourcingTest, funnelOf, runSourcingTest, type SourcingReport } from '@/lib/sourcing/test-run';
import { employeeTarget } from '@/lib/pipeline/fit';

const MFG_SIZE = DEFAULT_ICPS.find((i) => i.segment === MANUFACTURING)!.companySize;
const LOG_SIZE = DEFAULT_ICPS.find((i) => i.segment === LOGISTICS)!.companySize;
const none: Known = { names: new Set(), domains: new Set() };

const page = (slug: string, name: string, facts: string) => ({ title: `${name} | LinkedIn`, link: `https://in.linkedin.com/company/${slug}`, snippet: `${name} | 1,200 followers on LinkedIn. ${facts}` });

describe('reading a LinkedIn company page from Google', () => {
  it('takes the name, size, industry, headquarters and website', () => {
    const p = readCompanyPage(page('acme-forgings', 'Acme Forgings Pvt Ltd', 'Closed-die forgings for auto OEMs. Industry: Motor Vehicle Parts Manufacturing; Company size: 201-500 employees; Headquarters: Pune, Maharashtra; Website: http://www.acmeforgings.in'));
    expect(p).toMatchObject({
      name: 'Acme Forgings Pvt Ltd',
      url: 'https://www.linkedin.com/company/acme-forgings',
      size: '201-500 employees',
      industry: 'Motor Vehicle Parts Manufacturing',
      hq: 'Pune, Maharashtra',
      website: 'http://www.acmeforgings.in',
      followers: 1200,
    });
  });

  it('reads the comma-separated form Google also shows, and ignores prose', () => {
    const p = readCompanyPage(page('processblast', 'Processblast Engineering', 'Serving the steel industry since 1990. Industry Machinery Manufacturing, Company size 201-500 employees, Headquarters Kolkata, West Bengal'));
    expect(p).toMatchObject({ industry: 'Machinery Manufacturing', size: '201-500 employees', hq: 'Kolkata, West Bengal' });
    expect(readCompanyPage(page('quiet', 'Quiet Gears', 'We serve the auto industry with gears.'))).toMatchObject({ industry: '', hq: '', size: '' });
  });

  it('only company pages count: not posts, jobs, showcase pages or people', () => {
    expect(companyPageUrl('https://in.linkedin.com/company/acme-forgings/')).toBe('https://www.linkedin.com/company/acme-forgings');
    expect(companyPageUrl('https://www.linkedin.com/company/Acme-Forgings?trk=x')).toBe('https://www.linkedin.com/company/acme-forgings');
    expect(companyPageUrl('https://in.linkedin.com/company/acme-forgings/jobs')).toBe('');
    expect(companyPageUrl('https://in.linkedin.com/posts/acme-forgings_new-plant')).toBe('');
    expect(companyPageUrl('https://in.linkedin.com/showcase/acme-rings')).toBe('');
    expect(readCompanyPage({ title: 'Ravi Shah - Plant Head - Acme | LinkedIn', link: 'https://in.linkedin.com/in/ravi-shah' })).toBeNull();
  });
});

describe('the searches', () => {
  it('names only the bands above the size target', () => {
    expect(bandsFor(employeeTarget(MFG_SIZE))).toEqual(['201-500', '501-1,000', '1,001-5,000', '5,001-10,000', '10,001+']);
    expect(bandsFor(employeeTarget(LOG_SIZE))).toEqual(['51-200', '201-500', '501-1,000', '1,001-5,000', '5,001-10,000', '10,001+']);
  });

  it('varies keyword and place, keeps every fourth search open, and differs from one test to the next', () => {
    const plan = planQueries(MANUFACTURING, MFG_SIZE, 24, 1);
    expect(plan).toHaveLength(24);
    expect(new Set(plan.map((p) => p.q)).size).toBe(24);
    expect(new Set(plan.map((p) => p.keyword)).size).toBe(16);
    expect(plan.filter((p) => p.form === 'open')).toHaveLength(6);
    for (const p of plan) {
      expect(p.q.startsWith('site:linkedin.com/company ')).toBe(true);
      expect(p.q.includes('"51-200 employees"')).toBe(false);
      expect(p.q.includes('"201-500 employees"')).toBe(p.form === 'band');
    }
    expect(planQueries(MANUFACTURING, MFG_SIZE, 24, 2).map((p) => p.q)).not.toEqual(plan.map((p) => p.q));
    expect(planQueries(LOGISTICS, LOG_SIZE, 4, 1)[0].q).toContain('"51-200 employees"');
  });
});

describe('the screen', () => {
  const p = (facts: string, name = 'Acme Forgings') => readCompanyPage(page('acme', name, facts))!;

  it('rules out a company abroad, one far too small, and one outside the industries; keeps a borderline one', () => {
    expect(screenPage(p('Company size: 1,001-5,000 employees. Headquarters: Gothenburg, Sweden'), MANUFACTURING, MFG_SIZE, none)).toMatchObject({ pass: false, reason: 'abroad' });
    expect(screenPage(p('Company size: 11-50 employees. Headquarters: Rajkot, Gujarat'), MANUFACTURING, MFG_SIZE, none)).toMatchObject({ pass: false, reason: 'small', note: `too small: 11-50 employees against ${MFG_SIZE}` });
    expect(screenPage(p('Industry: Pharmaceutical Manufacturing. Company size: 501-1,000 employees'), MANUFACTURING, MFG_SIZE, none)).toMatchObject({ pass: false, reason: 'industry' });
    expect(screenPage(p('Industry: Industrial Machinery Manufacturing. Company size: 51-200 employees. Headquarters: Pune'), MANUFACTURING, MFG_SIZE, none)).toEqual({ pass: true, note: `borderline size: 51-200 employees against ${MFG_SIZE}` });
    expect(screenPage(p('Industry: Industrial Machinery Manufacturing'), MANUFACTURING, MFG_SIZE, none)).toEqual({ pass: true, note: 'size not shown' });
  });

  it('3PL: consumer delivery is out, a B2B warehousing company is in', () => {
    expect(screenPage(p('Industry: Freight and Package Transportation. Company size: 1,001-5,000 employees. Fast courier and last-mile delivery', 'Zoom Couriers'), LOGISTICS, LOG_SIZE, none)).toMatchObject({ pass: false, reason: 'industry' });
    expect(screenPage(p('Industry: Warehousing and Storage. Company size: 201-500 employees. Multi-client warehousing for manufacturers', 'Stockwell 3PL'), LOGISTICS, LOG_SIZE, none)).toMatchObject({ pass: true });
  });

  it('a company INVECK already has, by name or by website, is not new', () => {
    const known: Known = { names: new Set(['acmeforgings']), domains: new Set(['bharatgears.com']) };
    expect(screenPage(p('Company size: 201-500 employees', 'Acme Forgings Pvt Ltd'), MANUFACTURING, MFG_SIZE, known)).toMatchObject({ pass: false, reason: 'known' });
    expect(screenPage(p('Company size: 201-500 employees. Website: https://www.bharatgears.com', 'BGL'), MANUFACTURING, MFG_SIZE, known)).toMatchObject({ pass: false, reason: 'known' });
  });
});

describe('a test run', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  const PAGES = [
    page('acme-forgings', 'Acme Forgings Pvt Ltd', 'Industry: Motor Vehicle Parts Manufacturing. Company size: 201-500 employees. Headquarters: Pune, Maharashtra'),
    page('solo-engineering', 'Solo Engineering', 'Industry: Industrial Machinery Manufacturing. Company size: 501-1,000 employees. Headquarters: Rajkot, Gujarat'),
    page('silent-castings', 'Silent Castings', 'Industry: Machinery Manufacturing. Company size: 1,001-5,000 employees. Headquarters: Coimbatore, Tamil Nadu'),
    page('tiny-works', 'Tiny Works', 'Industry: Machinery Manufacturing. Company size: 11-50 employees. Headquarters: Ludhiana, Punjab'),
    page('known-forge', 'Known Forge Ltd', 'Industry: Machinery Manufacturing. Company size: 201-500 employees. Headquarters: Pune, Maharashtra'),
    page('skf', 'SKF Group', 'Industry: Industrial Machinery Manufacturing. Company size: 10,001+ employees. Headquarters: Gothenburg, Sweden'),
    { title: 'Ravi Kulkarni - Plant Head - Acme Forgings | LinkedIn', link: 'https://in.linkedin.com/in/ravi-k', snippet: '' },
  ];
  const STAFF: Record<string, unknown[]> = {
    'Acme Forgings': [
      { title: 'Ravi Kulkarni - Plant Head - Acme Forgings Pvt Ltd | LinkedIn', subtitle: 'Pune, Maharashtra, India · Plant Head · Acme Forgings Pvt Ltd', link: 'https://in.linkedin.com/in/ravi-k', snippet: '' },
      { title: 'Meena Joshi - Store Manager - Acme Forgings Pvt Ltd | LinkedIn', subtitle: 'Pune, Maharashtra, India · Store Manager · Acme Forgings Pvt Ltd', link: 'https://in.linkedin.com/in/meena-j', snippet: '' },
    ],
    'Solo Engineering': [{ title: 'Harish Patel - Managing Director - Solo Engineering | LinkedIn', subtitle: 'Rajkot, Gujarat, India · Managing Director · Solo Engineering', link: 'https://in.linkedin.com/in/harish-p', snippet: '' }],
  };

  function fakeSerper(searches: string[]): Services {
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchFn = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      const q = String(JSON.parse(String(init.body)).q);
      searches.push(q);
      if (q.startsWith('site:linkedin.com/company')) return json({ organic: PAGES });
      const staff = Object.entries(STAFF).find(([name]) => q.includes(`"${name}`))?.[1] ?? [];
      return json({ organic: staff });
    }) as typeof fetch;
    return { fetch: fetchFn, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
  }

  it('finds, screens and checks companies for people, and saves nothing but its report', async () => {
    await db.insert(leads).values({ company: 'Known Forge', segment: MANUFACTURING, source: 'test' });
    const leadsBefore = (await db.select().from(leads)).length;
    const [test] = await db.insert(sourcingTests).values({ segment: MANUFACTURING, companies: 10 }).returning();
    const searches: string[] = [];
    await runSourcingTest(db, fakeSerper(searches), test.id);

    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, test.id));
    expect(row.status).toBe('done');
    const report = row.report as SourcingReport;
    const byName = Object.fromEntries(report.companies.map((c) => [c.name, c]));
    // Each page once, however many searches found it.
    expect(report.companies).toHaveLength(6);
    expect(byName['Tiny Works']).toMatchObject({ screen: 'small' });
    expect(byName['Known Forge Ltd']).toMatchObject({ screen: 'known' });
    expect(byName['SKF Group']).toMatchObject({ screen: 'abroad' });
    expect(byName['Acme Forgings Pvt Ltd'].people).toMatchObject({ outcome: 'reachable', acceptable: 2, p1: 1 });
    expect(byName['Acme Forgings Pvt Ltd'].people!.best.map((p) => [p.name, p.tier])).toEqual([
      ['Ravi Kulkarni', 'P1'],
      ['Meena Joshi', 'P3'],
    ]);
    expect(byName['Solo Engineering'].people).toMatchObject({ outcome: 'top_only', acceptable: 0 });
    expect(byName['Silent Castings'].people).toMatchObject({ outcome: 'nobody', staff: 0 });
    expect(funnelOf(report)).toMatchObject({ found: 6, passed: 3, small: 1, known: 1, abroad: 1, checked: 3, reachable: 1, withP1: 1, topOnly: 1, nobody: 1 });
    // Only the staff searches: no designation one at a time, no leadership search.
    const staffSearches = searches.filter((q) => q.startsWith('site:linkedin.com/in'));
    expect(staffSearches.some((q) => q.includes('"Plant Head"') || q.includes('owner OR'))).toBe(false);
    expect(report.searches.find + report.searches.people).toBe(searches.length);
    expect(report.searches.people).toBe(staffSearches.length);
    // Nothing else written.
    expect((await db.select().from(leads)).length).toBe(leadsBefore);
    expect(await db.select().from(prospectResults)).toEqual([]);
  });

  it('fails with a reason when search is down, and a test left running too long is marked stopped', async () => {
    const [test] = await db.insert(sourcingTests).values({ segment: LOGISTICS }).returning();
    const down: Services = { fetch: (async () => new Response('{"message":"Not enough credits"}', { status: 400 })) as typeof fetch, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    await runSourcingTest(db, down, test.id);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, test.id));
    expect(row).toMatchObject({ status: 'failed' });
    expect(row.error).toContain('Not enough credits');

    const [old] = await db.insert(sourcingTests).values({ segment: MANUFACTURING, startedAt: new Date(Date.now() - 20 * 60_000) }).returning();
    expect(await activeSourcingTest(db)).toBeNull();
    const [stale] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, old.id));
    expect(stale.status).toBe('failed');
    const [fresh] = await db.insert(sourcingTests).values({ segment: MANUFACTURING }).returning();
    expect((await activeSourcingTest(db))?.id).toBe(fresh.id);
  });
});
