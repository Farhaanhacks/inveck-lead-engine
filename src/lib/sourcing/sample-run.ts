import { and, asc, eq, getTableColumns, inArray, is, isNull, SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { clients, icps, leads, people, sourcingTests, tasks, users, type Lead, type SourcingTest } from '../db/schema';
import { dealToDeficits, DRAW_HOUR_IST, DRAW_SEGMENTS, DRAWABLE, drawPool, morningStartsOn, poolLeads, quotaOf, shuffle, teamQuotas, type DrawSegment, type Quota } from '../draw';
import { getHolidays } from '../holidays';
import { KnownBranches } from '../branches';
import { listKnownCompanies } from '../known-companies';
import { normSegment } from '../icp-match';
import { processLead } from '../pipeline/process-lead';
import { knowFirmPage } from '../pipeline/firm-identity';
import { mapLimit, type Services } from '../pipeline/services';
import { errorMessage, normCompany, rootDomain } from '../pipeline/text';
import { logActivity } from '../activity';
import { saveBacklog, takeBacklog } from './backlog';
import { knownToInveck } from './test-run';
import { tierOf } from '../tiers';
import { firstWorkingDay, istDay, loadTodayTasks, nextWorkingDay, planSequence, worksCaFirms, type Holidays } from '../tasks';
import { CA_PER_ASSOCIATE } from '../ca-sheet';
import { MANUFACTURING } from '../db/seed';
import { PEOPLE_FIRST_EVIDENCE, PEOPLE_FIRST_SOURCE, MORNING_LIMITS, asLinkedInFinds, creditsOf, recentSearches, searchRound, startRound, type MorningSourcing } from './morning';
import { planFromMemory, rememberKept, rememberSearch, searchMemory } from './search-memory';
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
 * - no LinkedIn page doesn't rule a company out, and an industry LinkedIn doesn't show is read from the
 *   company's own website (no search credit), else left to research (see lenientScreen);
 * - cheaper company checks with the same companies kept: names that show a company is outside the ICP
 *   aren't looked up, likely misfits are checked last, and several companies are looked up in one search
 *   (see cheaperChecks); companies ruled out are remembered and not checked again;
 * - people searches of ten results, and a segment stops after 15 searches in a row find nobody new;
 * - its people searches are remembered: one that found no new company isn't made again within 30 days, an
 *   industry word and town that found nobody twice isn't searched with other titles, and the pairs that
 *   found companies that passed go first (see search-memory.ts);
 * - two contacts a company, with the hunt for a P1 when none is among them; the staff search stops once
 *   that is in hand; no Google search for the company's LinkedIn page (the search found it) or for officers
 *   in the news and filings; a person's profile looked up in the last 14 days, or the company's news
 *   checked in the last 7, isn't searched again;
 * - the people research found at a company count as checked on LinkedIn that day when it is pushed into
 *   the pipeline, so the 8 am contact check doesn't look them up again;
 * - 10% extra companies, 25 credits kept back for researching each company found, and 3,000 Google search
 *   credits at most for a new sample: a search that would go over it isn't made.
 * A sample carried on from where it stopped uses them too.
 */
export const SAMPLE_RULES = { peopleResults: 10, quietSearches: 15, headroom: 1.1, credits: 3000, researchCredits: 25 } as const;

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
};

/** Companies earlier searches found but didn't check, carried into this sample (checked first), per segment. */
export type Carried = Partial<Record<SourcingSegment, number>>;

/** One card on a person's day: a lead waiting in the pool now, or a company the sample found. */
export type SampleCard = { from: 'pool' | 'sample'; key: number };

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
export type MorningSampleStart = { mode: 'morning'; phase: 'init'; fresh: boolean };

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
  /** People searches left out of the plan, per segment, because earlier samples' same searches found nothing (see search-memory.ts). */
  skipped?: Partial<Record<SourcingSegment, number>>;
  /** Its dealt leads were put into the pipeline and given out as dealt (see assignSampleLeads): when, for which morning, to whom. */
  assigned?: { at: string; day: string; given: { userId: number; name: string; leads: number }[]; skipped: string[] };
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

/** Can be dealt: qualified, with a named contact confirmed on LinkedIn (the draw's own rule). */
const releasable = (c: SampleCompany) => c.outcome === 'approved' && !!c.lead?.qualified && !!c.lead.contactName && !!c.lead.contactVerifiedAt;

/** What's still short per segment: the draw's need, less the pool and what the sample has ready (and is still researching). */
function stillShort(r: MorningSampleReport): Record<DrawSegment, number> {
  const out = {} as Record<DrawSegment, number>;
  for (const s of DRAW_SEGMENTS) {
    const mine = r.companies.filter((c) => c.segment === s && (releasable(c) || !c.outcome)).length;
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
      }
      return svc.fetch(input, init);
    }) as typeof fetch,
  };
  try {
    if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set: the sample searches Google through Serper.');
    if (!report) report = await begin(db, svc, (test.report as MorningSampleStart | null)?.fresh ?? false);
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
          rememberRuledOut: true,
          lenientScreen: true,
          cheaperChecks: true,
          recent: await recentSearches(db, null),
          // What earlier samples' searches found (before this one started, so the plan stays the same).
          plan: async (segment, plan) => {
            const out = planFromMemory(plan, await searchMemory(db, segment, new Date(test.startedAt)));
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
              await rememberSearch(db, segment, pq, { listed: result.listed, fresh: result.newCompanies, error: result.error }).catch(() => {});
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
        const again =
          r.search!.round < MORNING_LIMITS.rounds &&
          DRAW_SEGMENTS.some((s) => short[s] > 0) &&
          last.some((h) => h.added > 0) &&
          !last.some((h) => h.stopped === 'failed') &&
          budgetLeft() > CHECKS_RESERVE + 50;
        if (again) {
          const wanted = Object.fromEntries(DRAW_SEGMENTS.map((s) => [s, Math.ceil(short[s] * SAMPLE_RULES.headroom)])) as Record<SourcingSegment, number>;
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
        await deal(db, r);
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
  } catch (e) {
    await save({ status: 'failed', finishedAt: new Date(), error: errorMessage(e), progress: report ? progressOf(report) : '' });
  }
  await saving;
  return 'done';
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
 * For a morning the 8 am draw doesn't run: puts every lead a finished sample dealt into the pipeline and gives it
 * to the associate the sample dealt it to, as the draw would have. The sample's own companies go in as research
 * left them (Approved, with their contact and drafts; see pushSampleCompanies); a pool lead it dealt is given out
 * if nobody has it yet. Each counts as handed out on the sample's morning (today, once that has passed), and its
 * Day 1 steps are due then. A lead someone already has, or one already in the pipeline as another lead, is left
 * as it is (`skipped`). Giving out again changes nothing.
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
  const given: NonNullable<MorningSampleReport['assigned']>['given'] = [];
  const skipped = [...pushed.skipped];
  for (const h of r.hands) {
    let n = 0;
    for (const card of h.cards) {
      const company = card.from === 'sample' ? r.companies.find((c) => c.key === card.key) : undefined;
      const name = company ? (company.page.nameCut ? company.employer : company.page.name) : (r.pool.find((p) => p.lead.id === card.key)?.lead.company ?? `Lead ${card.key}`);
      const leadId = card.from === 'sample' ? company?.pushed : card.key;
      if (!leadId || !active.has(h.userId)) {
        if (leadId) skipped.push(name);
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
      n++;
    }
    if (n) given.push({ userId: h.userId, name: h.name, leads: n });
  }
  const assigned = { at: now.toISOString(), day, given, skipped: [...new Set(skipped)] };
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
async function begin(db: Db, svc: Services, fresh: boolean): Promise<MorningSampleReport> {
  const holidays = await getHolidays(db);
  // Not before the day the morning search and draw start (the live database: 22 Oct 2026).
  const startsOn = await morningStartsOn(db);
  const next = sampleMorning(new Date(), holidays);
  const day = startsOn && next < startsOn ? firstWorkingDay(startsOn, holidays) : next;
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(asc(users.id));
  const quota = quotaOf(svc.settings);
  const own = await teamQuotas(db, svc.settings);
  const quotas = Object.fromEntries(team.map((t) => [String(t.id), own.get(t.id) ?? quota]));
  const pool = await drawPool(db);
  // Companies already waiting for research: the run researches them first; the sample can't show them.
  const waitingRows = await db.select({ segment: leads.segment }).from(leads).where(inArray(leads.status, ['New', 'Processing']));
  const start = {} as MorningSampleReport['start'];
  const wanted = {} as Record<SourcingSegment, number>;
  for (const s of DRAW_SEGMENTS) {
    const need = Object.values(quotas).reduce((a, q) => a + q[s], 0);
    const short = Math.max(0, need - (fresh ? 0 : pool.bySegment[s]));
    wanted[s] = Math.ceil(short * SAMPLE_RULES.headroom);
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
      const s = update.status;
      c.outcome = s === 'Approved' ? 'approved' : s === 'Deleted' ? 'no_contact' : s === 'Error' ? 'error' : 'ruled_out';
      c.why = s === 'Approved' ? update.fitReason ?? '' : update.deletedReason || update.fitDecision || update.fitReason || update.lastError || s || '';
      if (c.outcome === 'approved' && !releasable(c)) c.why = `Approved, but the contact isn't confirmed on LinkedIn yet, so the draw would hold it back`;
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
  for (const s of DRAW_SEGMENTS) {
    const need = team.reduce((a, t) => a + quotaFor(r, t)[s], 0);
    if (!need) continue;
    const pool = r.fresh ? [] : await poolLeads(db, s, need);
    const mine = r.companies.filter((c) => c.segment === s && releasable(c));
    const cards: SampleCard[] = shuffle([...pool.map((l) => ({ from: 'pool' as const, key: l.id })), ...mine.map((c) => ({ from: 'sample' as const, key: c.key }))]).slice(0, need);
    poolUsed.push(...pool.filter((l) => cards.some((c) => c.from === 'pool' && c.key === l.id)));
    const deficits = new Map(team.map((t) => [t, quotaFor(r, t)[s]] as const).filter(([, n]) => n > 0));
    for (const [owner, dealt] of dealToDeficits(cards, deficits)) {
      const h = hands.get(owner)!;
      h.cards.push(...dealt);
      h.short[s] = quotaFor(r, owner)[s] - dealt.length;
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
  if (r.phase === 'deal') return 'Dealing the leads to the team as the 8 am draw would…';
  return summaryOf(r);
}

export function summaryOf(r: MorningSampleReport): string {
  const approved = r.companies.filter(releasable).length;
  const dealt = r.hands.reduce((a, h) => a + h.cards.length, 0);
  const wanted = r.team.reduce((a, t) => a + DRAW_SEGMENTS.reduce((b, s) => b + quotaFor(r, t.id)[s], 0), 0);
  const waiting = r.companies.filter((c) => c.outcome === 'waiting').length;
  return `${r.companies.length} companies found, ${approved} approved with a confirmed contact${waiting ? `, ${waiting} left for the next day (over the search budget)` : ''}; ${dealt} of ${wanted} leads dealt to ${r.team.length} associates. ${credits(r)}.`;
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
