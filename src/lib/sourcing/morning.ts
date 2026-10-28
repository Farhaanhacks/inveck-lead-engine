import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { icps, leads, people, prospectSearches, runs, type Lead, type Run } from '../db/schema';
import { DEFAULT_ICPS } from '../db/seed';
import { drawPool, handedOut, morningStartsOn, quotaTotal, teamQuotas, teamTotal } from '../draw';
import { getHolidays } from '../holidays';
import { normSegment } from '../icp-match';
import { logActivity } from '../activity';
import { placeNamedIn, registerFirmWebsite } from '../pipeline/employer';
import { CHECKS_RESERVE, RESEARCH_CREDITS, searchBudgetLeft, searchesUsed } from '../search-budget';
import { normQuery } from '../pipeline/query-history';
import { googleSearch, mapLimit, searchCredits, type SerperResult, type Services } from '../pipeline/services';
import { errorMessage, normCompany, rootDomain } from '../pipeline/text';
import { contactPriority, titlePhrase } from '../tiers';
import { istDay, istDayBounds } from '../tasks';
import { factsQuery, hqAbroad, industryHint, industryUnclear, needsFacts, noCompanyName, outsideIcpByName, pagelessCompany, screenPage, SEGMENT_SEARCH, shuffled, SOURCING_SEGMENTS, withFacts, type CompanyPage, type SourcingSegment } from './linkedin-pages';
import { websiteWords } from './website-words';
import { companiesQuery, companyQuery, hintRank, lookupBatch, matchingPage, PEOPLE_KEYWORDS, readPerson, searchTitles, type FoundContact, type PeopleQuery } from './people-first';
import { knownToInveck } from './test-run';
import type { DeadGround } from './search-memory';

/**
 * The scheduled run's prospect search, people first: LinkedIn profiles with the ICP's P1 and P2
 * titles, then each person's company, screened on its LinkedIn page (size, industry, headquarters,
 * new to INVECK). Every company that passes becomes a lead with the people found there, and is then
 * researched like any other: the ICP check decides Approved or Disqualified. It finds what the morning
 * draw is short of in each segment (the active associates times their quota, less the researched
 * leads waiting to be drawn), and the run comes back for more while research rules some out. CA firms
 * come from their own database and are never searched for here. The Sourcing test is separate: it
 * writes only its report.
 */

/** Leads found this way say so in their source; their people are handed to research as LinkedIn finds. */
export const PEOPLE_FIRST_SOURCE = 'People-first search';
export const PEOPLE_FIRST_EVIDENCE = 'Found by the people-first search: their LinkedIn profile shows this company as their current job';

export const MORNING_LIMITS = {
  /** Times one run searches again after research ruled companies out. */
  rounds: 3,
  /** A segment stops when this many searches in a row found no new company. */
  quietSearches: 150,
  /** A search made in this many days is not made again. */
  memoryDays: 30,
  /** Companies asked for above the shortfall, for those research rules out. */
  headroom: 1.25,
  /** A scheduled run starts no new round after this, India time (the draw is at 8:00). */
  lastRoundIst: { hour: 7, minute: 30 },
  /** People found at one company that are kept for research. */
  contactsPerCompany: 8,
} as const;

export type MorningSegment = {
  segment: SourcingSegment;
  /** Companies wanted this round, and added so far. */
  wanted: number;
  added: number;
  /** Searches made from the plan, and how many in a row found no new company (from 28 Oct 2026; before, nobody new on the lists). */
  cursor: number;
  quiet: number;
  /** Why it stopped: it had what was wanted, hit the day's search limit, stopped finding anyone, ran out of searches, or Google failed. */
  stopped?: 'target' | 'cap' | 'dry' | 'exhausted' | 'failed';
  /**
   * Companies found with contacts, not checked yet; `via`, the search that first found them (normalised); `page`, its
   * LinkedIn page when already found (it waited, not needed then); `alone`, not shown by a search for several at once, so
   * looked up on its own.
   */
  pending: { employer: string; contacts: FoundContact[]; via?: string; page?: CompanyPage; alone?: boolean }[];
  /** Companies already checked this run, by the name their people write. */
  checked: string[];
  ruledOut: number;
  noPage: number;
  searches: number;
};

/** What the run's prospect search has done, kept on the run so a new invocation carries on. */
export type MorningSourcing = {
  round: number;
  roundDone: boolean;
  segments: MorningSegment[];
  /** Profiles seen this run (every round). */
  seen: string[];
  searches: number;
  added: number;
  /** Each finished round, per segment, for the dashboard. */
  history: { round: number; segment: string; wanted: number; added: number; searches: number; stopped?: MorningSegment['stopped'] }[];
  /** The leads this run's search added (every round). */
  addedIds?: number[];
  /** Companies the search found that its check dropped, per segment and reason (every round; from 28 Oct 2026). */
  drops?: Partial<Record<SourcingSegment, Record<string, number>>>;
};

/** Why the check dropped a company, as the report says it (see MorningSourcing.drops). */
export const DROP_REASONS = {
  before: 'ruled out in the last 90 days',
  name: 'outside the ICP by its name',
  noName: 'no company name (only an industry word)',
  noPage: 'no LinkedIn page found',
  small: 'too small',
  industry: 'industry not on the ICP',
  abroad: 'based abroad',
  known: 'already known (by another name, its website or LinkedIn page)',
} as const;

const isSerper = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input).includes('google.serper.dev');
const profileKey = (url: string) => url.toLowerCase().replace(/^https?:\/\/[a-z]+\./, '').replace(/\/+$/, '');

/** The segment's ICP as INVECK has it now (the starting one when it was never saved). */
async function icpFor(db: Db, segment: SourcingSegment) {
  const [row] = await db.select().from(icps).where(eq(icps.segment, segment)).orderBy(desc(icps.active), icps.id).limit(1);
  return row ?? DEFAULT_ICPS.find((i) => i.segment === segment)!;
}

/**
 * Every search for one segment: each P1 and P2 title with every industry word and town, the words and towns in an
 * order that changes each run. The most wanted titles first (28 Oct 2026; before, titles in turn): every word and town
 * with the plant head (the warehouse manager for 3PL) before any with the next title, so new ground is tried with the
 * titles most likely to find someone, and the others only where it isn't dead by then (see DeadGround).
 */
export function morningPlan(segment: SourcingSegment, icp: Parameters<typeof searchTitles>[0], seed: number): PeopleQuery[] {
  const titles = [...searchTitles(icp)].sort((a, b) => contactPriority(a, icp) - contactPriority(b, icp));
  const pairs = shuffled(
    PEOPLE_KEYWORDS[segment].flatMap((k) => SEGMENT_SEARCH[segment].places.map((p) => [k, p] as const)),
    seed,
  );
  const out: PeopleQuery[] = [];
  for (const title of titles) {
    for (const [keyword, place] of pairs) out.push({ q: ['site:linkedin.com/in', `"${titlePhrase(title)}"`, `"${keyword}"`, place].join(' '), form: 'industry', title, keyword, place });
  }
  return out;
}

/**
 * Whether the 6 am run searches for new prospects today: a working day (Monday to Friday, not a holiday
 * marked in Settings), on or after the day the morning search starts, and not turned off in Settings.
 */
export async function searchesThisMorning(db: Db, settings: Services['settings'], now = new Date()): Promise<boolean> {
  const day = istDay(now);
  const weekday = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCDay();
  if (weekday < 1 || weekday > 5 || (await getHolidays(db)).has(day)) return false;
  const start = await morningStartsOn(db);
  return (!start || day >= start) && settings.morningSearch;
}

/** Whether a scheduled run may still start another round before the draw. */
export function beforeLastRound(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const { hour, minute } = MORNING_LIMITS.lastRoundIst;
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() < hour * 60 + minute;
}

/**
 * What the morning draw is short of in each segment: every active associate's daily list added up, less
 * the researched leads waiting to be drawn and the companies still waiting for research.
 */
export async function drawShortfall(db: Db, settings: Services['settings']): Promise<Record<SourcingSegment, { need: number; pool: number; waiting: number; short: number }>> {
  // Each associate's list, less what they have already been given for today (a sample's leads given out the evening before).
  const quotas = await teamQuotas(db, settings);
  const given = await handedOut(db, istDay());
  const team = teamTotal(quotas);
  for (const s of SOURCING_SEGMENTS) team[s] = [...quotas].reduce((a, [o, q]) => a + Math.max(0, (q[s] ?? 0) - (given[String(o)]?.[s] ?? 0)), 0);
  const pool = await drawPool(db);
  const waitingRows = await db
    .select({ segment: leads.segment, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(inArray(leads.status, ['New', 'Processing']), isNull(leads.ownerId), eq(leads.inbound, false)))
    .groupBy(leads.segment);
  const out = {} as Record<SourcingSegment, { need: number; pool: number; waiting: number; short: number }>;
  for (const s of SOURCING_SEGMENTS) {
    const need = team[s];
    const waiting = waitingRows.filter((r) => normSegment(r.segment) === normSegment(s)).reduce((a, r) => a + Number(r.n), 0);
    out[s] = { need, pool: pool.bySegment[s], waiting, short: Math.max(0, need - pool.bySegment[s] - waiting) };
  }
  return out;
}

/** Searches the morning runs made in the last 30 days (by their normalised form), not to be made again; `own` is a run's own. */
export async function recentSearches(db: Db, own: number | null): Promise<Set<string>> {
  const since = new Date(Date.now() - MORNING_LIMITS.memoryDays * 86_400_000);
  const rows = await db
    .select({ q: prospectSearches.normQuery })
    .from(prospectSearches)
    .where(and(gte(prospectSearches.searchedAt, since), eq(prospectSearches.status, 'ok'), own === null ? undefined : or(isNull(prospectSearches.runId), ne(prospectSearches.runId, own))));
  return new Set(rows.map((r) => r.q));
}

/**
 * A new round: what it wants per segment, carrying on from the last round (the searches already made
 * aren't made again, companies already checked aren't checked again, and those found but not needed
 * then come first now).
 */
export function startRound(prev: MorningSourcing | null, wanted: Record<SourcingSegment, number>): MorningSourcing {
  const segments = SOURCING_SEGMENTS.map((segment): MorningSegment => {
    const before = prev?.segments.find((p) => p.segment === segment);
    return { segment, wanted: wanted[segment], added: 0, cursor: before?.cursor ?? 0, quiet: 0, pending: before?.pending ?? [], checked: before?.checked ?? [], ruledOut: 0, noPage: 0, searches: 0 };
  });
  return { round: (prev?.round ?? 0) + 1, roundDone: false, segments, seen: prev?.seen ?? [], searches: prev?.searches ?? 0, added: prev?.added ?? 0, history: prev?.history ?? [], addedIds: prev?.addedIds ?? [], drops: prev?.drops ?? {} };
}

/** Leads this run's search added that research approved, per segment. */
async function approvedBy(db: Db, state: MorningSourcing | null): Promise<Record<SourcingSegment, number>> {
  const out = Object.fromEntries(SOURCING_SEGMENTS.map((s) => [s, 0])) as Record<SourcingSegment, number>;
  const ids = state?.addedIds ?? [];
  if (!ids.length) return out;
  const rows = await db.select({ segment: leads.segment }).from(leads).where(and(inArray(leads.id, ids), eq(leads.status, 'Approved')));
  for (const r of rows) {
    const s = SOURCING_SEGMENTS.find((x) => normSegment(x) === normSegment(r.segment));
    if (s) out[s]++;
  }
  return out;
}

/**
 * The companies a round of the run asks for, per segment. A manual search finds at least its share of "New prospects per search".
 * One the admin asked for a number of leads in each segment searches only those, for what research hasn't approved yet.
 */
async function runWants(db: Db, svc: Services, run: Run, round: number, prev: MorningSourcing | null): Promise<Record<SourcingSegment, number>> {
  if (run.prospectsWanted) {
    const approved = await approvedBy(db, prev);
    return Object.fromEntries(SOURCING_SEGMENTS.map((s) => [s, Math.ceil(Math.max(0, (run.prospectsWanted![s] ?? 0) - approved[s]) * MORNING_LIMITS.headroom)])) as Record<SourcingSegment, number>;
  }
  const short = await drawShortfall(db, svc.settings);
  // A manual search's share per segment follows the team's daily lists.
  const team = teamTotal(await teamQuotas(db, svc.settings));
  const total = quotaTotal(team);
  const share = (s: SourcingSegment) => (total ? (team[s] ? Math.max(1, Math.round((svc.settings.prospectsPerRun * team[s]) / total)) : 0) : Math.ceil(svc.settings.prospectsPerRun / 2));
  const wanted = {} as Record<SourcingSegment, number>;
  for (const segment of SOURCING_SEGMENTS) {
    const fill = Math.ceil(short[segment].short * MORNING_LIMITS.headroom);
    wanted[segment] = run.trigger !== 'schedule' && round === 1 ? Math.max(fill, share(segment)) : fill;
  }
  return wanted;
}

/** Whether the run should search again: research ruled out companies and the draw is still short. */
export async function wantsAnotherRound(db: Db, svc: Services, run: Run, now = new Date()): Promise<boolean> {
  const state = run.sourcing as MorningSourcing | null;
  if (!state?.roundDone || state.round >= MORNING_LIMITS.rounds) return false;
  // The last round found nothing new: searching again finds nothing either.
  const last = state.history.filter((h) => h.round === state.round);
  if (!last.some((h) => h.added > 0)) return false;
  if (last.some((h) => h.stopped === 'cap' || h.stopped === 'failed')) return false;
  // Asked for a number of leads: again while research has approved fewer than that.
  if (run.prospectsWanted) {
    const approved = await approvedBy(db, state);
    return SOURCING_SEGMENTS.some((s) => (run.prospectsWanted![s] ?? 0) > approved[s]);
  }
  // Companies handed straight to the team aren't in the draw's pool: one round is what was asked.
  if (run.prospectsTo) return false;
  if (run.trigger === 'schedule' && !beforeLastRound(now)) return false;
  // Nothing left of the day's search budget once the waiting companies are researched.
  if (svc.meter && (await searchBudgetLeft(db, svc.settings)) - (await researchReserve(db)) - CHECKS_RESERVE < 50) return false;
  const short = await drawShortfall(db, svc.settings);
  return SOURCING_SEGMENTS.some((s) => short[s].short > 0);
}

/** What researching the companies waiting for it will cost, at most. */
export async function researchReserve(db: Db): Promise<number> {
  const [r] = await db
    .select({
      first: sql<number>`(count(*) filter (where ${leads.source} like ${`${PEOPLE_FIRST_SOURCE}%`}))::int`,
      other: sql<number>`(count(*) filter (where ${leads.source} not like ${`${PEOPLE_FIRST_SOURCE}%`}))::int`,
    })
    .from(leads)
    .where(inArray(leads.status, ['New', 'Processing']));
  return Number(r?.first ?? 0) * RESEARCH_CREDITS.peopleFirst + Number(r?.other ?? 0) * RESEARCH_CREDITS.other;
}

/** People the search found, as the LinkedIn search's own finds, for research to choose from. */
export function asLinkedInFinds(found: Pick<FoundContact, 'name' | 'title' | 'linkedin' | 'location'>[]) {
  return found.map((p) => ({ name: p.name, title: p.title, linkedin: p.linkedin, snippet: PEOPLE_FIRST_EVIDENCE, location: p.location, evidence: PEOPLE_FIRST_EVIDENCE }));
}

/** The people the search found at a people-first lead, for research to choose from. */
export async function peopleFirstContacts(db: Db, lead: Pick<Lead, 'id' | 'source'>) {
  if (!lead.source.startsWith(PEOPLE_FIRST_SOURCE)) return [];
  const rows = await db.select().from(people).where(and(eq(people.leadId, lead.id), eq(people.source, 'LinkedIn'), eq(people.evidence, PEOPLE_FIRST_EVIDENCE)));
  return asLinkedInFinds(rows);
}

/** A company that passed the screen, with the people found there (best first); `via`, the search that first found it (normalised). */
export type PassedCompany = { segment: SourcingSegment; name: string; employer: string; page: CompanyPage; contacts: FoundContact[]; note: string; city: string; via?: string };

/** Where a round's finds go: the run's leads, or a sample run's report. */
export type RoundSink = {
  add(c: PassedCompany): Promise<void>;
  /**
   * A search made: the run remembers it, so it isn't made again for a while (a sample run keeps its own
   * memory, see search-memory.ts). `listed`: the people on the ICP's lists it showed, seen before or not.
   */
  searched?(segment: SourcingSegment, pq: PeopleQuery, result: { results: number; newCompanies: number; listed: number; error?: string; page: number; num: number }): Promise<void>;
  save(state: MorningSourcing): Promise<unknown>;
};

export type RoundOptions = {
  started: number;
  budgetMs: number;
  log: (m: string, level?: 'info' | 'warn' | 'error') => Promise<unknown>;
  /** Whether the admin pressed Stop: the search ends where it is. */
  stopped?: () => Promise<boolean>;
  /** Orders the plan: the same on every round and invocation, so the cursor stays where it was. */
  seed: number;
  /**
   * What is left of the day's Google search budget for finding more companies: the budget, less what
   * was spent, less what researching the companies already found will cost and the contact checks.
   */
  budgetLeft: () => Promise<number>;
  /** Searches made before (normalised), not made again. */
  recent: Set<string>;
  /** Companies taken besides INVECK's own: a sample run's earlier finds. */
  alsoKnown?: { names: string[]; domains: string[]; pages: string[] };
  /** The Morning Sample Run's cheaper rules (see SAMPLE_RULES); the run uses the defaults. Results per people search. */
  peopleResults?: number;
  /** Searches in a row finding no new company before a segment stops (default MORNING_LIMITS.quietSearches). */
  quietSearches?: number;
  /** A first page of ten that was full and found new companies is read on at once: its first hundred, 2 credits. */
  deepReads?: boolean;
  /** Where searches have found nobody (see DeadGround), kept up to date as the run searches: that ground isn't searched. */
  deadGround?: (segment: SourcingSegment) => Promise<DeadGround>;
  /** Companies ruled out (too small, the wrong industry, no LinkedIn page) are remembered and not checked again. */
  rememberRuledOut?: boolean;
  /**
   * No LinkedIn page doesn't rule a company out (it's checked by its name, research does the rest), and an
   * industry LinkedIn doesn't show is read from the company's own website (no search credit), else left to research.
   */
  lenientScreen?: boolean;
  /**
   * Cheaper company checks, the same companies kept: a company whose name shows it's outside the ICP isn't
   * looked up (LinkedIn's check would only rule it out); companies whose people's own results show another
   * industry are checked last; several companies are looked up in one search, each not found that way on
   * its own after.
   */
  cheaperChecks?: boolean;
  /**
   * Per segment, in place of `quietSearches`, and of `lenientScreen` for passing a company with no LinkedIn page or an
   * unclear industry to research (the Morning Sample Run's longer, stricter search for 3PL & Logistics).
   */
  segmentRules?: Partial<Record<SourcingSegment, { quietSearches?: number; lenientScreen?: boolean; unclearIndustry?: boolean }>>;
  /** Reorders or shortens a segment's plan (a sample run's memory of its searches); the same answer on every invocation. */
  plan?: (segment: SourcingSegment, plan: PeopleQuery[]) => Promise<PeopleQuery[]>;
  sink: RoundSink;
};

/** Results asked for in one people search: ten, for 1 credit. */
export const PEOPLE_RESULTS = 10;
/** A company ruled out (or with no LinkedIn page) isn't checked again for this long, where that's asked for. */
const RULED_OUT_DAYS = 90;

/** The credits a request to Serper costs, from the number of results it asks for. */
export function creditsOf(input: RequestInfo | URL, init?: RequestInit): number {
  if (!isSerper(input)) return 0;
  try {
    return searchCredits(Number(JSON.parse(String(init?.body ?? '{}')).num) || 10);
  } catch {
    return 1;
  }
}

/**
 * Works on a round until each segment has what it wants or stops, or `budgetMs` runs out ('continue':
 * where it got to is saved). The segments take turns, the one furthest from what it wants first, so
 * the day's search budget is shared between them. Every company that passes goes to the sink at once.
 * Throws when Google refuses every search (out of credits, a wrong key).
 */
export async function searchRound(db: Db, svc: Services, state: MorningSourcing, o: RoundOptions): Promise<'done' | 'continue'> {
  const save = () => o.sink.save(state);
  const known = await knownToInveck(db);
  const pages = new Set((await db.select({ url: leads.companyLinkedin }).from(leads).where(ne(leads.companyLinkedin, ''))).map((r) => r.url));
  for (const n of o.alsoKnown?.names ?? []) known.names.add(normCompany(n));
  for (const d of o.alsoKnown?.domains ?? []) known.domains.add(d);
  for (const p of o.alsoKnown?.pages ?? []) pages.add(p);
  const seen = new Set(state.seen);
  const peopleResults = o.peopleResults ?? PEOPLE_RESULTS;
  // The most one step of the search can spend: a batch of searches and their deep reads (a hundred results each), or a
  // batch of company checks with their second looks.
  const stepCredits = 8 * (searchCredits(10) + searchCredits(100));

  // Each segment's search, ready to take a step.
  type Worker = { seg: MorningSegment; step: () => Promise<'more' | 'stop'>; checked: Set<string> };
  const workers: Worker[] = [];
  for (const seg of state.segments) {
    if (seg.stopped || seg.added >= seg.wanted) {
      seg.stopped ??= 'target';
      continue;
    }
    const icp = await icpFor(db, seg.segment);
    const own = o.segmentRules?.[seg.segment];
    const quietLimit = own?.quietSearches ?? o.quietSearches ?? MORNING_LIMITS.quietSearches;
    const lenientScreen = own?.lenientScreen ?? o.lenientScreen;
    // A page that shows no industry either way (no label, or a catch-all one): its website, then research, decides.
    const unclearIndustry = own?.unclearIndustry ?? lenientScreen;
    const planned = morningPlan(seg.segment, icp, o.seed).filter((q) => !o.recent.has(normQuery(q.q)));
    const ground = o.deadGround ? await o.deadGround(seg.segment) : null;
    const plan = o.plan ? await o.plan(seg.segment, planned) : planned;
    const counting: Services = {
      ...svc,
      fetch: ((input, init) => {
        const credits = creditsOf(input, init);
        seg.searches += credits;
        state.searches += credits;
        return svc.fetch(input, init);
      }) as typeof fetch,
    };
    // An account Serper doesn't allow more than ten results on: ten at a time, for the rest of the round.
    let fewer = false;
    // The page and number of results actually read come back with them (a refused hundred is read as ten, `fallbackPage`).
    const search = async (q: string, num = 10, page = 1, fallbackPage?: number): Promise<{ results: SerperResult[]; error?: string; page: number; num: number }> => {
      if (fewer && num > 10) return search(q, 10, fallbackPage ?? page);
      try {
        return { results: await googleSearch(counting, q, page, num), page, num };
      } catch (e) {
        if (num > 10 && !fewer && /not allowed/i.test(errorMessage(e))) {
          fewer = true;
          return search(q, 10, fallbackPage ?? page);
        }
        return { results: [], error: errorMessage(e), page, num };
      }
    };
    // Companies ruled out earlier for this segment and size (when asked): not checked (searched) again.
    const ruledOutKey = (employer: string) => `company-check:v1:${seg.segment}:${icp.companySize}:${normCompany(employer)}`;
    const ruledOutBefore = async (employer: string) => {
      if (!o.rememberRuledOut) return false;
      const was = (await svc.cache?.get(ruledOutKey(employer)).catch(() => null)) as { at?: string } | null;
      return !!was?.at && Date.now() - new Date(was.at).getTime() < RULED_OUT_DAYS * 86_400_000;
    };
    const rememberRuledOut = async (employer: string, why: string) => {
      if (o.rememberRuledOut) await svc.cache?.set(ruledOutKey(employer), { at: new Date().toISOString(), why }).catch(() => {});
    };
    const rank = (p: FoundContact) => contactPriority(p.title, icp);
    const checked = new Set(seg.checked);
    const drop = (why: keyof typeof DROP_REASONS) => {
      const mine = ((state.drops ??= {})[seg.segment] ??= {});
      mine[DROP_REASONS[why]] = (mine[DROP_REASONS[why]] ?? 0) + 1;
    };

    // A company not needed now (the segment has what it wants): it waits, with its page when that was found.
    const putBack = (c: MorningSegment['pending'][number], page?: CompanyPage) => {
      checked.delete(normCompany(c.employer));
      seg.pending.push(page ? { ...c, page } : c);
    };
    // Checks one company's LinkedIn page (already found, or in `pre`, a search for several at once, when it's there);
    // one that passes goes to the sink with its people.
    const check = async (c: MorningSegment['pending'][number], pre?: SerperResult[]) => {
      checked.add(normCompany(c.employer));
      if (await ruledOutBefore(c.employer)) {
        seg.ruledOut++;
        drop('before');
        return;
      }
      // An employer that is only an industry word isn't looked up (the sample's rule, for every segment).
      if (o.lenientScreen && noCompanyName(c.employer)) {
        seg.noPage++;
        drop('noName');
        return;
      }
      const fromPre = c.page ?? (pre ? matchingPage(pre, c.employer) : null);
      const got = fromPre ? { results: [] as SerperResult[], error: undefined } : await search(companyQuery(c.employer));
      let page: CompanyPage | null = fromPre ?? (got.error ? null : matchingPage(got.results, c.employer));
      if (!page && !got.error && lenientScreen) page = pagelessCompany(c.employer);
      if (!page) {
        seg.noPage++;
        drop('noPage');
        if (!got.error) await rememberRuledOut(c.employer, 'no LinkedIn page');
        return;
      }
      if (page.url && needsFacts(page)) {
        // Its size and industry take a second search: only while companies are still needed.
        if (seg.added >= seg.wanted) return putBack(c, page);
        page = withFacts(page, (await search(factsQuery(page))).results);
      }
      // Its people work in India, so it has a site here whatever its headquarters.
      const seenAs = { ...page, text: `${page.text}\n${c.contacts.map((p) => p.location).join('; ')}` };
      let s = screenPage(seenAs, seg.segment, icp.companySize, known);
      if (unclearIndustry && !s.pass && s.reason === 'industry' && industryUnclear(page, seg.segment)) {
        const words = await websiteWords(svc, page.website);
        s = screenPage({ ...seenAs, text: `${seenAs.text}\n${words}` }, seg.segment, icp.companySize, known, { passUnclearIndustry: true });
        if (s.pass && words && !s.note.includes('research checks it')) s = { ...s, note: `${s.note}; industry from its website` };
      }
      if (s.pass && !page.url) s = { ...s, note: `no LinkedIn company page found; ${s.note}` };
      if (!s.pass || (page.url && pages.has(page.url))) {
        seg.ruledOut++;
        drop(s.pass ? 'known' : s.reason);
        // Too small or the wrong industry doesn't change soon; abroad depends on who was found there.
        if (!s.pass && (s.reason === 'small' || s.reason === 'industry')) await rememberRuledOut(c.employer, s.note);
        return;
      }
      if (seg.added >= seg.wanted) return putBack(c, page);
      const name = page.nameCut ? c.employer : page.name;
      // Taken before it's added, so two checks at once can't add the same company.
      if (page.url) pages.add(page.url);
      known.names.add(normCompany(name));
      known.names.add(normCompany(c.employer));
      const domain = rootDomain(page.website);
      if (domain) known.domains.add(domain);
      seg.added++;
      state.added++;
      const best = c.contacts[0];
      const city = page.hq && !hqAbroad(page.hq) ? page.hq.split(',')[0].trim() : placeNamedIn(page.text) || (best.location.split(',')[0] ?? '').trim();
      await o.sink.add({ segment: seg.segment, name, employer: c.employer, page, contacts: c.contacts.slice(0, MORNING_LIMITS.contactsPerCompany), note: s.note, city, ...(c.via ? { via: c.via } : {}) });
    };

    // One step: check companies already found (their checks may be all that's needed), else search for more people.
    const step = async (): Promise<'more' | 'stop'> => {
      seg.pending = seg.pending.filter((c) => !checked.has(normCompany(c.employer)));
      if (seg.pending.length) {
        seg.pending.sort((a, b) => (o.cheaperChecks ? hintRank(a.contacts) - hintRank(b.contacts) : 0) || rank(a.contacts[0]) - rank(b.contacts[0]) || b.contacts.length - a.contacts.length);
        if (!o.cheaperChecks) await mapLimit(seg.pending.splice(0, Math.max(1, Math.min(4, seg.wanted - seg.added))), 4, (c) => check(c));
        else {
          // Up to six companies at a time (28 Oct 2026; four before, and only as many as were still needed).
          const batch = lookupBatch(seg.pending);
          // Outside the ICP by name, or ruled out before: not looked up. The rest in one search; any it doesn't
          // show, on their own, only as many as are still needed (the others wait their turn).
          const toLook: typeof batch = [];
          for (const c of batch) {
            const outside = !!outsideIcpByName(c.employer, seg.segment);
            if (!outside && !(await ruledOutBefore(c.employer))) toLook.push(c);
            else {
              checked.add(normCompany(c.employer));
              seg.ruledOut++;
              drop(outside ? 'name' : 'before');
            }
          }
          const together = toLook.filter((c) => !c.page && !c.alone && !noCompanyName(c.employer));
          const pre = together.length > 1 ? await search(companiesQuery(together.map((c) => c.employer))) : null;
          const shown = pre && !pre.error ? pre.results : undefined;
          const ready = toLook.filter((c) => c.page || (shown && matchingPage(shown, c.employer)));
          await mapLimit(ready, 4, (c) => check(c, shown));
          const alone = toLook.filter((c) => !ready.includes(c));
          while (alone.length && seg.added < seg.wanted) await mapLimit(alone.splice(0, Math.max(1, Math.min(4, seg.wanted - seg.added))), 4, (c) => check(c, shown));
          seg.pending.push(...alone.map((c) => ({ ...c, alone: true })));
        }
        return 'more';
      }
      if (seg.quiet >= quietLimit) {
        seg.stopped = 'dry';
        return 'stop';
      }
      // The next eight searches, past any on ground this run has found empty.
      const batch: PeopleQuery[] = [];
      while (batch.length < 8 && seg.cursor < plan.length) {
        const pq = plan[seg.cursor++];
        if (!ground?.dead(pq)) batch.push(pq);
      }
      if (!batch.length) {
        seg.stopped = 'exhausted';
        return 'stop';
      }
      const got = await mapLimit(batch, 4, (pq) => search(pq.q, pq.num ?? peopleResults, pq.page ?? 1, pq.fallbackPage));
      // Every search refused (out of credits, a wrong key): the run ends as failed, with the reason.
      if (got.every((g) => g.error)) {
        seg.stopped = 'failed';
        state.history.push({ round: state.round, segment: seg.segment, wanted: seg.wanted, added: seg.added, searches: seg.searches, stopped: 'failed' });
        state.seen = [...seen];
        state.roundDone = true;
        seg.checked = [...checked];
        await save();
        throw new Error(`Google search failed: ${got[0]?.error ?? 'no answer'}`);
      }
      // One search's people: the new companies go to be checked; what it showed comes back.
      const absorb = async (pq: PeopleQuery, results: SerperResult[]) => {
        let listed = 0;
        let newCompanies = 0;
        for (const r of results) {
          let person: FoundContact | null;
          try {
            person = readPerson(r, icp);
          } catch {
            person = null;
          }
          if (person && !person.why && normCompany(person.employer)) listed++;
          if (!person || seen.has(profileKey(person.linkedin))) continue;
          seen.add(profileKey(person.linkedin));
          const key = normCompany(person.employer);
          if (person.why || !key) continue;
          if (o.cheaperChecks) person.hint = industryHint(`${r.title ?? ''} ${r.subtitle ?? ''} ${r.snippet ?? ''}`, seg.segment);
          if (known.names.has(key) || checked.has(key)) continue;
          // Ruled out in the last 90 days, or outside the ICP by its name: not a new company (28 Oct 2026; before, it
          // counted as one and was dropped at its check, so searches turning up only old rejects kept the search going).
          const outside = !!o.cheaperChecks && !!outsideIcpByName(person.employer, seg.segment);
          if (!seg.pending.some((x) => normCompany(x.employer) === key) && (outside || (await ruledOutBefore(person.employer)))) {
            checked.add(key);
            seg.ruledOut++;
            drop(outside ? 'name' : 'before');
            continue;
          }
          const c = seg.pending.find((x) => normCompany(x.employer) === key);
          if (c) c.contacts.push(person);
          else {
            seg.pending.push({ employer: person.employer, contacts: [person], ...(o.plan ? { via: normQuery(pq.q) } : {}) });
            newCompanies++;
          }
        }
        return { listed, newCompanies };
      };
      const record = async (pq: PeopleQuery, g: (typeof got)[number]) => {
        const { listed, newCompanies } = await absorb(pq, g.results);
        if (!g.error) ground?.note(pq, listed > 0);
        // A new company is what counts (28 Oct 2026): people at companies already known or checked can't become new leads.
        seg.quiet = newCompanies ? 0 : seg.quiet + 1;
        await o.sink.searched?.(seg.segment, pq, { results: g.results.length, newCompanies, listed, error: g.error, page: g.page, num: g.num });
        return newCompanies;
      };
      // A full first page of ten that found new companies: its next ninety people now, in one search (2 credits for up
      // to 90, not nine more searches; 28 Oct 2026).
      const deep: PeopleQuery[] = [];
      for (const [i, pq] of batch.entries()) {
        const fresh = await record(pq, got[i]);
        if (o.deepReads && fresh && got[i].num <= 10 && got[i].page === 1 && got[i].results.length >= 10) deep.push(pq);
      }
      const more = await mapLimit(deep, 4, (pq) => search(pq.q, 100, 1, 2));
      for (const [i, pq] of deep.entries()) await record({ ...pq, num: more[i].num, page: more[i].page }, more[i]);
      for (const c of seg.pending) c.contacts.sort((a, b) => rank(a) - rank(b));
      return 'more';
    };
    workers.push({ seg, step, checked });
  }

  const finish = async (w: Worker) => {
    w.seg.checked = [...w.checked];
    state.history.push({ round: state.round, segment: w.seg.segment, wanted: w.seg.wanted, added: w.seg.added, searches: w.seg.searches, stopped: w.seg.stopped });
    if (w.seg.wanted) {
      const why =
        w.seg.stopped === 'target'
          ? ''
          : w.seg.stopped === 'cap'
            ? " (the day's Google search budget is kept for researching what was found)"
            : w.seg.stopped === 'dry'
              ? ` (the last ${w.seg.quiet} searches found no new company)`
              : ` (every search planned has been made in the last ${MORNING_LIMITS.memoryDays} days)`;
      await o.log(`${w.seg.segment}: ${w.seg.added} of ${w.seg.wanted} new companies with contacts, ${w.seg.searches} Google search credits${why}`, w.seg.added < w.seg.wanted ? 'warn' : 'info');
    }
  };
  const saveAll = async () => {
    state.seen = [...seen];
    for (const w of workers) w.seg.checked = [...w.checked];
    await save();
  };

  let steps = 0;
  let active = workers.slice();
  while (active.length) {
    // Out of this invocation's time (after doing something, so every invocation gets further).
    if (steps > 0 && Date.now() - o.started > o.budgetMs * 0.85) {
      await saveAll();
      return 'continue';
    }
    if (await o.stopped?.()) {
      state.roundDone = true;
      await saveAll();
      return 'done';
    }
    // The day's budget: what's left after researching what's been found, and the contact checks.
    if ((await o.budgetLeft()) < stepCredits) {
      for (const w of active) w.seg.stopped = 'cap';
      for (const w of active) await finish(w);
      active = [];
      break;
    }
    // The segment furthest from what it wants takes the next step.
    const w = active.reduce((a, b) => (b.seg.added / b.seg.wanted < a.seg.added / a.seg.wanted ? b : a));
    steps++;
    const outcome = await w.step();
    if (w.seg.added >= w.seg.wanted) w.seg.stopped = 'target';
    if (outcome === 'stop' || w.seg.stopped) {
      await finish(w);
      active = active.filter((x) => x !== w);
    }
  }
  state.seen = [...seen];
  state.roundDone = true;
  await save();
  return 'done';
}

/**
 * The run's prospect search: a round of searchRound whose finds become leads at once, with their
 * people, handed to `onAdded` (to give them to the team when the admin chose that).
 */
export async function sourceProspects(
  db: Db,
  svc: Services,
  run: Run,
  opts: Pick<RoundOptions, 'started' | 'budgetMs' | 'log' | 'stopped'> & { onAdded?: (ids: number[]) => Promise<void> },
): Promise<'done' | 'continue'> {
  // Read again: an earlier round of this invocation saved it.
  const [row] = await db.select({ sourcing: runs.sourcing }).from(runs).where(eq(runs.id, run.id));
  const prev = (row?.sourcing ?? null) as MorningSourcing | null;
  const fresh = !prev || prev.roundDone;
  const state = fresh ? startRound(prev, await runWants(db, svc, run, (prev?.round ?? 0) + 1, prev)) : prev;
  const save = (s: MorningSourcing) => db.update(runs).set({ sourcing: JSON.parse(JSON.stringify(s)), heartbeatAt: new Date() }).where(eq(runs.id, run.id));
  if (fresh) {
    const wanted = state.segments.filter((s) => s.wanted > 0);
    await opts.log(
      wanted.length
        ? `${state.round > 1 ? `Searching again (round ${state.round}): ` : 'Finding new prospects, people first: '}${wanted.map((s) => `${s.wanted} ${s.segment}`).join(', ')}`
        : 'Finding new prospects: the morning draw has enough researched leads waiting, so none are needed',
    );
    await save(state);
  }
  if (!svc.keys.serper) {
    await opts.log('Prospect search skipped: SERPER_API_KEY is not set', 'error');
    state.roundDone = true;
    await save(state);
    return 'done';
  }
  return searchRound(db, svc, state, {
    ...opts,
    // The same plan on every round and invocation of this run, so the cursor stays where it was.
    seed: run.id * 31,
    // The day's budget, less what researching the companies waiting will cost and the 8 am contact checks.
    budgetLeft: async () => (await searchBudgetLeft(db, svc.settings)) - (await researchReserve(db)) - CHECKS_RESERVE,
    // Searches made on earlier runs: not made again for a while (this run's own are in its cursor).
    recent: await recentSearches(db, run.id),
    sink: {
      save,
      async add(c) {
        const best = c.contacts[0];
        const [lead] = await db
          .insert(leads)
          .values({
            company: c.name,
            nameAsFound: c.employer,
            website: c.page.website,
            city: c.city,
            segment: c.segment,
            status: 'New',
            companyLinkedin: c.page.url,
            source: `${PEOPLE_FIRST_SOURCE}: ${best.name}, ${best.title} (${best.tier}), on LinkedIn; company page ${c.page.url} (${c.page.size || 'size not shown'}${c.page.industry ? `, ${c.page.industry}` : ''})`,
          })
          .returning({ id: leads.id });
        state.addedIds = [...(state.addedIds ?? []), lead.id];
        if (c.page.website) registerFirmWebsite(c.name, c.page.website);
        await db.insert(people).values(c.contacts.map((p) => ({ leadId: lead.id, name: p.name, title: p.title, linkedin: p.linkedin, location: p.location, source: 'LinkedIn', evidence: PEOPLE_FIRST_EVIDENCE })));
        await logActivity(db, lead.id, 'added', `Found by the people-first search: ${c.contacts.map((p) => `${p.name} (${p.title}, ${p.tier})`).slice(0, 4).join('; ')} work here. Company page: ${c.page.url}; ${c.note}.`);
        await opts.onAdded?.([lead.id]);
      },
      async searched(segment, pq, r) {
        await db.insert(prospectSearches).values({ query: pq.q, normQuery: normQuery(pq.q), segment, runId: run.id, status: r.error ? 'failed' : 'ok', resultsCount: r.results, freshCount: r.newCompanies, error: r.error ?? '' });
      },
    },
  });
}

export type MorningHealth = {
  day: string;
  /** Why there's no search today: a weekend, a holiday, not started yet, or turned off in Settings ('' on a working day). */
  off: '' | 'weekend' | 'holiday' | 'not_started' | 'disabled';
  /** The first day the morning search and draw run ('' when they always have). */
  startsOn: string;
  /** Today's 6 am run, if it has started. */
  run: { id: number; status: Run['status']; startedAt: Date; finishedAt: Date | null; added: number; researched: number; approved: number; disqualified: number; searches: number; rounds: number; error: string } | null;
  /** Per segment: what the draw needs, what's ready for it now, and what today's search found against what it wanted. */
  segments: { segment: SourcingSegment; need: number; ready: number; waiting: number; found: number; wanted: number; stopped?: MorningSegment['stopped'] }[];
  /** Google search credits spent today, everything included, and the day's budget (0: no daily limit). */
  searchesToday: number;
  budget: number;
  /** Signs the searches are running out of new companies, from the last few scheduled runs. */
  thin: string[];
};

/** The Dashboard's morning card: today's 6 am run, the draw's needs, and whether the market is running thin. */
export async function morningHealth(db: Db, settings: Services['settings'], holidays: Set<string>, now = new Date()): Promise<MorningHealth> {
  const day = istDay(now);
  const weekday = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCDay();
  const startsOn = await morningStartsOn(db);
  const off: MorningHealth['off'] =
    weekday === 0 || weekday === 6 ? 'weekend' : holidays.has(day) ? 'holiday' : startsOn && day < startsOn ? 'not_started' : settings.morningSearch ? '' : 'disabled';
  const { start } = istDayBounds(day);
  // Only the small parts of each run's search record (its list of profiles seen can be long).
  const recent = await db
    .select({
      id: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      stats: runs.stats,
      error: runs.error,
      history: sql<MorningSourcing['history'] | null>`${runs.sourcing}->'history'`,
      searches: sql<number | null>`(${runs.sourcing}->>'searches')::int`,
      round: sql<number | null>`(${runs.sourcing}->>'round')::int`,
    })
    .from(runs)
    .where(and(eq(runs.trigger, 'schedule'), eq(runs.findProspects, true)))
    .orderBy(desc(runs.id))
    .limit(5);
  const todays = recent.find((r) => new Date(r.startedAt) >= start) ?? null;
  const short = await drawShortfall(db, settings);
  // Every Google search the app made today, against the day's budget.
  const searchesToday = await searchesUsed(db, day);

  const segments = SOURCING_SEGMENTS.map((segment) => {
    const rounds = todays?.history?.filter((h) => h.segment === segment) ?? [];
    return {
      segment,
      need: short[segment].need,
      ready: short[segment].pool,
      waiting: short[segment].waiting,
      found: rounds.reduce((a, h) => a + h.added, 0),
      wanted: rounds[0]?.wanted ?? 0,
      stopped: rounds[rounds.length - 1]?.stopped,
    };
  });

  // Running thin: a recent run stopped short because its searches found nobody new, or ran out of
  // searches; or the last few runs found very few new companies for the searches they made.
  const thin: string[] = [];
  for (const segment of SOURCING_SEGMENTS) {
    const rounds = recent.flatMap((r) => r.history?.filter((h) => h.segment === segment) ?? []);
    const stoppedShort = rounds.filter((h) => h.added < h.wanted && (h.stopped === 'dry' || h.stopped === 'exhausted'));
    const searches = rounds.reduce((a, h) => a + h.searches, 0);
    const added = rounds.reduce((a, h) => a + h.added, 0);
    if (stoppedShort.some((h) => h.stopped === 'exhausted')) thin.push(`${segment}: every search planned (titles, industry words, towns) has been made in the last ${MORNING_LIMITS.memoryDays} days. Add titles to the ICP's lists, or more industry words and towns, to find new companies.`);
    else if (stoppedShort.length) thin.push(`${segment}: ${stoppedShort.length} of the last ${rounds.length} rounds stopped short of what the draw needed: the searches stopped finding anyone new.`);
    else if (searches >= 300 && (added * 100) / searches < 1) thin.push(`${segment}: ${added} new companies from the last ${searches} searches (fewer than 1 in 100).`);
  }

  return {
    day,
    off,
    startsOn,
    run: todays
      ? {
          id: todays.id,
          status: todays.status,
          startedAt: todays.startedAt,
          finishedAt: todays.finishedAt,
          added: todays.stats.prospectsAdded,
          researched: todays.stats.processed,
          approved: todays.stats.drafted,
          disqualified: todays.stats.disqualified,
          searches: Number(todays.searches ?? 0),
          rounds: Number(todays.round ?? 0),
          error: todays.error,
        }
      : null,
    segments,
    searchesToday,
    budget: settings.dailySearchBudget,
    thin,
  };
}
