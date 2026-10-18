import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db';
import { clients, icps, knownCompanies, leads, sourcingTests, type Icp, type SourcingTest } from '../db/schema';
import { DEFAULT_ICPS } from '../db/seed';
import { googleSearch, mapLimit, type SerperResult, type Services } from '../pipeline/services';
import { searchLinkedIn } from '../pipeline/contacts';
import { registerFirmWebsite } from '../pipeline/employer';
import { errorMessage, normCompany, rootDomain } from '../pipeline/text';
import { tierOf } from '../tiers';
import { planQueries, readCompanyPage, screenPage, sizeRank, SOURCING_SEGMENTS, type CompanyPage, type Known, type PlannedQuery, type SourcingSegment } from './linkedin-pages';

/**
 * The sourcing test: finds companies through their LinkedIn pages, screens them on what the page
 * shows (size, industry, headquarters, already known to INVECK), then checks whether anyone reachable
 * works at the ones that pass (their staff on LinkedIn, no research and no AI). It writes only its
 * report: no lead, no prospect history, nothing sent. What it measures is how many fresh, right-sized
 * companies with a reachable contact a number of searches turns up.
 */

export const SOURCING_LIMITS = {
  /** Google searches for company pages, and second pages of those that came back full of new pages. */
  searches: 24,
  secondPages: 8,
  /** Companies checked for people: the default, and the range allowed. */
  companies: 30,
  minCompanies: 5,
  maxCompanies: 40,
  /** The test stops checking people after this long (the server allows 300s). */
  seconds: 240,
  /** A test still "running" after this long was stopped by the server's time limit. */
  staleMinutes: 8,
} as const;

export type QueryReport = { q: string; form: PlannedQuery['form']; page: number; results: number; pages: number; newPages: number; passed: number; error?: string };
export type PeopleOutcome = 'reachable' | 'top_only' | 'staff_only' | 'nobody' | 'failed';
export type PersonFound = { name: string; title: string; tier: string; linkedin: string };
export type CompanyReport = CompanyPage & {
  query: string;
  screen: 'pass' | 'abroad' | 'small' | 'industry' | 'known';
  note: string;
  people?: { outcome: PeopleOutcome; staff: number; acceptable: number; p1: number; best: PersonFound[]; top: PersonFound[]; searches: number; error?: string; log: string[] };
};
export type SourcingReport = {
  segment: string;
  companySize: string;
  queries: QueryReport[];
  companies: CompanyReport[];
  searches: { find: number; people: number };
  seconds: number;
  stoppedEarly?: string;
};

export type Funnel = {
  found: number;
  abroad: number;
  small: number;
  industry: number;
  known: number;
  passed: number;
  checked: number;
  reachable: number;
  withP1: number;
  topOnly: number;
  staffOnly: number;
  nobody: number;
  failed: number;
};

/** The counts at each step of the funnel. */
export function funnelOf(report: Pick<SourcingReport, 'companies'>): Funnel {
  const cs = report.companies;
  const by = (s: CompanyReport['screen']) => cs.filter((c) => c.screen === s).length;
  const out = (o: PeopleOutcome) => cs.filter((c) => c.people?.outcome === o).length;
  return {
    found: cs.length,
    abroad: by('abroad'),
    small: by('small'),
    industry: by('industry'),
    known: by('known'),
    passed: by('pass'),
    checked: cs.filter((c) => c.people).length,
    reachable: out('reachable'),
    withP1: cs.filter((c) => c.people?.outcome === 'reachable' && c.people.p1 > 0).length,
    topOnly: out('top_only'),
    staffOnly: out('staff_only'),
    nobody: out('nobody'),
    failed: out('failed'),
  };
}

type SearchIcp = Pick<Icp, 'segment' | 'industries' | 'companySize' | 'targetTitles' | 'p2Titles' | 'p3Titles' | 'avoidTitles'>;

/** The segment's ICP as INVECK has it now (the starting one when it was never saved). */
async function icpFor(db: Db, segment: SourcingSegment): Promise<SearchIcp> {
  const [row] = await db.select().from(icps).where(eq(icps.segment, segment)).orderBy(desc(icps.active), icps.id).limit(1);
  return row ?? DEFAULT_ICPS.find((i) => i.segment === segment)!;
}

/** Every company INVECK already has: leads in any state (by either name), clients, and its own lead lists. */
export async function knownToInveck(db: Db): Promise<Known> {
  const [ls, cs, ks] = await Promise.all([
    db.select({ company: leads.company, nameAsFound: leads.nameAsFound, website: leads.website }).from(leads),
    db.select({ company: clients.company, website: clients.website }).from(clients),
    db.select({ company: knownCompanies.company, website: knownCompanies.website }).from(knownCompanies),
  ]);
  const names = new Set([...ls.flatMap((l) => [l.company, l.nameAsFound]), ...cs.map((c) => c.company), ...ks.map((k) => k.company)].map(normCompany).filter(Boolean));
  const domains = new Set([...ls, ...cs, ...ks].map((x) => rootDomain(x.website)).filter(Boolean));
  return { names, domains };
}

/** The test now running, if any. A test left "running" past the time limit is marked as stopped first. */
export async function activeSourcingTest(db: Db): Promise<SourcingTest | null> {
  await db
    .update(sourcingTests)
    .set({ status: 'failed', error: "Stopped before finishing (the server's time limit). The report shows what it got to.", finishedAt: new Date() })
    .where(and(eq(sourcingTests.status, 'running'), lt(sourcingTests.startedAt, new Date(Date.now() - SOURCING_LIMITS.staleMinutes * 60_000))));
  const [running] = await db.select().from(sourcingTests).where(eq(sourcingTests.status, 'running')).orderBy(desc(sourcingTests.id)).limit(1);
  return running ?? null;
}

export function validSegment(s: string): SourcingSegment | null {
  return (SOURCING_SEGMENTS as readonly string[]).includes(s) ? (s as SourcingSegment) : null;
}

const isSerper = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input).includes('google.serper.dev');

/** Runs a test that was started (a row in sourcing_tests, still running). Never throws: a failure is written to the row. */
export async function runSourcingTest(db: Db, svc: Services, id: number): Promise<void> {
  const started = Date.now();
  const [test] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, id));
  if (!test || test.status !== 'running') return;
  const segment = validSegment(test.segment);
  const report: SourcingReport = { segment: test.segment, companySize: '', queries: [], companies: [], searches: { find: 0, people: 0 }, seconds: 0 };
  // Saves one at a time, so a slower save never overwrites a newer one.
  let saving: Promise<unknown> = Promise.resolve();
  const save = (set: Partial<typeof sourcingTests.$inferInsert>) => {
    report.seconds = Math.round((Date.now() - started) / 1000);
    const values = { ...set, report: JSON.parse(JSON.stringify(report)) };
    saving = saving.then(() => db.update(sourcingTests).set(values).where(eq(sourcingTests.id, id))).catch(() => {});
    return saving;
  };
  try {
    if (!segment) throw new Error(`Not a segment the test can search: ${test.segment}`);
    if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set: the test searches Google through Serper.');
    const icp = await icpFor(db, segment);
    report.companySize = icp.companySize;
    const known = await knownToInveck(db);

    // Phase 1: company pages.
    let findSearches = 0;
    const finder: Services = { ...svc, fetch: ((input, init) => (isSerper(input) && findSearches++, svc.fetch(input, init))) as typeof fetch };
    const plan = planQueries(segment, icp.companySize, SOURCING_LIMITS.searches, id);
    await save({ progress: `Searching Google for ${segment} company pages on LinkedIn (${plan.length} searches)…` });
    const byUrl = new Map<string, CompanyReport>();
    const names = new Set<string>();
    const search = async (q: string, page: number): Promise<{ results: SerperResult[]; error?: string }> => {
      try {
        return { results: await googleSearch(finder, q, page) };
      } catch (e) {
        return { results: [], error: errorMessage(e) };
      }
    };
    const absorb = (pq: PlannedQuery, page: number, got: { results: SerperResult[]; error?: string }): QueryReport => {
      const pages = got.results.map(readCompanyPage).filter((p): p is CompanyPage => !!p);
      let newPages = 0;
      let passed = 0;
      for (const p of pages) {
        // The same company twice (its page found by two searches, or two pages with one name): kept once.
        const key = normCompany(p.name);
        if (byUrl.has(p.url) || (key && names.has(key))) continue;
        newPages++;
        names.add(key);
        const s = screenPage(p, segment, icp.companySize, known);
        if (s.pass) passed++;
        const note = s.pass && !p.size && pq.form === 'band' ? "size not in Google's text, though the page matched a size band searched for" : s.note;
        byUrl.set(p.url, { ...p, query: pq.q, screen: s.pass ? 'pass' : s.reason, note });
      }
      const r: QueryReport = { q: pq.q, form: pq.form, page, results: got.results.length, pages: pages.length, newPages, passed, ...(got.error ? { error: got.error } : {}) };
      report.queries.push(r);
      return r;
    };
    const first = await mapLimit(plan, 4, (pq) => search(pq.q, 1));
    if (first.every((g) => g.error)) throw new Error(`Google search failed: ${first[0]?.error ?? 'no searches'}`);
    const firstReports = plan.map((pq, i) => absorb(pq, 1, first[i]));
    // A full page that was mostly new companies: the next page is worth a search.
    const more = plan.filter((_, i) => firstReports[i].results >= 10 && firstReports[i].newPages >= 5).slice(0, SOURCING_LIMITS.secondPages);
    const second = await mapLimit(more, 4, (pq) => search(pq.q, 2));
    more.forEach((pq, i) => absorb(pq, 2, second[i]));
    report.companies = [...byUrl.values()];
    report.searches.find = findSearches;

    // Phase 2: anyone reachable at the companies that passed, surest size first.
    const passing = report.companies.filter((c) => c.screen === 'pass');
    const toCheck = [...passing].sort((a, b) => sizeRank(a, icp.companySize) - sizeRank(b, icp.companySize)).slice(0, test.companies);
    await save({ progress: `Found ${report.companies.length} company pages; ${passing.length} passed the screen. Checking ${toCheck.length} for people on LinkedIn…` });
    let checked = 0;
    let peopleSearches = 0;
    await mapLimit(toCheck, 4, async (c) => {
      if (Date.now() - started > SOURCING_LIMITS.seconds * 1000) {
        report.stoppedEarly = `Stopped checking people after ${SOURCING_LIMITS.seconds}s; ${toCheck.length - checked} compan${toCheck.length - checked === 1 ? 'y was' : 'ies were'} not checked.`;
        return;
      }
      let mine = 0;
      const checker: Services = { ...svc, fetch: ((input, init) => (isSerper(input) && (mine++, peopleSearches++), svc.fetch(input, init))) as typeof fetch };
      const log: string[] = [];
      if (c.website) registerFirmWebsite(c.name, c.website);
      const town = c.hq.split(',')[0].trim();
      const r = await searchLinkedIn(checker, '', c.name, town, icp, (m) => void (log.length < 30 && log.push(m)), { staffOnly: true });
      const asFound = (p: { name: string; title: string; linkedin: string }): PersonFound => ({ name: p.name, title: p.title, tier: tierOf(p.title, icp), linkedin: p.linkedin });
      const top = r.people.filter((p) => tierOf(p.title, icp) === 'Top').map(asFound);
      const outcome: PeopleOutcome = r.accepted.length ? 'reachable' : r.error ? 'failed' : top.length ? 'top_only' : r.people.length ? 'staff_only' : 'nobody';
      c.people = {
        outcome,
        staff: r.people.length,
        acceptable: r.accepted.length,
        p1: r.accepted.filter((p) => tierOf(p.title, icp) === 'P1').length,
        best: r.accepted.slice(0, 3).map(asFound),
        top: top.slice(0, 2),
        searches: mine,
        ...(r.error ? { error: r.error } : {}),
        log,
      };
      checked++;
      report.searches.people = peopleSearches;
      await save({ progress: `Checked ${checked} of ${toCheck.length} companies for people…` });
    });
    report.searches.people = peopleSearches;
    const f = funnelOf(report);
    await save({
      status: 'done',
      finishedAt: new Date(),
      progress: `${f.found} company pages found, ${f.passed} passed the screen, ${f.checked} checked: ${f.reachable} with a reachable contact (${f.withP1} with a P1). ${report.searches.find + report.searches.people} Google searches.`,
    });
  } catch (e) {
    await save({ status: 'failed', finishedAt: new Date(), error: errorMessage(e), progress: '' });
  }
  await saving;
}
