import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { icps, leads, people, prospectSearches, runs, type Lead, type Run } from '../db/schema';
import { DEFAULT_ICPS } from '../db/seed';
import { activeTeam, drawPool, quotaOf, quotaTotal } from '../draw';
import { normSegment } from '../icp-match';
import { logActivity } from '../activity';
import { placeNamedIn, registerFirmWebsite } from '../pipeline/employer';
import { normQuery } from '../pipeline/query-history';
import { googleSearch, mapLimit, type SerperResult, type Services } from '../pipeline/services';
import { errorMessage, normCompany, rootDomain } from '../pipeline/text';
import { contactPriority } from '../tiers';
import { istDay, istDayBounds } from '../tasks';
import { factsQuery, hqAbroad, needsFacts, screenPage, SEGMENT_SEARCH, shuffled, SOURCING_SEGMENTS, withFacts, type CompanyPage, type SourcingSegment } from './linkedin-pages';
import { companyQuery, matchingPage, PEOPLE_KEYWORDS, readPerson, searchTitles, type FoundContact, type PeopleQuery } from './people-first';
import { knownToInveck } from './test-run';

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
const PEOPLE_FIRST_EVIDENCE = 'Found by the people-first search: their LinkedIn profile shows this company as their current job';

export const MORNING_LIMITS = {
  /** Google searches the prospect search may make in one India day, across runs. */
  dailySearches: 3000,
  /** Times one run searches again after research ruled companies out. */
  rounds: 3,
  /** A segment stops when this many searches in a row found nobody new on the ICP's lists. */
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
  /** Searches made from the plan, and how many in a row found nobody new on the lists. */
  cursor: number;
  quiet: number;
  /** Why it stopped: it had what was wanted, hit the day's search limit, stopped finding anyone, ran out of searches, or Google failed. */
  stopped?: 'target' | 'cap' | 'dry' | 'exhausted' | 'failed';
  /** Companies found with contacts, not checked yet. */
  pending: { employer: string; contacts: FoundContact[] }[];
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
};

const isSerper = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input).includes('google.serper.dev');
const profileKey = (url: string) => url.toLowerCase().replace(/^https?:\/\/[a-z]+\./, '').replace(/\/+$/, '');

/** The segment's ICP as INVECK has it now (the starting one when it was never saved). */
async function icpFor(db: Db, segment: SourcingSegment) {
  const [row] = await db.select().from(icps).where(eq(icps.segment, segment)).orderBy(desc(icps.active), icps.id).limit(1);
  return row ?? DEFAULT_ICPS.find((i) => i.segment === segment)!;
}

/**
 * Every search for one segment: each P1 and P2 title with every industry word and town, titles taken
 * in turn so every title is searched early, and the words and towns in an order that changes each run.
 */
export function morningPlan(segment: SourcingSegment, icp: Parameters<typeof searchTitles>[0], seed: number): PeopleQuery[] {
  const titles = searchTitles(icp);
  const pairs = shuffled(
    PEOPLE_KEYWORDS[segment].flatMap((k) => SEGMENT_SEARCH[segment].places.map((p) => [k, p] as const)),
    seed,
  );
  const out: PeopleQuery[] = [];
  for (let j = 0; j < pairs.length; j++) {
    titles.forEach((title, t) => {
      const [keyword, place] = pairs[(j + t * 7) % pairs.length];
      out.push({ q: ['site:linkedin.com/in', `"${title.replace(/"/g, '')}"`, `"${keyword}"`, place].join(' '), form: 'industry', title, keyword, place });
    });
  }
  return out;
}

/** Whether a scheduled run may still start another round before the draw. */
export function beforeLastRound(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const { hour, minute } = MORNING_LIMITS.lastRoundIst;
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() < hour * 60 + minute;
}

/**
 * What the morning draw is short of in each segment: the active associates times their quota, less
 * the researched leads waiting to be drawn and the companies still waiting for research.
 */
export async function drawShortfall(db: Db, settings: Services['settings']): Promise<Record<SourcingSegment, { need: number; pool: number; waiting: number; short: number }>> {
  const quota = quotaOf(settings);
  const team = await activeTeam(db);
  const pool = await drawPool(db);
  const waitingRows = await db
    .select({ segment: leads.segment, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(inArray(leads.status, ['New', 'Processing']), isNull(leads.ownerId), eq(leads.inbound, false)))
    .groupBy(leads.segment);
  const out = {} as Record<SourcingSegment, { need: number; pool: number; waiting: number; short: number }>;
  for (const s of SOURCING_SEGMENTS) {
    const need = team.length * quota[s];
    const waiting = waitingRows.filter((r) => normSegment(r.segment) === normSegment(s)).reduce((a, r) => a + Number(r.n), 0);
    out[s] = { need, pool: pool.bySegment[s], waiting, short: Math.max(0, need - pool.bySegment[s] - waiting) };
  }
  return out;
}

/** Google searches the prospect search made today (India time) on other runs. */
async function searchesTodayElsewhere(db: Db, runId: number): Promise<number> {
  const { start } = istDayBounds(istDay());
  const [{ used }] = await db
    .select({ used: sql<number>`coalesce(sum((${runs.sourcing}->>'searches')::int), 0)::int` })
    .from(runs)
    .where(and(gte(runs.startedAt, start), ne(runs.id, runId)));
  return Number(used);
}

/** The companies a round asks for, per segment. A manual search finds at least its share of "New prospects per search". */
async function newRound(db: Db, svc: Services, run: Run, prev: MorningSourcing | null): Promise<MorningSourcing> {
  const short = await drawShortfall(db, svc.settings);
  const quota = quotaOf(svc.settings);
  const total = quotaTotal(quota);
  const round = (prev?.round ?? 0) + 1;
  const share = (s: SourcingSegment) => (total ? (quota[s] ? Math.max(1, Math.round((svc.settings.prospectsPerRun * quota[s]) / total)) : 0) : Math.ceil(svc.settings.prospectsPerRun / 2));
  const segments = SOURCING_SEGMENTS.map((segment): MorningSegment => {
    const fill = Math.ceil(short[segment].short * MORNING_LIMITS.headroom);
    const wanted = run.trigger !== 'schedule' && round === 1 ? Math.max(fill, share(segment)) : fill;
    return { segment, wanted, added: 0, cursor: 0, quiet: 0, pending: [], checked: [], ruledOut: 0, noPage: 0, searches: 0 };
  });
  // Carries on from the last round: the searches already made aren't made again, companies already
  // checked aren't checked again, and those found but not needed then come first now.
  for (const s of segments) {
    const before = prev?.segments.find((p) => p.segment === s.segment);
    if (before) Object.assign(s, { cursor: before.cursor, pending: before.pending, checked: before.checked });
  }
  return { round, roundDone: false, segments, seen: prev?.seen ?? [], searches: prev?.searches ?? 0, added: prev?.added ?? 0, history: prev?.history ?? [] };
}

/** Whether the run should search again: research ruled out companies and the draw is still short. */
export async function wantsAnotherRound(db: Db, svc: Services, run: Run, now = new Date()): Promise<boolean> {
  const state = run.sourcing as MorningSourcing | null;
  if (!state?.roundDone || state.round >= MORNING_LIMITS.rounds) return false;
  // The last round found nothing new: searching again finds nothing either.
  const last = state.history.filter((h) => h.round === state.round);
  if (!last.some((h) => h.added > 0)) return false;
  if (last.some((h) => h.stopped === 'cap' || h.stopped === 'failed')) return false;
  // Companies handed straight to the team aren't in the draw's pool: one round is what was asked.
  if (run.prospectsTo) return false;
  if (run.trigger === 'schedule' && !beforeLastRound(now)) return false;
  const short = await drawShortfall(db, svc.settings);
  return SOURCING_SEGMENTS.some((s) => short[s].short > 0);
}

/** The people the search found at a people-first lead, as the LinkedIn search's own finds, for research to choose from. */
export async function peopleFirstContacts(db: Db, lead: Pick<Lead, 'id' | 'source'>) {
  if (!lead.source.startsWith(PEOPLE_FIRST_SOURCE)) return [];
  const rows = await db.select().from(people).where(and(eq(people.leadId, lead.id), eq(people.source, 'LinkedIn'), eq(people.evidence, PEOPLE_FIRST_EVIDENCE)));
  return rows.map((p) => ({ name: p.name, title: p.title, linkedin: p.linkedin, snippet: PEOPLE_FIRST_EVIDENCE, location: p.location, evidence: PEOPLE_FIRST_EVIDENCE }));
}

/**
 * Works on the run's prospect search until each segment has what it wants or stops, or `budgetMs`
 * runs out ('continue': where it got to is saved on the run). Every company that passes is added as a
 * lead at once, with its people, and handed to `onAdded` (to give it to the team when the admin chose that).
 */
export async function sourceProspects(
  db: Db,
  svc: Services,
  run: Run,
  opts: {
    started: number;
    budgetMs: number;
    log: (m: string, level?: 'info' | 'warn' | 'error') => Promise<unknown>;
    onAdded?: (ids: number[]) => Promise<void>;
    /** Whether the admin pressed Stop: the search ends where it is (the run then stops). */
    stopped?: () => Promise<boolean>;
  },
): Promise<'done' | 'continue'> {
  // Read again: an earlier round of this invocation saved it.
  const [row] = await db.select({ sourcing: runs.sourcing }).from(runs).where(eq(runs.id, run.id));
  const prev = (row?.sourcing ?? null) as MorningSourcing | null;
  const fresh = !prev || prev.roundDone;
  const state = fresh ? await newRound(db, svc, run, prev) : prev;
  const save = () => db.update(runs).set({ sourcing: JSON.parse(JSON.stringify(state)), heartbeatAt: new Date() }).where(eq(runs.id, run.id));
  if (fresh) {
    const wanted = state.segments.filter((s) => s.wanted > 0);
    await opts.log(
      wanted.length
        ? `${state.round > 1 ? `Searching again (round ${state.round}): ` : 'Finding new prospects, people first: '}${wanted.map((s) => `${s.wanted} ${s.segment}`).join(', ')}`
        : 'Finding new prospects: the morning draw has enough researched leads waiting, so none are needed',
    );
    await save();
  }
  if (!svc.keys.serper) {
    await opts.log('Prospect search skipped: SERPER_API_KEY is not set', 'error');
    state.roundDone = true;
    await save();
    return 'done';
  }

  const known = await knownToInveck(db);
  const pages = new Set((await db.select({ url: leads.companyLinkedin }).from(leads).where(ne(leads.companyLinkedin, ''))).map((r) => r.url));
  const elsewhere = await searchesTodayElsewhere(db, run.id);
  const seen = new Set(state.seen);
  const since = new Date(Date.now() - MORNING_LIMITS.memoryDays * 86_400_000);
  // Searches made on earlier runs: not made again for a while (this run's own are in its cursor).
  const recent = new Set(
    (
      await db
        .select({ q: prospectSearches.normQuery })
        .from(prospectSearches)
        .where(and(gte(prospectSearches.searchedAt, since), eq(prospectSearches.status, 'ok'), or(isNull(prospectSearches.runId), ne(prospectSearches.runId, run.id))))
    ).map((r) => r.q),
  );

  let steps = 0;
  for (const seg of state.segments) {
    if (seg.stopped || seg.added >= seg.wanted) {
      seg.stopped ??= 'target';
      continue;
    }
    const icp = await icpFor(db, seg.segment);
    // The same plan on every round and invocation of this run, so the cursor stays where it was.
    const plan = morningPlan(seg.segment, icp, run.id * 31).filter((q) => !recent.has(normQuery(q.q)));
    const counting: Services = {
      ...svc,
      fetch: ((input, init) => {
        if (isSerper(input)) {
          seg.searches++;
          state.searches++;
        }
        return svc.fetch(input, init);
      }) as typeof fetch,
    };
    const search = async (q: string, page = 1): Promise<{ results: SerperResult[]; error?: string }> => {
      try {
        return { results: await googleSearch(counting, q, page) };
      } catch (e) {
        return { results: [], error: errorMessage(e) };
      }
    };
    const rank = (p: FoundContact) => contactPriority(p.title, icp);
    const checked = new Set(seg.checked);

    // Checks one company's LinkedIn page; one that passes becomes a lead with its people.
    const check = async (c: MorningSegment['pending'][number]) => {
      checked.add(normCompany(c.employer));
      const got = await search(companyQuery(c.employer));
      let page: CompanyPage | null = got.error ? null : matchingPage(got.results, c.employer);
      if (!page) {
        seg.noPage++;
        return;
      }
      if (needsFacts(page)) page = withFacts(page, (await search(factsQuery(page))).results);
      // Its people work in India, so it has a site here whatever its headquarters.
      const s = screenPage({ ...page, text: `${page.text}\n${c.contacts.map((p) => p.location).join('; ')}` }, seg.segment, icp.companySize, known);
      if (!s.pass || pages.has(page.url)) {
        seg.ruledOut++;
        return;
      }
      if (seg.added >= seg.wanted) return;
      const name = page.nameCut ? c.employer : page.name;
      // Taken before the insert, so two checks at once can't add the same company.
      pages.add(page.url);
      known.names.add(normCompany(name));
      known.names.add(normCompany(c.employer));
      const domain = rootDomain(page.website);
      if (domain) known.domains.add(domain);
      seg.added++;
      state.added++;
      const best = c.contacts[0];
      const city = page.hq && !hqAbroad(page.hq) ? page.hq.split(',')[0].trim() : placeNamedIn(page.text) || (best.location.split(',')[0] ?? '').trim();
      const [row] = await db
        .insert(leads)
        .values({
          company: name,
          nameAsFound: c.employer,
          website: page.website,
          city,
          segment: seg.segment,
          status: 'New',
          companyLinkedin: page.url,
          source: `${PEOPLE_FIRST_SOURCE}: ${best.name}, ${best.title} (${best.tier}), on LinkedIn; company page ${page.url} (${page.size || 'size not shown'}${page.industry ? `, ${page.industry}` : ''})`,
        })
        .returning({ id: leads.id });
      if (page.website) registerFirmWebsite(name, page.website);
      await db.insert(people).values(
        c.contacts.slice(0, MORNING_LIMITS.contactsPerCompany).map((p) => ({ leadId: row.id, name: p.name, title: p.title, linkedin: p.linkedin, location: p.location, source: 'LinkedIn', evidence: PEOPLE_FIRST_EVIDENCE })),
      );
      await logActivity(db, row.id, 'added', `Found by the people-first search: ${c.contacts.map((p) => `${p.name} (${p.title}, ${p.tier})`).slice(0, 4).join('; ')} work here. Company page: ${page.url}; ${s.note}.`);
      await opts.onAdded?.([row.id]);
    };

    for (;;) {
      if (seg.added >= seg.wanted) {
        seg.stopped = 'target';
        break;
      }
      if (elsewhere + state.searches >= MORNING_LIMITS.dailySearches) {
        seg.stopped = 'cap';
        break;
      }
      // Out of this invocation's time (after doing something, so every invocation gets further).
      if (steps > 0 && Date.now() - opts.started > opts.budgetMs * 0.6) {
        state.seen = [...seen];
        seg.checked = [...checked];
        await save();
        return 'continue';
      }
      if (await opts.stopped?.()) {
        state.seen = [...seen];
        seg.checked = [...checked];
        state.roundDone = true;
        await save();
        return 'done';
      }
      steps++;
      // Companies already found come first: their checks may be all that's needed.
      seg.pending = seg.pending.filter((c) => !checked.has(normCompany(c.employer)));
      if (seg.pending.length) {
        seg.pending.sort((a, b) => rank(a.contacts[0]) - rank(b.contacts[0]) || b.contacts.length - a.contacts.length);
        const batch = seg.pending.splice(0, Math.max(1, Math.min(4, seg.wanted - seg.added)));
        await mapLimit(batch, 4, check);
        continue;
      }
      if (seg.quiet >= MORNING_LIMITS.quietSearches) {
        seg.stopped = 'dry';
        break;
      }
      const batch = plan.slice(seg.cursor, seg.cursor + 8);
      if (!batch.length) {
        seg.stopped = 'exhausted';
        break;
      }
      seg.cursor += batch.length;
      const got = await mapLimit(batch, 4, (pq) => search(pq.q));
      // Every search refused (out of credits, a wrong key): the run ends as failed, with the reason.
      if (got.every((g) => g.error)) {
        seg.stopped = 'failed';
        state.history.push({ round: state.round, segment: seg.segment, wanted: seg.wanted, added: seg.added, searches: seg.searches, stopped: 'failed' });
        state.seen = [...seen];
        state.roundDone = true;
        await save();
        throw new Error(`Google search failed: ${got[0]?.error ?? 'no answer'}`);
      }
      for (const [i, pq] of batch.entries()) {
        let onLists = 0;
        let newCompanies = 0;
        for (const r of got[i].results) {
          let person: FoundContact | null;
          try {
            person = readPerson(r, icp);
          } catch {
            person = null;
          }
          if (!person || seen.has(profileKey(person.linkedin))) continue;
          seen.add(profileKey(person.linkedin));
          const key = normCompany(person.employer);
          if (person.why || !key) continue;
          onLists++;
          if (known.names.has(key) || checked.has(key)) continue;
          const c = seg.pending.find((x) => normCompany(x.employer) === key);
          if (c) c.contacts.push(person);
          else {
            seg.pending.push({ employer: person.employer, contacts: [person] });
            newCompanies++;
          }
        }
        seg.quiet = onLists ? 0 : seg.quiet + 1;
        await db.insert(prospectSearches).values({
          query: pq.q,
          normQuery: normQuery(pq.q),
          segment: seg.segment,
          runId: run.id,
          status: got[i].error ? 'failed' : 'ok',
          resultsCount: got[i].results.length,
          freshCount: newCompanies,
          error: got[i].error ?? '',
        });
      }
      for (const c of seg.pending) c.contacts.sort((a, b) => rank(a) - rank(b));
    }
    seg.checked = [...checked];
    state.history.push({ round: state.round, segment: seg.segment, wanted: seg.wanted, added: seg.added, searches: seg.searches, stopped: seg.stopped });
    if (seg.wanted) {
      const why =
        seg.stopped === 'target'
          ? ''
          : seg.stopped === 'cap'
            ? ` (stopped at the day's limit of ${MORNING_LIMITS.dailySearches} searches)`
            : seg.stopped === 'dry'
              ? ` (the last ${seg.quiet} searches found nobody new on the lists)`
              : ` (every search planned has been made in the last ${MORNING_LIMITS.memoryDays} days)`;
      await opts.log(`${seg.segment}: ${seg.added} of ${seg.wanted} new companies with contacts, ${seg.searches} Google searches${why}`, seg.added < seg.wanted ? 'warn' : 'info');
    }
  }
  state.seen = [...seen];
  state.roundDone = true;
  await save();
  return 'done';
}

export type MorningHealth = {
  day: string;
  /** Why there's no search today: a weekend, a holiday, or turned off in Settings ('' on a working day). */
  off: '' | 'weekend' | 'holiday' | 'disabled';
  /** Today's 6 am run, if it has started. */
  run: { id: number; status: Run['status']; startedAt: Date; finishedAt: Date | null; added: number; researched: number; approved: number; disqualified: number; searches: number; rounds: number; error: string } | null;
  /** Per segment: what the draw needs, what's ready for it now, and what today's search found against what it wanted. */
  segments: { segment: SourcingSegment; need: number; ready: number; waiting: number; found: number; wanted: number; stopped?: MorningSegment['stopped'] }[];
  searchesToday: number;
  /** Signs the searches are running out of new companies, from the last few scheduled runs. */
  thin: string[];
};

/** The Dashboard's morning card: today's 6 am run, the draw's needs, and whether the market is running thin. */
export async function morningHealth(db: Db, settings: Services['settings'], holidays: Set<string>, now = new Date()): Promise<MorningHealth> {
  const day = istDay(now);
  const weekday = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCDay();
  const off: MorningHealth['off'] = weekday === 0 || weekday === 6 ? 'weekend' : holidays.has(day) ? 'holiday' : settings.morningSearch ? '' : 'disabled';
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
  const [{ used }] = await db
    .select({ used: sql<number>`coalesce(sum((${runs.sourcing}->>'searches')::int), 0)::int` })
    .from(runs)
    .where(gte(runs.startedAt, start));
  const searchesToday = Number(used);

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
    thin,
  };
}
