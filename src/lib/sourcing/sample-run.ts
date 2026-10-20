import { and, asc, eq, getTableColumns, inArray, is, SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { clients, icps, leads, people, sourcingTests, users, type Lead, type SourcingTest } from '../db/schema';
import { dealToDeficits, DRAW_SEGMENTS, drawPool, poolLeads, quotaOf, shuffle, teamQuotas, type DrawSegment, type Quota } from '../draw';
import { getHolidays } from '../holidays';
import { KnownBranches } from '../branches';
import { listKnownCompanies } from '../known-companies';
import { normSegment } from '../icp-match';
import { processLead } from '../pipeline/process-lead';
import { mapLimit, type Services } from '../pipeline/services';
import { errorMessage, rootDomain } from '../pipeline/text';
import { tierOf } from '../tiers';
import { istDay, loadTodayTasks, nextWorkingDay, worksCaFirms } from '../tasks';
import { CA_PER_ASSOCIATE } from '../ca-sheet';
import { MANUFACTURING } from '../db/seed';
import { PEOPLE_FIRST_SOURCE, MORNING_LIMITS, asLinkedInFinds, recentSearches, searchRound, startRound, type MorningSourcing } from './morning';
import type { CompanyPage, SourcingSegment } from './linkedin-pages';
import type { FoundContact } from './people-first';

/**
 * The Morning Sample Run: tomorrow's 6 am run and 8 am draw, done now on paper. It searches people
 * first and researches what it finds exactly as the run does, then deals the leads to each associate
 * as the draw does (what is waiting in the pool now, plus what the search found), and keeps each
 * person's day in its report so the admin can see what they would get. Nothing is saved as a lead,
 * nobody is given anything, no search is remembered: tomorrow's run starts fresh. CA firms (Anchal and
 * Puja's ten each from the Google Sheet) are not part of it.
 */

/** Leads researched at a time, as in the run. */
const CONCURRENCY = 3;

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
  /** After research: approved with a confirmed contact (can be dealt), ruled out by the ICP check, nobody to contact, or failed. */
  outcome?: 'approved' | 'ruled_out' | 'no_contact' | 'error';
  why?: string;
  /** The lead as research left it, and the people it kept. */
  lead?: Lead;
  people?: SamplePerson[];
};

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
  try {
    if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set: the sample searches Google through Serper.');
    if (!report) report = await begin(db, svc, (test.report as MorningSampleStart | null)?.fresh ?? false);
    const r = report;

    for (let step = 0; ; step++) {
      if (r.phase === 'search') {
        if (step > 0 && outOfTime(0.6)) break;
        const outcome = await searchRound(db, svc, r.search!, {
          started,
          budgetMs,
          log: async () => {},
          seed: test.id * 31,
          usedToday: 0,
          recent: await recentSearches(db, null),
          alsoKnown: {
            names: r.companies.flatMap((c) => [c.page.name, c.employer]),
            domains: r.companies.map((c) => rootDomain(c.page.website)).filter(Boolean),
            pages: r.companies.map((c) => c.page.url),
          },
          sink: {
            save: async () => {
              r.searches = r.search!.searches;
              await save({ progress: progressOf(r) });
            },
            async add(c) {
              r.companies.push({ key: -(r.companies.length + 1), round: r.search!.round, segment: c.segment, employer: c.employer, page: c.page, note: c.note, city: c.city, contacts: c.contacts });
              await save({ progress: progressOf(r) });
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
        if (waiting.length) {
          if (step > 0 && outOfTime(0.5)) break;
          await research(db, svc, waiting.slice(0, CONCURRENCY));
          r.researched = r.companies.filter((c) => c.outcome).length;
          await save({ progress: progressOf(r) });
          continue;
        }
        // Research ruled some out and the draw is still short: the run would search again.
        const short = stillShort(r);
        const last = r.search!.history.filter((h) => h.round === r.search!.round);
        const again =
          r.search!.round < MORNING_LIMITS.rounds &&
          DRAW_SEGMENTS.some((s) => short[s] > 0) &&
          last.some((h) => h.added > 0) &&
          !last.some((h) => h.stopped === 'cap' || h.stopped === 'failed');
        if (again) {
          const wanted = Object.fromEntries(DRAW_SEGMENTS.map((s) => [s, Math.ceil(short[s] * MORNING_LIMITS.headroom)])) as Record<SourcingSegment, number>;
          r.search = startRound(r.search, wanted);
          r.phase = 'search';
        } else r.phase = 'deal';
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

/** The morning it shows, the team and quotas, and what the search is asked for: the draw's shortfall, plus a quarter. */
async function begin(db: Db, svc: Services, fresh: boolean): Promise<MorningSampleReport> {
  const day = nextWorkingDay(istDay(), await getHolidays(db));
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
    wanted[s] = Math.ceil(short * MORNING_LIMITS.headroom);
    start[s] = { need, pool: pool.bySegment[s], waiting: waitingRows.filter((w) => normSegment(w.segment) === normSegment(s)).length, wanted: wanted[s] };
  }
  return { mode: 'morning', day, phase: 'search', fresh, team, quota, quotas, start, search: startRound(null, wanted), companies: [], pool: [], hands: [], searches: 0, researched: 0, seconds: 0 };
}

/** Researches a few of the sample's companies exactly as the run would (the ICP check, contacts, drafts), keeping the result in the report. */
async function research(db: Db, svc: Services, batch: SampleCompany[]) {
  const [allIcps, clientList, taken, known] = await Promise.all([
    db.select().from(icps).orderBy(asc(icps.id)),
    db.select().from(clients),
    db.select({ leadId: leads.id, company: leads.company, website: leads.website, contactName: leads.contactName }).from(leads),
    listKnownCompanies(db),
  ]);
  const ownLeads = new KnownBranches(known, []);
  await mapLimit(batch, CONCURRENCY, async (c) => {
    const best = c.contacts[0];
    const lead = sampleLead(c.key, {
      company: c.page.nameCut ? c.employer : c.page.name,
      nameAsFound: c.employer,
      website: c.page.website,
      companyLinkedin: c.page.url,
      city: c.city,
      segment: c.segment,
      status: 'Processing',
      source: `${PEOPLE_FIRST_SOURCE}: ${best.name}, ${best.title} (${best.tier}), on LinkedIn; company page ${c.page.url} (${c.page.size || 'size not shown'}${c.page.industry ? `, ${c.page.industry}` : ''})`,
    });
    try {
      const result = await processLead(svc, lead, { icps: allIcps, clients: clientList, taken: taken.filter((t) => t.contactName), ownLeads }, async () => {}, {
        teamContact: false,
        found: asLinkedInFinds(c.contacts),
      });
      const { people: found, ...update } = result;
      const icp = allIcps.find((i) => normSegment(i.segment) === normSegment(c.segment));
      c.lead = { ...lead, ...update } as Lead;
      c.people = (found ?? []).map((p) => asPerson(p, icp));
      const s = update.status;
      c.outcome = s === 'Approved' ? 'approved' : s === 'Deleted' ? 'no_contact' : s === 'Error' ? 'error' : 'ruled_out';
      c.why = s === 'Approved' ? update.fitReason ?? '' : update.deletedReason || update.fitDecision || update.fitReason || update.lastError || s || '';
      if (c.outcome === 'approved' && !releasable(c)) c.why = `Approved, but the contact isn't confirmed on LinkedIn yet, so the draw would hold it back`;
    } catch (e) {
      c.outcome = 'error';
      c.why = errorMessage(e);
    }
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
    return `Round ${r.search!.round}: searching LinkedIn for people (${wanted}; ${r.searches} Google searches so far)…`;
  }
  if (r.phase === 'research') return `Researching what the search found: ${r.researched} of ${found} done (the ICP check, contacts and drafts, as the run does)…`;
  if (r.phase === 'deal') return 'Dealing the leads to the team as the 8 am draw would…';
  return summaryOf(r);
}

export function summaryOf(r: MorningSampleReport): string {
  const approved = r.companies.filter(releasable).length;
  const dealt = r.hands.reduce((a, h) => a + h.cards.length, 0);
  const wanted = r.team.reduce((a, t) => a + DRAW_SEGMENTS.reduce((b, s) => b + quotaFor(r, t.id)[s], 0), 0);
  return `${r.companies.length} companies found (${r.searches} Google searches), ${approved} approved with a confirmed contact; ${dealt} of ${wanted} leads dealt to ${r.team.length} associates.`;
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
