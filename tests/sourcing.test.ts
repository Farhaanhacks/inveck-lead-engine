import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, prospectResults, sourcingTests } from '@/lib/db/schema';
import { DEFAULT_ICPS, LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { settingsSchema } from '@/lib/settings';
import type { Services } from '@/lib/pipeline/services';
import { bandsFor, companyPageUrl, factsQuery, hqAbroad, pageName, planQueries, readCompanyPage, screenPage, withFacts, type Known } from '@/lib/sourcing/linkedin-pages';
import { activeSourcingTest, funnelOf, isPeopleReport, peopleFunnelOf, runSourcingTest, type PeopleReport, type SourcingReport } from '@/lib/sourcing/test-run';
import { companyQuery, matchingPage, planPeopleQueries, readPerson, searchTitles } from '@/lib/sourcing/people-first';
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

  it("drops what Google cut off a long name, and reads LinkedIn's header line", () => {
    expect(pageName('Prospira India Automotive Products Pvt. Ltd., (Ex. ...')).toEqual({ name: 'Prospira India Automotive Products Pvt. Ltd.', cut: true });
    expect(pageName('Bharat Forge Limited | LinkedIn')).toEqual({ name: 'Bharat Forge Limited', cut: false });
    const p = readCompanyPage({ title: 'MEI Brakes | LinkedIn', link: 'https://uk.linkedin.com/company/mei-brakes', snippet: 'Brakes For The Long Haul. Motor Vehicle Parts Manufacturing · Sheffield, South Yorkshire · 794 followers · 501-1,000 employees' });
    expect(p).toMatchObject({ industry: 'Motor Vehicle Parts Manufacturing', hq: 'Sheffield, South Yorkshire', size: '501-1,000 employees', followers: 794 });
  });

  it("MEI Brakes: Google's first text leaves out the size; the second search, for the page's facts, brings it", () => {
    const first = readCompanyPage({
      title: 'MEI Brakes | LinkedIn',
      link: 'https://in.linkedin.com/company/mei-brakes',
      snippet: 'MEI Brakes | 794 followers on LinkedIn. Brakes For The Long Haul | MEI Brakes is a specialist Commercial Vehicle brake part manufacturer and distributor based in Sheffield, United Kingdom and Chennai, India.',
    })!;
    expect(first).toMatchObject({ size: '', hq: '', industry: '' });
    expect(factsQuery(first)).toBe('site:linkedin.com/company/mei-brakes "Company size"');
    const facts = { title: 'MEI Brakes', link: 'https://uk.linkedin.com/company/mei-brakes', snippet: 'Industry Motor Vehicle Parts Manufacturing Company size 501-1,000 employees Headquarters Sheffield, South Yorkshire Type Privately Held' };
    const other = { title: 'MEI Group | LinkedIn', link: 'https://in.linkedin.com/company/mei-group', snippet: 'Company size: 11-50 employees. Headquarters: Bengaluru, Karnataka' };
    const full = withFacts(first, [other, facts]);
    expect(full).toMatchObject({ name: 'MEI Brakes', size: '501-1,000 employees', industry: 'Motor Vehicle Parts Manufacturing', hq: 'Sheffield, South Yorkshire' });
    // Based in England, with a plant in Chennai: a prospect for the Chennai site.
    expect(hqAbroad(full.hq)).toBe(true);
    expect(screenPage(full, MANUFACTURING, MFG_SIZE, none)).toEqual({ pass: true, note: 'headquartered abroad (Sheffield, South Yorkshire), with a site in Chennai; size 501-1,000 employees' });
    // Nothing found for the page: it stays as it was.
    expect(withFacts(first, [other])).toEqual(first);
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
    expect(screenPage(p('Company size: 501-1,000 employees. Headquarters: Sheffield, South Yorkshire'), MANUFACTURING, MFG_SIZE, none)).toMatchObject({ pass: false, reason: 'abroad' });
    expect(hqAbroad('Jamnagar, Gujarat')).toBe(false);
    expect(hqAbroad('Pune')).toBe(false);
    expect(screenPage(p('Company size: 11-50 employees. Headquarters: Rajkot, Gujarat'), MANUFACTURING, MFG_SIZE, none)).toMatchObject({ pass: false, reason: 'small', note: `too small: 11-50 employees against ${MFG_SIZE}` });
    expect(screenPage(p('Industry: Pharmaceutical Manufacturing. Company size: 501-1,000 employees'), MANUFACTURING, MFG_SIZE, none)).toMatchObject({ pass: false, reason: 'industry' });
    expect(screenPage(p('Industry: Industrial Machinery Manufacturing. Company size: 51-200 employees. Headquarters: Pune'), MANUFACTURING, MFG_SIZE, none)).toEqual({ pass: true, note: `borderline size: 51-200 employees against ${MFG_SIZE}` });
    expect(screenPage(p('Industry: Industrial Machinery Manufacturing'), MANUFACTURING, MFG_SIZE, none)).toEqual({ pass: true, note: 'size not shown' });
  });

  it("only companies shown to be in the ICP's industries pass (test 4, 19 Oct: OYO, Justdial, BigBasket…)", () => {
    const size = 'Company size: 5,001-10,000 employees. Headquarters: Gurugram, Haryana';
    const out = (facts: string, name: string) => screenPage(p(`${facts}. ${size}`, name), MANUFACTURING, MFG_SIZE, none);
    for (const [label, name] of [
      ['Hospitality', 'OYO'],
      ['Information Services', 'Justdial'],
      ['Staffing and Recruiting', 'Live Connections'],
      ['Glass, Ceramics and Concrete Manufacturing', 'RAK Ceramics'],
      ['Electrical Equipment Manufacturing', 'S&S Power Switchgear Equipment'],
      ['Medical Equipment Manufacturing', 'vTitan Corporation'],
      ['Renewable Energy Equipment Manufacturing', 'Suzlon Group'],
    ]) {
      expect(out(`Industry: ${label}`, name)).toMatchObject({ pass: false, reason: 'industry', note: `industry not in the ICP: ${label}` });
    }
    // No industry shown: out unless the page itself says what it makes in the ICP's words.
    expect(out('Online grocery delivered to your door', 'BIG BASKET (BB)')).toMatchObject({ pass: false, reason: 'industry', note: 'industry not shown, and its page mentions "grocery"' });
    expect(out('We build better teams', 'TRYANO')).toMatchObject({ pass: false, reason: 'industry', note: "industry not shown on its LinkedIn page, and nothing on it shows it's in the ICP" });
    expect(out('Precision castings and machined parts for tractors', 'Acme Castings')).toMatchObject({ pass: true });
    // "Manufacturing" alone says nothing: the page decides.
    expect(out('Industry: Manufacturing. Leading maker of closed-die forgings', 'Acme Forge')).toMatchObject({ pass: true });
    expect(out('Industry: Manufacturing. India\'s favourite FMCG brands', 'Acme Foods')).toMatchObject({ pass: false, reason: 'industry' });
    // The ICP's own industries pass, by LinkedIn's current and older labels.
    for (const label of ['Railroad Equipment Manufacturing', 'Engines and Power Transmission Equipment Manufacturing', 'Mechanical Or Industrial Engineering', 'Defense and Space Manufacturing', 'Automotive', 'Primary Metal Manufacturing']) {
      expect(out(`Industry: ${label}`, 'Some Works')).toMatchObject({ pass: true });
    }
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

  function fakeSerper(searches: string[], pages: unknown[] = PAGES, staffOf: Record<string, unknown[]> = STAFF, facts: Record<string, unknown[]> = {}): Services {
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchFn = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      const q = String(JSON.parse(String(init.body)).q);
      searches.push(q);
      // A second look at one page: site:linkedin.com/company/<its address> "Company size".
      const one = /^site:linkedin\.com\/company\/(\S+) /.exec(q)?.[1];
      if (one) return json({ organic: facts[one] ?? [] });
      if (q.startsWith('site:linkedin.com/company')) return json({ organic: pages });
      const staff = Object.entries(staffOf).find(([name]) => q.includes(`"${name}`))?.[1] ?? [];
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

  it('looks up the size and headquarters Google left out, screens again, and checks a company based abroad at its Indian site', async () => {
    const pages = [
      { title: 'MEI Brakes | LinkedIn', link: 'https://in.linkedin.com/company/mei-brakes', snippet: 'MEI Brakes | 794 followers on LinkedIn. Brakes For The Long Haul | MEI Brakes is a specialist Commercial Vehicle brake part manufacturer based in Sheffield, United Kingdom and Chennai, India.' },
      { title: 'Prospira India Automotive Products Pvt. Ltd., (Ex. ...', link: 'https://in.linkedin.com/company/prospira-india', snippet: 'Anti-vibration components for vehicles.' },
      { title: 'Little Gears | LinkedIn', link: 'https://in.linkedin.com/company/little-gears', snippet: 'Gears for tractors, Rajkot.' },
    ];
    const facts = {
      'mei-brakes': [{ title: 'MEI Brakes', link: 'https://uk.linkedin.com/company/mei-brakes', snippet: 'Industry Motor Vehicle Parts Manufacturing Company size 501-1,000 employees Headquarters Sheffield, South Yorkshire Type Privately Held' }],
      'prospira-india': [{ title: 'Prospira India Automotive Products Pvt. Ltd., (Ex. ...', link: 'https://in.linkedin.com/company/prospira-india', snippet: 'Industry: Motor Vehicle Parts Manufacturing; Company size: 1,001-5,000 employees; Headquarters: Pune, Maharashtra' }],
      'little-gears': [{ title: 'Little Gears | LinkedIn', link: 'https://in.linkedin.com/company/little-gears', snippet: 'Company size: 11-50 employees. Headquarters: Rajkot, Gujarat' }],
    };
    const staff = {
      'MEI Brakes': [{ title: 'Suresh Kumar - Plant Head - MEI Brakes | LinkedIn', subtitle: 'Chennai, Tamil Nadu, India · Plant Head · MEI Brakes', link: 'https://in.linkedin.com/in/suresh-k', snippet: '' }],
    };
    const [test] = await db.insert(sourcingTests).values({ segment: MANUFACTURING, companies: 10 }).returning();
    const searches: string[] = [];
    await runSourcingTest(db, fakeSerper(searches, pages, staff, facts), test.id);
    const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, test.id));
    const report = row.report as SourcingReport;
    const byName = Object.fromEntries(report.companies.map((c) => [c.name, c]));
    expect(byName['MEI Brakes']).toMatchObject({ size: '501-1,000 employees', hq: 'Sheffield, South Yorkshire', screen: 'pass', facts: '501-1,000 employees, Motor Vehicle Parts Manufacturing, HQ Sheffield, South Yorkshire' });
    expect(byName['MEI Brakes'].people).toMatchObject({ outcome: 'reachable', p1: 1 });
    expect(searches).toContain('site:linkedin.com/in "MEI Brakes" Chennai');
    expect(searches.some((q) => q.includes('Sheffield'))).toBe(false);
    // The name Google cut short is searched as far as it goes.
    expect(byName['Prospira India Automotive Products Pvt. Ltd.']).toMatchObject({ size: '1,001-5,000 employees', hq: 'Pune, Maharashtra', screen: 'pass' });
    expect(searches.some((q) => q.startsWith('site:linkedin.com/in "Prospira India Automotive Products" Pune'))).toBe(true);
    // Too small once its size is known: out, and not searched for people.
    expect(byName['Little Gears']).toMatchObject({ screen: 'small' });
    expect(byName['Little Gears'].people).toBeUndefined();
    expect(report.searches.facts).toBe(3);
    expect(report.searches.find + report.searches.facts! + report.searches.people).toBe(searches.length);
    expect(report.queries.reduce((n, q) => n + q.passed, 0)).toBe(2);
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

describe('people first', () => {
  const mfg = DEFAULT_ICPS.find((i) => i.segment === MANUFACTURING)!;
  const log = DEFAULT_ICPS.find((i) => i.segment === LOGISTICS)!;
  const person = (name: string, role: string, company: string, place: string, slug = name.toLowerCase().replace(/\s+/g, '-')) => ({
    title: `${name} - ${role} - ${company} | LinkedIn`,
    link: `https://in.linkedin.com/in/${slug}`,
    subtitle: `${place} · ${role} · ${company}`,
    snippet: '',
  });

  it('searches the titles on the ICP lists, plant heads first, never a bare level, always with a word for the industry', () => {
    const titles = searchTitles(mfg);
    expect(titles.slice(0, 2)).toEqual(['Plant Head', 'Plant Manager']);
    expect(titles).toContain('Head of Supply Chain');
    expect(titles).not.toContain('General Manager');
    expect(titles).not.toContain('DGM');
    expect(searchTitles(log)).toContain('National Head');
    const plan = planPeopleQueries(MANUFACTURING, mfg, 24, 1);
    expect(plan).toHaveLength(24);
    expect(new Set(plan.map((p) => p.q)).size).toBe(24);
    // A title and a place alone brought hotels and app companies (test 4, 19 Oct): every search names the industry.
    for (const p of plan) expect(p.q).toMatch(/^site:linkedin\.com\/in "[^"]+" "[^"]+" \S/);
    expect(plan.every((p) => p.form === 'industry')).toBe(true);
    expect(plan[0].q.startsWith('site:linkedin.com/in "Plant Head" ')).toBe(true);
  });

  it("reads each person's current employer, and keeps only people on the lists, in India, with a current job", () => {
    expect(readPerson(person('Ravi Kulkarni', 'Plant Head', 'Acme Forgings Pvt Ltd', 'Pune, Maharashtra, India'), mfg)).toMatchObject({ name: 'Ravi Kulkarni', title: 'Plant Head', tier: 'P1', employer: 'Acme Forgings Pvt Ltd', why: '' });
    expect(readPerson(person('John Smith', 'Plant Manager', 'Acme Corp', 'Detroit, Michigan, United States'), mfg)?.why).toMatch(/outside India/);
    expect(readPerson(person('Hari Rao', 'HR Manager', 'Acme Forgings Pvt Ltd', 'Pune, Maharashtra, India'), mfg)).toMatchObject({ tier: '', why: "HR Manager: not on the ICP's lists" });
    expect(readPerson(person('Asha Nair', 'Consultant', 'Self-employed', 'Pune, Maharashtra, India'), mfg)?.why).toBe('no current employer shown');
    expect(readPerson({ title: 'Acme Forgings | LinkedIn', link: 'https://in.linkedin.com/company/acme-forgings' }, mfg)).toBeNull();
    // Profiles the contact search leaves out (another country's LinkedIn, no name) are reported, not a crash (test 3, 19 Oct).
    expect(readPerson({ ...person('Tom Hill', 'Plant Manager', 'Acme UK Ltd', 'Sheffield, England, United Kingdom'), link: 'https://uk.linkedin.com/in/tom-hill' }, mfg)).toMatchObject({ employer: 'Acme UK Ltd', why: 'based outside India (a profile on uk.linkedin.com)' });
    expect(readPerson({ title: ' - Plant Head - Acme Forgings | LinkedIn', link: 'https://in.linkedin.com/in/x', subtitle: 'Pune, Maharashtra, India · Plant Head · Acme Forgings' }, mfg)).toMatchObject({ why: 'no name shown' });
  });

  it("finds the company's own page by the name its people write, never a longer name that only starts the same", () => {
    const page = (slug: string, name: string) => ({ title: `${name} | LinkedIn`, link: `https://in.linkedin.com/company/${slug}`, snippet: 'Company size: 201-500 employees' });
    expect(matchingPage([page('acme-forgings-india', 'Acme Forgings India')], 'Acme Forgings Pvt Ltd')?.name).toBe('Acme Forgings India');
    expect(matchingPage([page('bharat-gears-ltd', 'Bharat Gears Limited Faridabad')], 'Bharat Gears')?.name).toBe('Bharat Gears Limited Faridabad');
    expect(matchingPage([page('tata-motors', 'Tata Motors')], 'Tata')).toBeNull();
    expect(companyQuery('Acme Forgings Pvt Ltd')).toBe('site:linkedin.com/company "Acme Forgings"');
  });

  describe('a run', () => {
    let db: Db;
    beforeEach(async () => {
      process.env.DATABASE_URL = 'memory://';
      resetDbForTests();
      db = await getDb();
    });

    const PEOPLE = [
      person('Ravi Kulkarni', 'Plant Head', 'Acme Forgings Pvt Ltd', 'Pune, Maharashtra, India'),
      person('Meena Joshi', 'Store Manager', 'Acme Forgings Pvt Ltd', 'Pune, Maharashtra, India'),
      person('Suresh Kumar', 'Plant Head', 'MEI Brakes', 'Chennai, Tamil Nadu, India'),
      person('Kiran Patil', 'Plant Head', 'Tiny Works', 'Ludhiana, Punjab, India'),
      person('Anil Shah', 'Plant Head', 'Known Forge', 'Rajkot, Gujarat, India'),
      person('Priya Rao', 'Plant Head', 'Pharma Co', 'Hyderabad, Telangana, India'),
      person('Sam Das', 'Plant Head', 'Ghost Gears', 'Kolkata, West Bengal, India'),
      person('Hari Rao', 'HR Manager', 'Acme Forgings Pvt Ltd', 'Pune, Maharashtra, India'),
      person('John Smith', 'Plant Manager', 'Acme Corp', 'Detroit, Michigan, United States'),
      { ...person('Tom Hill', 'Plant Manager', 'Acme UK Ltd', 'Sheffield, England, United Kingdom'), link: 'https://uk.linkedin.com/in/tom-hill' },
    ];
    const pageOf = (slug: string, name: string, snippet: string) => [{ title: `${name} | LinkedIn`, link: `https://in.linkedin.com/company/${slug}`, snippet }];
    const BY_NAME: Record<string, unknown[]> = {
      'Acme Forgings': pageOf('acme-forgings', 'Acme Forgings Pvt Ltd', 'Industry: Motor Vehicle Parts Manufacturing. Company size: 201-500 employees. Headquarters: Pune, Maharashtra'),
      'MEI Brakes': pageOf('mei-brakes', 'MEI Brakes', 'MEI Brakes | 794 followers on LinkedIn. Brakes For The Long Haul.'),
      'Tiny Works': pageOf('tiny-works', 'Tiny Works', 'Industry: Machinery Manufacturing. Company size: 11-50 employees. Headquarters: Ludhiana, Punjab'),
      'Pharma Co': pageOf('pharma-co', 'Pharma Co', 'Industry: Pharmaceutical Manufacturing. Company size: 1,001-5,000 employees. Headquarters: Hyderabad, Telangana'),
    };
    const FACTS: Record<string, unknown[]> = {
      'mei-brakes': pageOf('mei-brakes', 'MEI Brakes', 'Industry Motor Vehicle Parts Manufacturing Company size 501-1,000 employees Headquarters Sheffield, South Yorkshire Type Privately Held'),
    };

    function fake(searches: string[]): Services {
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      const fetchFn = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
        const q = String(JSON.parse(String(init.body)).q);
        searches.push(q);
        if (q.startsWith('site:linkedin.com/in ')) return json({ organic: PEOPLE });
        const one = /^site:linkedin\.com\/company\/(\S+) /.exec(q)?.[1];
        if (one) return json({ organic: FACTS[one] ?? [] });
        const name = /^site:linkedin\.com\/company "([^"]+)"/.exec(q)?.[1] ?? '';
        return json({ organic: BY_NAME[name] ?? [] });
      }) as typeof fetch;
      return { fetch: fetchFn, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}) };
    }

    it('finds people, checks their companies, and keeps only the fitting new ones, each with its contacts; nothing else is saved', async () => {
      await db.insert(leads).values({ company: 'Known Forge Ltd', segment: MANUFACTURING, source: 'test' });
      const leadsBefore = (await db.select().from(leads)).length;
      const [test] = await db.insert(sourcingTests).values({ segment: MANUFACTURING, mode: 'people', companies: 10 }).returning();
      const searches: string[] = [];
      await runSourcingTest(db, fake(searches), test.id);
      const [row] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, test.id));
      expect(row.status).toBe('done');
      const report = row.report as PeopleReport;
      expect(isPeopleReport(report)).toBe(true);
      const by = Object.fromEntries(report.companies.map((c) => [c.employer, c]));
      expect(by['Acme Forgings Pvt Ltd']).toMatchObject({ screen: 'pass' });
      expect(by['Acme Forgings Pvt Ltd'].contacts.map((p) => [p.name, p.tier])).toEqual([
        ['Ravi Kulkarni', 'P1'],
        ['Meena Joshi', 'P3'],
      ]);
      // Based in England, its plant head in Chennai: a prospect for that site.
      expect(by['MEI Brakes']).toMatchObject({ screen: 'pass', note: 'headquartered abroad (Sheffield, South Yorkshire), with a site in Chennai; size 501-1,000 employees' });
      expect(by['Tiny Works']).toMatchObject({ screen: 'small' });
      expect(by['Pharma Co']).toMatchObject({ screen: 'industry' });
      expect(by['Known Forge']).toMatchObject({ screen: 'known' });
      expect(by['Ghost Gears']).toMatchObject({ screen: 'nopage' });
      expect(peopleFunnelOf(report)).toEqual({ profiles: 10, contacts: 7, companies: 6, known: 1, checked: 5, nopage: 1, abroad: 0, small: 1, industry: 1, ready: 2, readyWithP1: 2, unchecked: 0 });
      // The known company isn't looked up; MEI Brakes' size needed a second search.
      expect(searches.some((q) => q.includes('"Known Forge"'))).toBe(false);
      expect(report.searches).toMatchObject({ companies: 5, facts: 1 });
      expect(report.searches.people + report.searches.companies + report.searches.facts).toBe(searches.length);
      expect((await db.select().from(leads)).length).toBe(leadsBefore);
    });
  });
});
