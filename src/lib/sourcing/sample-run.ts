import { and, asc, eq, getTableColumns, inArray, is, isNull, SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { clients, icps, leads, people, settings, sourcingTests, tasks, users, type Lead, type SourcingTest } from '../db/schema';
import { dealCapped, DRAW_HOUR_IST, DRAW_SEGMENTS, DRAWABLE, drawPool, handedOut, isTopContact, morningStartsOn, poolLeads, quotaOf, shuffle, teamQuotas, topAllowance, type DrawSegment, type Quota } from '../draw';
import { getHolidays } from '../holidays';
import { KnownBranches } from '../branches';
import { listKnownCompanies } from '../known-companies';
import { normSegment } from '../icp-match';
import { processLead } from '../pipeline/process-lead';
import { knowFirmPage } from '../pipeline/firm-identity';
import type { FitEvidence } from '../pipeline/fit';
import { mapLimit, type Services } from '../pipeline/services';
import { errorMessage, normCompany, rootDomain } from '../pipeline/text';
import { logActivity } from '../activity';
import { saveBacklog, takeBacklog } from './backlog';
import { activeSourcingTest, knownToInveck } from './test-run';
import { delegateProspects } from '../runs';
import { tierOf } from '../tiers';
import { firstWorkingDay, istDay, loadTodayTasks, nextWorkingDay, planSequence, worksCaFirms, type Holidays } from '../tasks';
import { CA_PER_ASSOCIATE } from '../ca-sheet';
import { LOGISTICS, MANUFACTURING } from '../db/seed';
import { PEOPLE_FIRST_EVIDENCE, PEOPLE_FIRST_SOURCE, MORNING_LIMITS, asLinkedInFinds, creditsOf, recentSearches, searchesThisMorning, searchRound, startRound, type MorningSourcing } from './morning';
import { pausedToday } from '../pause';
import { getSettings } from '../settings';
import { DeadGround, planFromMemory, rememberKept, rememberSearch, searchMemory } from './search-memory';
import { CHECKS_RESERVE } from '../search-budget';
import type { CompanyPage, SourcingSegment } from './linkedin-pages';
import type { FoundContact } from './people-first';

/**
 * The Morning Sample Run: tomorrow's 6 am run and 8 am draw, done now on paper. It searches people
 * first and researches what it finds exactly as the run does, then deals the leads to each associate
 * as the draw does (what is waiting in the pool now, plus what the search found), and keeps each
 * person's day in its report so the admin can see what they would get. Nothing is saved as a lead,
 * nobody is given anything, and the 6 am run's memory of its searches isn't touched (the sample keeps its
 * own, see search-memory.ts): tomorrow's run starts fresh. CA firms (Anchal and
 * Puja's ten each from the Google Sheet) are not part of it.
 */

/** Leads researched at a time, as in the run. */
const CONCURRENCY = 5;

/**
 * Rules tried in the Morning Sample Run first (the 6 am run doesn't use them yet):
 * - a company with no LinkedIn page, or whose page doesn't show an ICP industry, isn't researched (from 27 Oct 2026;
 *   before, it was passed to research: see lenientScreen);
 * - cheaper company checks with the same companies kept: names that show a company is outside the ICP
 *   aren't looked up, likely misfits are checked last, and up to six companies are looked up in one search
 *   (see cheaperChecks; from 28 Oct 2026, four before), a company that search doesn't show looked up on its own and
 *   its size checked only while companies are still needed; companies ruled out are remembered and not checked again;
 * - people searches of ten results, and a segment stops after 60 searches in a row find no new company (from 28 Oct
 *   2026, 15 that morning; before, nobody new on the lists, so people at companies already known kept it searching); a
 *   company ruled out in the last 90 days, or outside the ICP by its name, isn't a new company;
 * - a people search whose first page of ten was full and found new companies is read on at once: its first hundred
 *   results, 2 credits (from 28 Oct 2026);
 * - its people searches are remembered: one that found no new company isn't made again within 30 days, one made in
 *   the last 7 days that found companies is read further down rather than again (its first hundred results in one
 *   search, then the next hundred, to 300), an
 *   industry word and town that found nobody twice isn't searched with other titles, and the pairs that
 *   found companies that passed go first (see search-memory.ts);
 * - two contacts a company, with the hunt for a P1 when none is among them; the staff search stops once
 *   that is in hand; no Google search for the company's LinkedIn page (the search found it) or for officers
 *   in the news and filings; a person's profile looked up in the last 14 days, or the company's news
 *   checked in the last 7, isn't searched again;
 * - the people research found at a company count as checked on LinkedIn that day when it is pushed into
 *   the pipeline, so the 8 am contact check doesn't look them up again;
 * - 10% extra companies, 25 credits kept back for researching each company found, and 4,000 Google search
 *   credits at most for a new sample (3,000 until 27 Oct 2026): a search that would go over it isn't made.
 * A sample carried on from where it stopped uses them too.
 */
export const SAMPLE_RULES = { peopleResults: 10, quietSearches: 60, headroom: 1.1, credits: 4000, researchCredits: 25 } as const;

/**
 * 3PL & Logistics (INVECK's decision, 26 Oct 2026): fewer companies to find, and research rules more of them out, so
 * the cheaper rules above left its lists short. Its search goes on until 50 searches in a row found no new company, asks
 * for a quarter more than it is short of, and takes up to five rounds; and its company check is strict, as the run's:
 * a company with no LinkedIn page, or whose page doesn't show a 3PL industry, isn't passed to research. Still within
 * the sample's credits. Manufacturing keeps the rules above.
 */
export const SAMPLE_3PL_RULES = { quietSearches: 50, headroom: 1.25, rounds: 5, lenientScreen: false } as const;
const headroomFor = (s: string) => (s === LOGISTICS ? SAMPLE_3PL_RULES.headroom : SAMPLE_RULES.headroom);

/**
 * The segments still short that a sample searches again after research, `round` rounds in: the run's three rounds, and
 * for 3PL & Logistics up to five, each only while its own last round found companies (one that found nobody in 50
 * searches isn't searched again).
 */
export function segmentsToSearchAgain(short: Record<DrawSegment, number>, last: { segment: string; added: number }[], round: number): DrawSegment[] {
  const foundLast = (s: string) => last.some((h) => h.segment === s && h.added > 0) || !last.some((h) => h.segment === s);
  return DRAW_SEGMENTS.filter((s) => short[s] > 0 && (s === LOGISTICS ? round < SAMPLE_3PL_RULES.rounds && foundLast(s) : round < MORNING_LIMITS.rounds));
}

/** Why a search the sample's budget has no room for isn't made. */
export class OverBudget extends Error {}

/** Someone at a company, as research left them. */
export type SamplePerson = { name: string; title: string; tier: string; linkedin: string; location: string; isPrimary: boolean; setAside: boolean; whyNot: string };

export type SampleCompany = {
  /** Its id in this sample (negative: never a real lead's). */
  key: number;
  round: number;
  segment: SourcingSegment;
  employer: string;
  page: CompanyPage;
  /** What the LinkedIn page screen said, and where the company is, as the run would record it. */
  note: string;
  city: string;
  contacts: FoundContact[];
  /** After research: approved with a confirmed contact (can be dealt), ruled out by the ICP check, nobody to contact, failed, or left for the next day (over the search budget). */
  outcome?: 'approved' | 'ruled_out' | 'no_contact' | 'error' | 'waiting';
  why?: string;
  /** The lead as research left it, and the people it kept. */
  lead?: Lead;
  people?: SamplePerson[];
  /** The real lead it became when the admin pushed it into the pipeline. */
  pushed?: number;
  /** When research finished with it (ISO): the day its people were seen on LinkedIn. */
  researchedAt?: string;
  /** Its main contact is the head of the company (MD, CEO, owner): one of the at most 10% of each list (see TOP_CONTACT_SHARE). */
  topContact?: boolean;
};

/** Companies earlier searches found but didn't check, carried into this sample (checked first), per segment. */
export type Carried = Partial<Record<SourcingSegment, number>>;

/** One card on a person's day: a lead waiting in the pool now, or a company the sample found. */
export type SampleCard = { from: 'pool' | 'sample'; key: number; /** The head of the company (MD, CEO, owner) is its main contact. */ top?: boolean };

export type SampleHand = {
  userId: number;
  name: string;
  /** Works CA firms too (Anchal and Puja): their ten from the Google Sheet come on top, not in this sample. */
  ca: boolean;
  cards: SampleCard[];
  /** What their quota wanted that nothing was left to fill. */
  short: Record<DrawSegment, number>;
  /** Steps already due for them that day from earlier companies (follow-ups, callbacks, first contacts not done). */
  carried: { leadId: number; company: string; segment: string; step: string; kind: string; priority: boolean }[];
};

/** A sample run as started, before it has looked at anything. */
export type MorningSampleStart = {
  mode: 'morning';
  phase: 'init';
  fresh: boolean;
  /** Started on its own (see SCHEDULED_SAMPLES): its leads are added and given out when it finishes. */
  assign?: boolean;
  /** The morning it is for (the daily run: that same day), instead of the next draw's. */
  day?: string;
  /** A prospect search on this engine (see ProspectSearch), in place of a morning's lists. */
  find?: ProspectSearch;
};

/**
 * A prospect search (Find new prospects on the Dashboard, the Configuration page's run) on the sample's engine, its rules
 * and its credit limit (INVECK's decision, 26 Oct 2026: one capped engine wherever leads are found): the leads asked for
 * per segment (none: what the morning draw is short of) and who gets them: the morning draw (''), the whole team now
 * ('team') or one associate (their id). Nothing is dealt; its approved companies go into the pipeline when it finishes.
 */
export type ProspectSearch = { wanted: Partial<Record<DrawSegment, number>> | null; to: string };

export type MorningSampleReport = {
  mode: 'morning';
  /** The morning it shows: the next working day. */
  day: string;
  phase: 'search' | 'research' | 'deal' | 'done';
  /** Every list filled from the search alone: the leads already waiting in the pool are left out. */
  fresh: boolean;
  team: { id: number; name: string }[];
  /** The Settings quota (for anyone without their own numbers), and each associate's own, by id. */
  quota: Quota;
  quotas?: Record<string, Quota>;
  /** Per segment when it started: what the draw needs, what's waiting in the pool, what the search was asked for. */
  start: Record<DrawSegment, { need: number; pool: number; waiting: number; wanted: number }>;
  search: MorningSourcing | null;
  companies: SampleCompany[];
  /** The pool leads dealt, as they are now, with their people. */
  pool: { lead: Lead; people: SamplePerson[] }[];
  hands: SampleHand[];
  searches: number;
  researched: number;
  seconds: number;
  /** Google search credits the sample spent (search and research), against the day's budget when it started (none: no daily limit). Absent on samples from before the budget. */
  credits?: number;
  budget?: number;
  carried?: Carried;
  /** Its own leftovers (found, not checked) were kept for the next search. */
  leftKept?: boolean;
  /** Started on its own (see SCHEDULED_SAMPLES): its dealt leads are added as approved and given out as soon as it finishes. */
  autoAssign?: boolean;
  /** People searches left out of the plan, per segment, because earlier samples' same searches found nothing (see search-memory.ts). */
  skipped?: Partial<Record<SourcingSegment, number>>;
  /** What its Google search credits were spent on, per step (see spendStep); absent on samples from before 27 Oct 2026. */
  spend?: Record<string, number>;
  /** Its people searches per segment: how many found a new company, and how many found none (from 28 Oct 2026). */
  yields?: Partial<Record<SourcingSegment, { found: number; none: number }>>;
  /** A prospect search (see ProspectSearch), and what it added to the pipeline when it finished (see addFoundLeads). */
  find?: ProspectSearch;
  added?: { at: string; leads: number; given: string; skipped: string[] };
  /** Its dealt leads were put into the pipeline and given out as dealt (see assignSampleLeads): when, for which morning, to whom; `pooled`, leads left in the pool because that person's list for the day was already full. */
  assigned?: { at: string; day: string; given: { userId: number; name: string; leads: number }[]; skipped: string[]; pooled?: number };
};

export const isMorningSample = (r: unknown): r is MorningSampleReport => (r as MorningSampleReport | null)?.mode === 'morning' && (r as MorningSampleReport).phase !== ('init' as string);

/** A lead that exists only in this sample: every column at its default, then what the search found. */
export function sampleLead(key: number, fields: Partial<Lead>): Lead {
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(getTableColumns(leads))) {
    const d = col.default;
    out[name] = d === undefined ? null : is(d, SQL) ? new Date() : Array.isArray(d) ? [...d] : d;
  }
  return { ...(out as Lead), id: key, ...fields };
}

const asPerson = (p: { name: string; title?: string | null; tier?: string | null; linkedin?: string | null; location?: string | null; isPrimary?: boolean | null; passedAt?: Date | string | null; whyNot?: string | null }, icp?: Parameters<typeof tierOf>[1]): SamplePerson => ({
  name: p.name,
  title: p.title ?? '',
  tier: p.tier || (icp && p.title ? tierOf(p.title, icp) : ''),
  linkedin: p.linkedin ?? '',
  location: p.location ?? '',
  isPrimary: !!p.isPrimary,
  setAside: !!p.passedAt,
  whyNot: p.whyNot ?? '',
});

/**
 * What one Google search of a sample was for, read from the search itself: finding companies (the people searches, the
 * look-ups of their LinkedIn pages), then for each company researched its website, its LinkedIn page, the search for
 * its people, the look-ups of each person's own profile, its news, and searches to settle a must-have.
 */
export function spendStep(r: Pick<MorningSampleReport, 'phase' | 'companies'>, input: RequestInfo | URL, init?: RequestInit): string {
  const url = String(input instanceof Request ? input.url : input);
  let q = '';
  try {
    q = String(JSON.parse(String(init?.body ?? '{}')).q ?? '');
  } catch {}
  if (r.phase === 'search') {
    if (q.startsWith('site:linkedin.com/in')) return 'Finding companies: people searches';
    if (q.startsWith('site:linkedin.com/company')) return 'Finding companies: their LinkedIn pages';
    return 'Finding companies: other';
  }
  if (url.includes('/news')) return 'Research: news';
  if (url.includes('/maps')) return 'Research: towns on the map';
  if (q.startsWith('site:linkedin.com/company')) return 'Research: company LinkedIn page';
  if (q.startsWith('site:linkedin.com/in')) {
    // The search for a company's people names the company first; a look-up of one person's profile names the person.
    const first = normCompany(/"([^"]+)"/.exec(q)?.[1] ?? '');
    const firm = !!first && r.companies.some((c) => [c.employer, c.page?.name ?? '', c.lead?.company ?? ''].some((n) => n && normCompany(n) === first));
    return firm ? 'Research: contact search' : 'Research: contact checks (profile look-ups)';
  }
  if (q.startsWith('site:') || /official website/i.test(q)) return 'Research: website';
  if (q) return 'Research: must-have checks';
  return 'Research: other';
}

/** The company check's note on a company passed to research with its industry shown nowhere (see screenPage). */
const UNCLEAR_INDUSTRY = /industry not shown on LinkedIn or its website: research checks it/;

/** Research found the company in one of the ICP's industries. */
export function industryConfirmed(evidence: FitEvidence[] | null | undefined): boolean {
  return (evidence ?? []).some((e) => e.kind === 'industry' && e.status === 'met');
}

/**
 * Why a company the run checked wasn't approved, in a few words (null: approved, or not done yet): the report's tally of
 * where its credits went for nothing.
 */
export function rejectionReason(c: Pick<SampleCompany, 'outcome' | 'why'>): string | null {
  const why = c.why ?? '';
  if (!c.outcome) return null;
  if (c.outcome === 'approved') return /^Approved, but the contact isn't confirmed/.test(why) ? "Approved, but the contact isn't confirmed on LinkedIn" : null;
  if (c.outcome === 'waiting') return 'Not researched: over the credit limit';
  if (c.outcome === 'no_contact') return 'No acceptable contact found';
  if (c.outcome === 'error') return 'Research failed (an error)';
  if (/too small/i.test(why)) return 'Too small';
  if (/deal-breaker/i.test(why)) return 'A deal-breaker applies';
  if (/fails must-have/i.test(why)) return 'Shown to fail a must-have';
  if (/couldn't confirm must-have|not shown to be missing|marked not met without/i.test(why)) return 'A must-have not confirmed';
  if (/target not met/i.test(why)) return 'Size, place or industry target not met';
  if (/contradicts|failed the checks/i.test(why)) return "The AI's answer couldn't be used";
  if (/company name isn't confirmed/i.test(why)) return 'Company name not confirmed';
  if (/own list|own lead list/i.test(why)) return "Already on INVECK's own list";
  if (/matches no ICP/i.test(why)) return 'Matches no ICP';
  return why.replace(/^(Not a fit|Needs review|ICP fit not confirmed): /, '').slice(0, 80) || 'Other';
}

/** Can be dealt: qualified, with a named contact confirmed on LinkedIn (the draw's own rule). */
const releasable = (c: SampleCompany) => c.outcome === 'approved' && !!c.lead?.qualified && !!c.lead.contactName && !!c.lead.contactVerifiedAt;

/** What's still short per segment: the draw's need, less the pool and what the sample has ready (and is still researching). */
function stillShort(r: MorningSampleReport): Record<DrawSegment, number> {
  const out = {} as Record<DrawSegment, number>;
  // Leads with the head of the company as the main contact count only up to the team's share of them.
  let topRoom = r.team.reduce((a, t) => a + topAllowance(quotaFor(r, t.id)), 0);
  for (const s of DRAW_SEGMENTS) {
    const ready = r.companies.filter((c) => c.segment === s && releasable(c));
    const tops = Math.min(ready.filter((c) => c.topContact).length, topRoom);
    topRoom -= tops;
    const mine = ready.filter((c) => !c.topContact).length + tops + r.companies.filter((c) => c.segment === s && !c.outcome).length;
    out[s] = Math.max(0, r.start[s].need - (r.fresh ? 0 : r.start[s].pool) - mine);
  }
  return out;
}

/**
 * Works on a sample run (a sourcing_tests row in 'morning' mode) until it's done or `budgetMs` runs out
 * ('continue': saved, a new invocation carries on). Never throws: a failure is written to the row.
 */
export async function runMorningSample(db: Db, svc: Services, test: SourcingTest, started: number, budgetMs: number): Promise<'done' | 'continue'> {
  let report = isMorningSample(test.report) ? test.report : null;
  const earlierSeconds = report?.seconds ?? 0;
  let saving: Promise<unknown> = Promise.resolve();
  const save = (set: Partial<typeof sourcingTests.$inferInsert> = {}) => {
    if (report) report.seconds = earlierSeconds + Math.round((Date.now() - started) / 1000);
    const values = { ...set, ...(report ? { report: JSON.parse(JSON.stringify(report)) } : {}), updatedAt: new Date() };
    saving = saving.then(() => db.update(sourcingTests).set(values).where(eq(sourcingTests.id, test.id))).catch(() => {});
    return saving;
  };
  const outOfTime = (share: number) => Date.now() - started > budgetMs * share;
  // Every credit the sample spends is counted on it as the search is made, and a search that would take it
  // over its budget isn't made: the budget is a hard ceiling. (The day's count is kept as before.)
  const metered: Services = {
    ...svc,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const credits = creditsOf(input, init);
      if (credits && report) {
        const spent = report.credits ?? 0;
        if (report.budget && spent + credits > report.budget) throw new OverBudget(`The sample's ${report.budget.toLocaleString('en-IN')} Google search credits are used up`);
        report.credits = spent + credits;
        // And what it was for, for the report's "Where the credits went".
        const step = spendStep(report, input, init);
        (report.spend ??= {})[step] = (report.spend[step] ?? 0) + credits;
      }
      return svc.fetch(input, init);
    }) as typeof fetch,
  };
  try {
    if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set: the sample searches Google through Serper.');
    if (!report) {
      const start = test.report as MorningSampleStart | null;
      // A search for a number of leads looks for new companies only (the pool isn't counted against it).
      report = await begin(db, svc, start?.find?.wanted ? true : (start?.fresh ?? false), start?.day, start?.find);
      if (start?.assign) report.autoAssign = true;
      if (start?.find) report.find = start.find;
    }
    const r = report;
    const budgetLeft = () => (r.budget ?? Number.POSITIVE_INFINITY) - (r.credits ?? 0);
    // Stopped by the admin: it ends where it is (nothing more searched or researched).
    const stopped = async () => (await db.select({ status: sourcingTests.status }).from(sourcingTests).where(eq(sourcingTests.id, test.id)))[0]?.status !== 'running';

    for (let step = 0; ; step++) {
      if (await stopped()) {
        await keepLeftovers(db, r);
        await save();
        await saving;
        return 'done';
      }
      if (r.phase === 'search') {
        if (step > 0 && outOfTime(0.85)) break;
        const outcome = await searchRound(db, metered, r.search!, {
          started,
          budgetMs,
          log: async () => {},
          seed: test.id * 31,
          stopped,
          // As the run: the budget, less researching what was found and the 8 am contact checks.
          budgetLeft: async () => budgetLeft() - r.companies.filter((c) => !c.outcome).length * SAMPLE_RULES.researchCredits - CHECKS_RESERVE,
          peopleResults: SAMPLE_RULES.peopleResults,
          quietSearches: SAMPLE_RULES.quietSearches,
          deepReads: true,
          // Ground the searches have found empty, this run's included: not searched (28 Oct 2026).
          deadGround: async (segment) => new DeadGround(await searchMemory(db, segment, new Date())),
          rememberRuledOut: true,
          lenientScreen: true,
          // Both segments' company checks are strict (Manufacturing's from 27 Oct 2026): a company with no LinkedIn page, or
          // whose page doesn't show an ICP industry, isn't researched (and paid for) only to be ruled out.
          // Manufacturing's company whose LinkedIn page shows no industry either way (no label, or a catch-all one) goes to
          // research when its website doesn't settle it (from 28 Oct 2026), where it's approved only if research confirms
          // the industry (see industryConfirmed); one with no LinkedIn page still isn't (nothing shows its size).
          segmentRules: { [LOGISTICS]: { quietSearches: SAMPLE_3PL_RULES.quietSearches, lenientScreen: SAMPLE_3PL_RULES.lenientScreen }, [MANUFACTURING]: { lenientScreen: false, unclearIndustry: true } },
          cheaperChecks: true,
          recent: await recentSearches(db, null),
          // What earlier samples' searches found (before this one started, so the plan stays the same).
          plan: async (segment, plan) => {
            const out = planFromMemory(plan, await searchMemory(db, segment, new Date(test.startedAt)), new Date(test.startedAt));
            r.skipped = { ...r.skipped, [segment]: out.skipped };
            return out.plan;
          },
          alsoKnown: {
            names: r.companies.flatMap((c) => [c.page.name, c.employer]),
            domains: r.companies.map((c) => rootDomain(c.page.website)).filter(Boolean),
            pages: r.companies.map((c) => c.page.url).filter(Boolean),
          },
          sink: {
            save: async () => {
              r.searches = r.search!.searches;
              await save({ progress: progressOf(r) });
            },
            async add(c) {
              r.companies.push({ key: -(r.companies.length + 1), round: r.search!.round, segment: c.segment, employer: c.employer, page: c.page, note: c.note, city: c.city, contacts: c.contacts });
              if (c.via) await rememberKept(db, c.segment, c.via).catch(() => {});
              await save({ progress: progressOf(r) });
            },
            async searched(segment, pq, result) {
              await rememberSearch(db, segment, { ...pq, page: result.page, num: result.num }, { listed: result.listed, fresh: result.newCompanies, results: result.results, error: result.error }).catch(() => {});
              // For the report: did the search find a new company?
              if (!result.error) {
                const y = ((r.yields ??= {})[segment] ??= { found: 0, none: 0 });
                if (result.newCompanies) y.found++;
                else y.none++;
              }
            },
          },
        });
        r.searches = r.search!.searches;
        if (outcome === 'continue') break;
        r.phase = 'research';
        await save({ progress: progressOf(r) });
        continue;
      }

      if (r.phase === 'research') {
        const waiting = r.companies.filter((c) => !c.outcome);
        // Room for this many more at what research costs a company; none: the rest would be researched the next day.
        const room = Math.floor(budgetLeft() / SAMPLE_RULES.researchCredits);
        if (waiting.length && room < 1) {
          for (const c of waiting) Object.assign(c, { outcome: 'waiting', why: OVER_BUDGET_WHY });
          await save({ progress: progressOf(r) });
          continue;
        }
        if (waiting.length) {
          if (step > 0 && outOfTime(0.5)) break;
          await research(db, metered, waiting.slice(0, Math.min(CONCURRENCY, room)));
          r.researched = r.companies.filter((c) => c.outcome).length;
          await save({ progress: progressOf(r) });
          continue;
        }
        // Research ruled some out and the draw is still short: the run would search again. A round that
        // stopped for the budget goes on too when research cost less than was kept back for it.
        const short = stillShort(r);
        const last = r.search!.history.filter((h) => h.round === r.search!.round);
        const searchAgain = segmentsToSearchAgain(short, last, r.search!.round);
        const again =
          searchAgain.length > 0 &&
          last.some((h) => h.added > 0) &&
          !last.some((h) => h.stopped === 'failed') &&
          budgetLeft() > CHECKS_RESERVE + 50;
        if (again) {
          const wanted = Object.fromEntries(DRAW_SEGMENTS.map((s) => [s, searchAgain.includes(s) ? Math.ceil(short[s] * headroomFor(s)) : 0])) as Record<SourcingSegment, number>;
          r.search = startRound(r.search, wanted);
          r.phase = 'search';
        } else {
          await keepLeftovers(db, r);
          r.phase = 'deal';
        }
        await save({ progress: progressOf(r) });
        continue;
      }

      if (r.phase === 'deal') {
        // A prospect search deals nothing: what it found goes into the pipeline when it finishes.
        if (r.find) r.hands = [];
        else await deal(db, r);
        r.phase = 'done';
        await save({ status: 'done', finishedAt: new Date(), progress: summaryOf(r) });
      }
      break;
    }
    if (r.phase !== 'done') {
      await save({ progress: progressOf(r) });
      await saving;
      return 'continue';
    }
    // A prospect search: its approved companies go into the pipeline, to whoever it was for.
    if (r.find && !r.added) {
      await saving;
      try {
        await addFoundLeads(db, test.id);
      } catch (e) {
        await db.update(sourcingTests).set({ error: `Adding what it found to the pipeline failed: ${errorMessage(e)}. "Push into the pipeline" on the report can add them.` }).where(eq(sourcingTests.id, test.id));
      }
    }
    // Started on its own: the leads it dealt are added as approved and given out now, as the button would.
    if (r.autoAssign && !r.assigned) {
      await saving;
      try {
        await assignSampleLeads(db, test.id);
      } catch (e) {
        await db.update(sourcingTests).set({ error: `Giving out the leads failed: ${errorMessage(e)}. "Add as approved leads and assign them" on the report tries again.` }).where(eq(sourcingTests.id, test.id));
      }
    }
  } catch (e) {
    await save({ status: 'failed', finishedAt: new Date(), error: errorMessage(e), progress: report ? progressOf(report) : '' });
  }
  await saving;
  return 'done';
}

/**
 * Morning Sample Runs started on their own at these times (INVECK's evening runs: Sunday 25 October 2026, about 8 pm
 * India time, for Monday; Monday 26 October at 8 pm, for Tuesday, the first one started and woken by the outside
 * timer alone): the leads waiting in the pool first, then the search, research and deal as any sample, and its dealt
 * leads added as approved and given out when it finishes. Started once, by the first wake-up after the time (see
 * wake.ts), and not more than three hours late. From Tuesday 27 October, EVENING_SAMPLE does this every evening.
 */
export const SCHEDULED_SAMPLES = ['2026-10-25T14:20:00Z', '2026-10-26T14:30:00Z'];

/**
 * One-off runs for a day's lists, what each person already has for it left out, given out when they finish; started
 * once by the first wake-up after the time, not more than three hours late (INVECK, 28 Oct 2026: at 10:15 pm India
 * time, Thursday 29 October's lists after the 9 pm run left them short, to try that evening's rules).
 */
export const TOP_UP_SAMPLES: { at: string; day: string }[] = [
  { at: '2026-10-28T16:45:00Z', day: '2026-10-29' },
  // And at 12:30 am on Thursday 29 October (INVECK, 28 Oct 2026, night), with the new industry words and towns.
  { at: '2026-10-28T19:00:00Z', day: '2026-10-29' },
];

/**
 * The evening run (INVECK's decision, 26 Oct 2026): from Tuesday 27 October, each working day's run happens the evening
 * before, from 9 pm India time: a Morning Sample for the next day's lists (its leads given out when it finishes), on
 * the evening just before a working day the morning search runs (Sunday's for Monday; none on Friday or Saturday
 * evenings, or before a holiday or a paused day). Started once by the first wake-up from 9 pm (in the evening, the
 * outside timer). That morning's daily run (DAILY_SAMPLE) then fills only what is still missing.
 */
export const EVENING_SAMPLE = { from: '2026-10-27', startIst: 21 } as const;

/**
 * The daily run (INVECK's decision, 26 Oct 2026): from Tuesday 27 October, on every morning the search runs (a working
 * day, not a holiday or a paused day, the search on in Settings), a Morning Sample for that day's lists starts at 6 am
 * India time in place of the older 6 am run, and gives its leads out itself (the 8 am draw then fills only what is still
 * missing). Started once by the first check from 6 am (/api/cron and the other scheduled checks, the outside timer, the
 * Dashboard or Sourcing page), not from 2 pm.
 */
export const DAILY_SAMPLE = {
  from: '2026-10-27',
  startIst: 6,
  lastIst: 14,
  /** Days with no daily run (INVECK's decision, 26 Oct 2026, night: Tuesday 27 October's lists were filled the evening before). */
  skip: ['2026-10-27'] as readonly string[],
} as const;
/** From this day the older 6 am run doesn't start (Monday 26 October: no run; from Tuesday: the daily sample instead). */
export const OLD_RUN_UNTIL = '2026-10-26';

/** Starts a scheduled sample that is due and hasn't started (once, whoever calls); its id, or null. */
export async function startScheduledSample(db: Db, now = new Date()): Promise<number | null> {
  const today = istDay(now);
  const hourIst = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCHours();
  const daily =
    today >= DAILY_SAMPLE.from && !DAILY_SAMPLE.skip.includes(today) && hourIst >= DAILY_SAMPLE.startIst && hourIst < DAILY_SAMPLE.lastIst && !(await pausedToday(db, now)) && (await searchesThisMorning(db, await getSettings(db), now));
  // The evening run is for tomorrow: a day the morning search runs, and neither today nor tomorrow paused.
  const tomorrowAt = new Date(now.getTime() + 86_400_000);
  const tomorrow = istDay(tomorrowAt);
  const evening =
    today >= EVENING_SAMPLE.from && hourIst >= EVENING_SAMPLE.startIst && !(await pausedToday(db, now)) && !(await pausedToday(db, tomorrowAt)) && (await searchesThisMorning(db, await getSettings(db), tomorrowAt));
  const due = [
    ...SCHEDULED_SAMPLES.filter((at) => now.getTime() >= Date.parse(at) && now.getTime() - Date.parse(at) <= 3 * 3600_000).map((at) => ({ key: `scheduledSample:${at}`, day: undefined as string | undefined })),
    ...TOP_UP_SAMPLES.filter(({ at }) => now.getTime() >= Date.parse(at) && now.getTime() - Date.parse(at) <= 3 * 3600_000).map(({ at, day }) => ({ key: `scheduledSample:topUp:${at}`, day })),
    ...(daily ? [{ key: `scheduledSample:daily:${today}`, day: today }] : []),
    ...(evening ? [{ key: `scheduledSample:evening:${tomorrow}`, day: tomorrow }] : []),
  ];
  for (const { key, day } of due) {
    // A claim that never got as far as starting the sample (the request died) is let go after two minutes.
    const [was] = await db.select().from(settings).where(eq(settings.key, key));
    const held = was?.value as { claimedAt?: string; testId?: number } | undefined;
    if (held && !held.testId && now.getTime() - Date.parse(held.claimedAt ?? '') > 120_000) await db.delete(settings).where(eq(settings.key, key));
    const claimed = await db.insert(settings).values({ key, value: { claimedAt: now.toISOString() } }).onConflictDoNothing().returning({ key: settings.key });
    if (!claimed.length) continue;
    try {
      const start: MorningSampleStart = { mode: 'morning', phase: 'init', fresh: false, assign: true, ...(day ? { day } : {}) };
      const [test] = await db.insert(sourcingTests).values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, progress: 'Starting (scheduled)…', report: start }).returning({ id: sourcingTests.id });
      await db.update(settings).set({ value: { claimedAt: now.toISOString(), testId: test.id } }).where(eq(settings.key, key));
      return test.id;
    } catch (e) {
      await db.delete(settings).where(eq(settings.key, key));
      throw e;
    }
  }
  return null;
}

/** The admin stops a running sample: it ends where it is, and what it found can still be pushed into the pipeline. */
export async function stopSample(db: Db, id: number): Promise<boolean> {
  const done = await db
    .update(sourcingTests)
    .set({ status: 'failed', error: 'Stopped by you. The report shows what it got to.', finishedAt: new Date() })
    .where(and(eq(sourcingTests.id, id), eq(sourcingTests.mode, 'morning'), eq(sourcingTests.status, 'running')))
    .returning({ id: sourcingTests.id });
  return done.length > 0;
}

const timestampColumns = new Set(Object.entries(getTableColumns(leads)).filter(([, c]) => c.dataType === 'date').map(([k]) => k));

/**
 * Puts companies a sample found into the pipeline as real leads, nobody's yet (the 8 am draw deals them).
 * One research finished stays as research left it: an approved one is ready to be dealt, with its contact
 * and drafts, and isn't researched (or paid for) again. One not researched goes in as the 6 am run would
 * add it: New, with the people found there, and the pipeline researches it. One already in the pipeline
 * (by LinkedIn page, name or website) is left out. Only once the sample has stopped or finished.
 */
export async function pushSampleCompanies(db: Db, testId: number, keys: number[]): Promise<{ pushed: number; skipped: string[] }> {
  const [test] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, testId));
  if (!test || test.status === 'running' || !isMorningSample(test.report)) return { pushed: 0, skipped: [] };
  const r = test.report;
  const wanted = new Set(keys);
  const existing = await db.select({ company: leads.company, website: leads.website, page: leads.companyLinkedin }).from(leads);
  const names = new Set(existing.map((l) => normCompany(l.company)));
  const domains = new Set(existing.map((l) => rootDomain(l.website)).filter(Boolean));
  const pages = new Set(existing.map((l) => l.page).filter(Boolean));
  let pushed = 0;
  const skipped: string[] = [];
  for (const c of r.companies) {
    if (!wanted.has(c.key) || c.pushed) continue;
    const name = c.page.nameCut ? c.employer : c.page.name;
    const domain = rootDomain(c.page.website);
    if ((c.page.url && pages.has(c.page.url)) || names.has(normCompany(name)) || (domain && domains.has(domain))) {
      skipped.push(name);
      continue;
    }
    const researched = !!c.lead && !!c.outcome && c.outcome !== 'waiting' && c.outcome !== 'error';
    let leadId: number;
    if (researched) {
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.lead!)) {
        if (k === 'id' || !(k in getTableColumns(leads))) continue;
        values[k] = timestampColumns.has(k) && typeof v === 'string' ? new Date(v) : v;
      }
      Object.assign(values, { ownerId: null, processingStartedAt: null, createdAt: new Date(), updatedAt: new Date() });
      if (values.status === 'Processing') values.status = 'New';
      const [lead] = await db.insert(leads).values(values as typeof leads.$inferInsert).returning({ id: leads.id });
      leadId = lead.id;
      const kept = c.people ?? [];
      // The others research kept were found on LinkedIn working here that day (the people search reads
      // only current jobs here): checked then, so the 8 am contact check doesn't look them up again.
      const seenAt = researchTime(c);
      if (kept.length) {
        await db.insert(people).values(
          kept.map((p) => ({
            leadId,
            name: p.name,
            title: p.title,
            linkedin: p.linkedin,
            location: p.location,
            isPrimary: p.isPrimary,
            source: 'LinkedIn',
            whyNot: p.whyNot,
            ...(p.setAside ? { passedAt: new Date(), passedReason: 'excluded' } : !p.isPrimary ? { checkedAt: seenAt } : {}),
          })),
        );
      }
    } else {
      const best = c.contacts[0];
      const [lead] = await db
        .insert(leads)
        .values({
          company: name,
          nameAsFound: c.employer,
          website: c.page.website,
          city: c.city,
          segment: c.segment,
          status: 'New',
          companyLinkedin: c.page.url,
          source: `${PEOPLE_FIRST_SOURCE}: ${best.name}, ${best.title} (${best.tier}), on LinkedIn; company page ${c.page.url || 'not found'} (${c.page.size || 'size not shown'}${c.page.industry ? `, ${c.page.industry}` : ''})`,
        })
        .returning({ id: leads.id });
      leadId = lead.id;
      if (c.contacts.length) await db.insert(people).values(c.contacts.map((p) => ({ leadId, name: p.name, title: p.title, linkedin: p.linkedin, location: p.location, source: 'LinkedIn', evidence: PEOPLE_FIRST_EVIDENCE })));
    }
    await logActivity(db, leadId, 'added', `Pushed into the pipeline from Morning Sample Run ${testId}${researched ? ' (researched there)' : ': not researched yet, so the pipeline researches it'}. Company page: ${c.page.url || 'none found on LinkedIn'}.`);
    c.pushed = leadId;
    pushed++;
    names.add(normCompany(name));
    if (c.page.url) pages.add(c.page.url);
    if (domain) domains.add(domain);
  }
  await db.update(sourcingTests).set({ report: JSON.parse(JSON.stringify(r)) }).where(eq(sourcingTests.id, testId));
  return { pushed, skipped };
}

/**
 * A finished prospect search's approved companies into the pipeline as research left them (see pushSampleCompanies),
 * then given to whoever it was for (the morning draw: nobody yet, it deals them). Once; again, it changes nothing.
 */
export async function addFoundLeads(db: Db, testId: number, now = new Date()): Promise<NonNullable<MorningSampleReport['added']> | null> {
  const [test] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, testId));
  if (!test || test.status === 'running' || !isMorningSample(test.report) || !test.report.find || test.report.phase !== 'done') return null;
  if (test.report.added) return test.report.added;
  const keys = test.report.companies.filter((c) => c.outcome === 'approved').map((c) => c.key);
  const pushed = await pushSampleCompanies(db, testId, keys);
  const [after] = await db.select({ report: sourcingTests.report }).from(sourcingTests).where(eq(sourcingTests.id, testId));
  const r = after.report as MorningSampleReport;
  const ids = r.companies.filter((c) => keys.includes(c.key) && c.pushed).map((c) => c.pushed!);
  const given = await delegateProspects(db, ids, r.find!.to);
  const added = { at: now.toISOString(), leads: ids.length, given, skipped: pushed.skipped };
  const done = { ...r, added };
  await db.update(sourcingTests).set({ report: JSON.parse(JSON.stringify(done)), progress: summaryOf(done) }).where(eq(sourcingTests.id, testId));
  return added;
}

/** Starts a prospect search (one sample at a time: one already running is shown instead); its id. */
export async function startProspectSearch(db: Db, find: ProspectSearch, startedBy?: number): Promise<{ id: number; created: boolean }> {
  const running = await activeSourcingTest(db, 'morning');
  if (running) return { id: running.id, created: false };
  const start: MorningSampleStart = { mode: 'morning', phase: 'init', fresh: !!find.wanted, find };
  const [test] = await db
    .insert(sourcingTests)
    .values({ segment: 'Manufacturing and 3PL & Logistics', mode: 'morning', companies: 0, ...(startedBy ? { startedBy } : {}), progress: 'Starting the prospect search…', report: start })
    .returning({ id: sourcingTests.id });
  return { id: test.id, created: true };
}

/**
 * For a morning the 8 am draw doesn't run: puts every lead a finished sample dealt into the pipeline and gives it
 * to the associate the sample dealt it to, as the draw would have. The sample's own companies go in as research
 * left them (Approved, with their contact and drafts; see pushSampleCompanies); a pool lead it dealt is given out
 * if nobody has it yet. Each counts as handed out on the sample's morning (today, once that has passed), and its
 * Day 1 steps are due then. A lead someone already has, or one already in the pipeline as another lead, is left
 * as it is (`skipped`). Nobody gets more than their list for that day: a lead over it stays in the pool, nobody's, for
 * the next draw (`pooled`). Giving out again changes nothing.
 */
export async function assignSampleLeads(db: Db, testId: number, now = new Date()): Promise<NonNullable<MorningSampleReport['assigned']> | null> {
  const [test] = await db.select().from(sourcingTests).where(eq(sourcingTests.id, testId));
  if (!test || test.status === 'running' || !isMorningSample(test.report) || test.report.phase !== 'done') return null;
  if (test.report.assigned) return test.report.assigned;
  const dealt = test.report.hands.flatMap((h) => h.cards.filter((c) => c.from === 'sample').map((c) => c.key));
  const pushed = await pushSampleCompanies(db, testId, dealt);
  // Read again: pushing recorded each company's new lead.
  const [after] = await db.select({ report: sourcingTests.report }).from(sourcingTests).where(eq(sourcingTests.id, testId));
  const r = after.report as MorningSampleReport;
  const today = istDay(now);
  const day = r.day > today ? r.day : today;
  const holidays = await getHolidays(db);
  const active = new Set((await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true)))).map((u) => u.id));
  // Never more than anyone's list for the day: what they were already given for it (the 8 am draw, another sample) counts.
  const quotas = await teamQuotas(db);
  const handed = await handedOut(db, day);
  const room = (owner: number, segment: DrawSegment) => (quotas.get(owner)?.[segment] ?? 0) - (handed[String(owner)]?.[segment] ?? 0);
  const given: NonNullable<MorningSampleReport['assigned']>['given'] = [];
  const skipped = [...pushed.skipped];
  let pooled = 0;
  for (const h of r.hands) {
    let n = 0;
    for (const card of h.cards) {
      const company = card.from === 'sample' ? r.companies.find((c) => c.key === card.key) : undefined;
      const poolLead = card.from === 'pool' ? r.pool.find((p) => p.lead.id === card.key)?.lead : undefined;
      const name = company ? (company.page.nameCut ? company.employer : company.page.name) : (poolLead?.company ?? `Lead ${card.key}`);
      const segment = DRAW_SEGMENTS.find((s) => normSegment(s) === normSegment(company?.segment ?? poolLead?.segment ?? ''));
      const leadId = card.from === 'sample' ? company?.pushed : card.key;
      if (!leadId || !active.has(h.userId)) {
        if (leadId) skipped.push(name);
        continue;
      }
      // Their list for the day is full already: the lead stays in the pool (approved, nobody's) for the next draw.
      if (!segment || room(h.userId, segment) <= 0) {
        pooled++;
        continue;
      }
      // Only a lead nobody has yet, still ready to be worked.
      const [lead] = await db
        .update(leads)
        .set({ ownerId: h.userId, drawnOn: day, updatedAt: now })
        .where(and(eq(leads.id, leadId), isNull(leads.ownerId), inArray(leads.status, DRAWABLE)))
        .returning({ id: leads.id });
      if (!lead) {
        skipped.push(name);
        continue;
      }
      const open = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.leadId, lead.id), isNull(tasks.doneAt))).limit(1);
      if (!open.length) await db.insert(tasks).values(planSequence(day, holidays).map((t) => ({ ...t, leadId: lead.id, ownerId: h.userId })));
      await logActivity(db, lead.id, 'note', `Given to ${h.name} from Morning Sample Run ${testId}, for ${day} (as the sample dealt it)`);
      const hand = (handed[String(h.userId)] ??= {});
      hand[segment] = (hand[segment] ?? 0) + 1;
      n++;
    }
    if (n) given.push({ userId: h.userId, name: h.name, leads: n });
  }
  const assigned = { at: now.toISOString(), day, given, skipped: [...new Set(skipped)], ...(pooled ? { pooled } : {}) };
  await db.update(sourcingTests).set({ report: JSON.parse(JSON.stringify({ ...r, assigned })) }).where(eq(sourcingTests.id, testId));
  return assigned;
}

/** When research finished with a company (samples from before this was kept: when it assessed the fit or checked the news). */
function researchTime(c: SampleCompany): Date {
  const at = c.researchedAt ?? c.lead?.assessedAt ?? c.lead?.signalsCheckedAt;
  const d = at ? new Date(at) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * The morning a sample shows: the next draw's. Today's on a working day before 8 am (a sample run just
 * after midnight shows the morning about to come), else the next working day's.
 */
export function sampleMorning(now: Date, holidays: Holidays): string {
  const today = istDay(now);
  const hour = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCHours();
  return firstWorkingDay(today, holidays) === today && hour < DRAW_HOUR_IST ? today : nextWorkingDay(today, holidays);
}

/** The morning it shows, the team and quotas, and what the search is asked for: the draw's shortfall, plus a quarter. */
async function begin(db: Db, svc: Services, fresh: boolean, forDay?: string, find?: ProspectSearch): Promise<MorningSampleReport> {
  const holidays = await getHolidays(db);
  // Not before the day the morning search and draw start (the live database: 22 Oct 2026).
  const startsOn = await morningStartsOn(db);
  const next = forDay ?? sampleMorning(new Date(), holidays);
  const day = startsOn && next < startsOn ? firstWorkingDay(startsOn, holidays) : next;
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(asc(users.id));
  const quota = quotaOf(svc.settings);
  const own = await teamQuotas(db, svc.settings);
  // The daily run (for that same day): what each person was already given for it (the 8 am draw, when it starts later) is left out.
  const given = forDay ? await handedOut(db, day) : {};
  const left = (q: Quota, g?: Quota): Quota => (g ? (Object.fromEntries(DRAW_SEGMENTS.map((s) => [s, Math.max(0, q[s] - (g[s] ?? 0))])) as Quota) : q);
  const quotas = Object.fromEntries(team.map((t) => [String(t.id), left(own.get(t.id) ?? quota, given[String(t.id)])]));
  const pool = await drawPool(db);
  // Companies already waiting for research: the run researches them first; the sample can't show them.
  const waitingRows = await db.select({ segment: leads.segment }).from(leads).where(inArray(leads.status, ['New', 'Processing']));
  const start = {} as MorningSampleReport['start'];
  const wanted = {} as Record<SourcingSegment, number>;
  for (const s of DRAW_SEGMENTS) {
    const need = find?.wanted ? (find.wanted[s] ?? 0) : Object.values(quotas).reduce((a, q) => a + q[s], 0);
    const short = Math.max(0, need - (fresh ? 0 : pool.bySegment[s]));
    wanted[s] = Math.ceil(short * headroomFor(s));
    start[s] = { need, pool: pool.bySegment[s], waiting: waitingRows.filter((w) => normSegment(w.segment) === normSegment(s)).length, wanted: wanted[s] };
  }
  // Companies earlier searches found but didn't check go first: no people search is paid for them again.
  const search = startRound(null, wanted);
  const known = (await knownToInveck(db)).names;
  const carried: Carried = {};
  for (const seg of search.segments) {
    if (!seg.wanted) continue;
    const taken = await takeBacklog(db, seg.segment, known);
    seg.pending.push(...taken.map((c) => ({ employer: c.employer, contacts: c.contacts })));
    carried[seg.segment] = taken.length;
  }
  // The day's budget when one is set, never more than the sample's own ceiling.
  const budget = Math.min(svc.settings.dailySearchBudget || SAMPLE_RULES.credits, SAMPLE_RULES.credits);
  return { mode: 'morning', day, phase: 'search', fresh, budget, credits: 0, team, quota, quotas, start, search, companies: [], pool: [], hands: [], searches: 0, researched: 0, seconds: 0, carried };
}

/** Keeps what a sample found but didn't check for the next search (once). */
async function keepLeftovers(db: Db, r: MorningSampleReport) {
  if (r.leftKept || !r.search) return;
  for (const seg of r.search.segments) {
    const checked = new Set(seg.checked);
    await saveBacklog(db, seg.segment, seg.pending.filter((c) => !checked.has(normCompany(c.employer))));
  }
  r.leftKept = true;
}

/** Why a company found isn't researched in the sample. */
const OVER_BUDGET_WHY = 'Over the Google search budget: the run would research it the next day';

/**
 * Researches a few of the sample's companies exactly as the run would (the ICP check, contacts, drafts), keeping
 * the result in the report. One whose research reached the budget's ceiling (a search it needed wasn't made)
 * is left for the next day, as the run would leave it, rather than kept half researched.
 */
async function research(db: Db, svc: Services, batch: SampleCompany[]) {
  const [allIcps, clientList, taken, known] = await Promise.all([
    db.select().from(icps).orderBy(asc(icps.id)),
    db.select().from(clients),
    db.select({ leadId: leads.id, company: leads.company, website: leads.website, contactName: leads.contactName }).from(leads),
    listKnownCompanies(db),
  ]);
  const ownLeads = new KnownBranches(known, []);
  await mapLimit(batch, CONCURRENCY, async (c) => {
    let overBudget = false;
    const own: Services = {
      ...svc,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await svc.fetch(input, init);
        } catch (e) {
          if (e instanceof OverBudget) overBudget = true;
          throw e;
        }
      }) as typeof fetch,
    };
    const best = c.contacts[0];
    const lead = sampleLead(c.key, {
      company: c.page.nameCut ? c.employer : c.page.name,
      nameAsFound: c.employer,
      website: c.page.website,
      companyLinkedin: c.page.url,
      city: c.city,
      segment: c.segment,
      status: 'Processing',
      source: `${PEOPLE_FIRST_SOURCE}: ${best.name}, ${best.title} (${best.tier}), on LinkedIn; company page ${c.page.url || 'not found'} (${c.page.size || 'size not shown'}${c.page.industry ? `, ${c.page.industry}` : ''})`,
    });
    try {
      // Its LinkedIn page is known already: research doesn't search for it again (a sample rule).
      if (c.page.url) await knowFirmPage(own, lead.company, c.page.website, c.page);
      const result = await processLead(own, lead, { icps: allIcps, clients: clientList, taken: taken.filter((t) => t.contactName), ownLeads }, async () => {}, {
        teamContact: false,
        found: asLinkedInFinds(c.contacts),
        lean: true,
      });
      const { people: found, ...update } = result;
      const icp = allIcps.find((i) => normSegment(i.segment) === normSegment(c.segment));
      c.lead = { ...lead, ...update } as Lead;
      c.people = (found ?? []).map((p) => asPerson(p, icp));
      // Passed to research because its industry showed nowhere: approved only when research confirms the industry (INVECK,
      // 28 Oct 2026: no weaker leads for it).
      if (update.status === 'Approved' && UNCLEAR_INDUSTRY.test(c.note) && !industryConfirmed(update.fitEvidence)) {
        const why = "Not approved: its industry isn't shown on LinkedIn or its website, and research couldn't confirm it";
        Object.assign(update, { status: 'Disqualified', qualified: false, fitStatus: 'review', fitDecision: why, finalScore: null });
        c.lead = { ...c.lead, ...update } as Lead;
      }
      const s = update.status;
      c.outcome = s === 'Approved' ? 'approved' : s === 'Deleted' ? 'no_contact' : s === 'Error' ? 'error' : 'ruled_out';
      c.why = s === 'Approved' ? update.fitReason ?? '' : update.deletedReason || update.fitDecision || update.fitReason || update.lastError || s || '';
      if (c.outcome === 'approved' && !releasable(c)) c.why = `Approved, but the contact isn't confirmed on LinkedIn yet, so the draw would hold it back`;
      c.topContact = !!c.lead.contactName && isTopContact(c.lead, allIcps);
      c.researchedAt = new Date().toISOString();
    } catch (e) {
      c.outcome = 'error';
      c.why = errorMessage(e);
    }
    if (overBudget) Object.assign(c, { outcome: 'waiting', why: OVER_BUDGET_WHY, lead: undefined, people: undefined, researchedAt: undefined });
  });
}

/**
 * The 8 am draw on paper: in each segment, every associate's quota, picked at random from the pool
 * (as the draw picks) and what the sample found ready, and dealt round the team.
 */
async function deal(db: Db, r: MorningSampleReport) {
  const team = r.team.map((t) => t.id);
  const hands = new Map(r.team.map((t) => [t.id, { userId: t.id, name: t.name, ca: worksCaFirms(t.name), cards: [] as SampleCard[], short: { ...Object.fromEntries(DRAW_SEGMENTS.map((s) => [s, 0])) } as Record<DrawSegment, number>, carried: [] as SampleHand['carried'] }]));
  const poolUsed: Lead[] = [];
  // As the draw: at most 10% of each person's list with the head of the company as the main contact.
  const icpList = await db.select().from(icps);
  const topLeft = new Map(team.map((t) => [t, topAllowance(quotaFor(r, t))] as const));
  for (const s of DRAW_SEGMENTS) {
    const need = team.reduce((a, t) => a + quotaFor(r, t)[s], 0);
    if (!need) continue;
    // A few more from the pool than needed, for those passed over at the cap.
    const pool = r.fresh ? [] : await poolLeads(db, s, need + 20);
    const mine = r.companies.filter((c) => c.segment === s && releasable(c));
    const cards: SampleCard[] = shuffle([
      ...pool.map((l) => ({ from: 'pool' as const, key: l.id, top: isTopContact(l, icpList) })),
      ...mine.map((c) => ({ from: 'sample' as const, key: c.key, top: !!c.topContact })),
    ]);
    const deficits = new Map(team.map((t) => [t, quotaFor(r, t)[s]] as const).filter(([, n]) => n > 0));
    for (const [owner, dealt] of dealCapped(cards.map((c) => ({ item: c, top: !!c.top })), deficits, topLeft, Math.floor(Math.random() * Math.max(1, deficits.size)))) {
      const h = hands.get(owner)!;
      h.cards.push(...dealt);
      h.short[s] = quotaFor(r, owner)[s] - dealt.length;
      topLeft.set(owner, (topLeft.get(owner) ?? 0) - dealt.filter((c) => c.top).length);
      poolUsed.push(...pool.filter((l) => dealt.some((c) => c.from === 'pool' && c.key === l.id)));
    }
  }
  const ids = poolUsed.map((l) => l.id);
  const poolPeople = ids.length ? await db.select().from(people).where(inArray(people.leadId, ids)) : [];
  r.pool = poolUsed.map((lead) => ({ lead, people: poolPeople.filter((p) => p.leadId === lead.id).map((p) => asPerson(p)) }));
  // Their day also has what's already due from earlier companies.
  for (const h of hands.values()) {
    const due = await loadTodayTasks(db, h.userId, r.day, new Date(`${r.day}T10:00:00+05:30`));
    const seen = new Set<string>();
    for (const { task, lead } of due) {
      const k = `${lead.id}:${task.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      h.carried.push({ leadId: lead.id, company: lead.company, segment: lead.segment, step: task.step, kind: task.kind, priority: task.priority });
    }
  }
  // Manufacturing first on each person's list, as the segments are dealt.
  for (const h of hands.values()) h.cards.sort((a, b) => Number(segOf(r, b) === MANUFACTURING) - Number(segOf(r, a) === MANUFACTURING));
  r.hands = [...hands.values()];
}

/** An associate's daily list in the sample: their own numbers when it ran, else the Settings ones. */
export const quotaFor = (r: Pick<MorningSampleReport, 'quota' | 'quotas'>, userId: number): Quota => r.quotas?.[String(userId)] ?? r.quota;

const segOf = (r: MorningSampleReport, c: SampleCard) =>
  c.from === 'sample' ? r.companies.find((x) => x.key === c.key)?.segment : r.pool.find((p) => p.lead.id === c.key)?.lead.segment;

export function progressOf(r: MorningSampleReport): string {
  const found = r.companies.length;
  if (r.phase === 'search') {
    const wanted = r.search!.segments.map((s) => `${s.added} of ${s.wanted} ${s.segment}`).join(', ');
    return `Round ${r.search!.round}: searching LinkedIn for people (${wanted}; ${credits(r)})…`;
  }
  if (r.phase === 'research') return `Researching what the search found: ${r.researched} of ${found} done (the ICP check, contacts and drafts, as the run does; ${credits(r)})…`;
  if (r.phase === 'deal') return r.find ? 'Adding what it found to the pipeline…' : 'Dealing the leads to the team as the 8 am draw would…';
  return summaryOf(r);
}

export function summaryOf(r: MorningSampleReport): string {
  const approved = r.companies.filter(releasable).length;
  if (r.find) {
    const waitingFor = r.companies.filter((c) => c.outcome === 'waiting').length;
    const added = r.added ? `; ${r.added.leads} added to the pipeline as approved leads${r.added.given ? ` (${r.added.given.replace(/^New prospects handed out: /, 'given to ')})` : ', for the morning draw'}` : '';
    return `${r.companies.length} companies found, ${r.companies.filter((c) => c.outcome === 'approved').length} approved${waitingFor ? `, ${waitingFor} left for the next day (over the search budget)` : ''}${added}. ${credits(r)}.`;
  }
  const dealt = r.hands.reduce((a, h) => a + h.cards.length, 0);
  const wanted = r.team.reduce((a, t) => a + DRAW_SEGMENTS.reduce((b, s) => b + quotaFor(r, t.id)[s], 0), 0);
  const waiting = r.companies.filter((c) => c.outcome === 'waiting').length;
  const tops = r.hands.reduce((a, h) => a + h.cards.filter((c) => c.top).length, 0);
  const heldBack = r.companies.filter((c) => releasable(c) && c.topContact).length - r.hands.reduce((a, h) => a + h.cards.filter((c) => c.from === 'sample' && c.top).length, 0);
  const top = tops || heldBack ? ` ${tops} of them with the MD, CEO or owner as the contact (at most 10% of each list)${heldBack > 0 ? `; ${heldBack} more like that kept back by the cap` : ''}.` : '';
  return `${r.companies.length} companies found, ${approved} approved with a confirmed contact${waiting ? `, ${waiting} left for the next day (over the search budget)` : ''}; ${dealt} of ${wanted} leads dealt to ${r.team.length} associates.${top} ${credits(r)}.`;
}

/** The Google search credits a sample spent, against its budget when there is one. */
function credits(r: MorningSampleReport): string {
  const used = (r.credits ?? 0).toLocaleString('en-IN');
  if (r.budget) return `${used} of ${r.budget.toLocaleString('en-IN')} Google search credits`;
  return r.credits === undefined ? `${r.searches} Google searches` : `${used} Google search credits`;
}

/** A card's lead and people, wherever it came from. */
export function cardLead(r: MorningSampleReport, c: SampleCard): { lead: Lead; people: SamplePerson[]; company?: SampleCompany } | null {
  if (c.from === 'pool') {
    const p = r.pool.find((x) => x.lead.id === c.key);
    return p ? { lead: p.lead, people: p.people } : null;
  }
  const company = r.companies.find((x) => x.key === c.key);
  return company?.lead ? { lead: company.lead, people: company.people ?? [], company } : null;
}

export { CA_PER_ASSOCIATE };
