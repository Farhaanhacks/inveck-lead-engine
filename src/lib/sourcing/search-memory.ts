import { like } from 'drizzle-orm';
import type { Db } from '../db';
import { enrichmentCache } from '../db/schema';
import { dbEnrichmentCache } from '../enrichment-cache';
import { normQuery } from '../pipeline/query-history';
import type { SourcingSegment } from './linkedin-pages';
import type { PeopleQuery } from './people-first';

/**
 * The Morning Sample Run's memory of its people searches (the 6 am run keeps its own in prospect_searches,
 * and never makes a search again within 30 days). Each search's outcome is kept: the people on the ICP's
 * lists it showed, the new companies it found, and how many of those passed the company check. From what
 * the searches found before a sample started, its plan:
 * - leaves out a search made in the last `days` that found no new company (it would show the same people);
 * - reads a search made in the last `nextPageDays` that found companies further down, not the same page again (it
 *   would show the same people, at companies now known; from 28 Oct 2026): a first read of ten results is followed by
 *   the first hundred in one search (2 credits for up to 90 more people), a hundred by the next hundred, up to
 *   `deepPages` hundreds, and nothing past a page that wasn't full;
 * - leaves out the rest of an industry word and town pair when `deadAfter` of its searches showed nobody on
 *   the lists, and none ever showed anyone;
 * - leaves out a town once searches there with `deadTownWords` different industry words showed nobody on the lists,
 *   and none there ever showed anyone; and an industry word once it showed nobody in `deadWordTowns` towns, and never
 *   anyone anywhere (28 Oct 2026: the new towns and words cost a few credits to rule out, not dozens);
 * - takes first the pairs whose searches found companies that passed, most first.
 * Only what was known when the sample started counts, so its plan is the same on every invocation.
 */
export const SEARCH_MEMORY = { days: 30, deadAfter: 2, deadTownWords: 3, deadWordTowns: 5, keepDays: 90, nextPageDays: 7, deepPages: 3 } as const;

/**
 * One search's outcome: `page`, the page of results read (1 when absent), `num`, the results asked for (10 when
 * absent), and `results`, how many it showed.
 */
export type SearchOutcome = { at: string; listed: number; fresh: number; kept: number; page?: number; num?: number; results?: number; error?: boolean };
export type SearchMemoryEntry = { title: string; keyword: string; place: string; outcomes: SearchOutcome[] };

const PREFIX = 'sample-search:v1:';
const keyOf = (segment: SourcingSegment, norm: string) => `${PREFIX}${segment}:${norm}`;
const pairOf = (q: { keyword: string; place: string }) => `${q.keyword.toLowerCase()}|${q.place.toLowerCase()}`;

/** What the sample's searches for a segment found before `before` (within SEARCH_MEMORY.days), by normalised search. */
export async function searchMemory(db: Db, segment: SourcingSegment, before: Date): Promise<Map<string, SearchMemoryEntry>> {
  const rows = await db.select({ key: enrichmentCache.key, value: enrichmentCache.value }).from(enrichmentCache).where(like(enrichmentCache.key, `${PREFIX}${segment}:%`));
  const until = before.getTime();
  const since = until - SEARCH_MEMORY.days * 86_400_000;
  const out = new Map<string, SearchMemoryEntry>();
  for (const r of rows) {
    const e = r.value as SearchMemoryEntry | null;
    const outcomes = (e?.outcomes ?? []).filter((o) => !o.error && Date.parse(o.at) < until && Date.parse(o.at) >= since);
    if (e && outcomes.length) out.set(r.key.slice(keyOf(segment, '').length), { ...e, outcomes });
  }
  return out;
}

/**
 * Where searches found nobody on the lists: an industry word and town pair `deadAfter` times, a town with
 * `deadTownWords` words, a word in `deadWordTowns` towns, none of them ever showing anyone (see SEARCH_MEMORY). Built
 * from the memory, and kept up to date during a run (`note`), so a run stops searching ground it has just found empty
 * (28 Oct 2026; before, only the next run did).
 */
export class DeadGround {
  private pairs = new Map<string, { empty: number; listed: number }>();
  private towns = new Map<string, { empty: Set<string>; listed: boolean }>();
  private words = new Map<string, { empty: Set<string>; listed: boolean }>();

  constructor(memory: Map<string, SearchMemoryEntry> = new Map()) {
    for (const e of memory.values()) this.add(e, e.outcomes[e.outcomes.length - 1].listed > 0, e.outcomes.some((o) => o.listed > 0));
  }

  /** A search made now: whether it showed anyone on the lists. */
  note(q: { keyword: string; place: string }, listed: boolean) {
    this.add(q, listed, listed);
  }

  dead(q: { keyword: string; place: string }): boolean {
    const t = this.towns.get(q.place.toLowerCase());
    if (t && !t.listed && t.empty.size >= SEARCH_MEMORY.deadTownWords) return true;
    const w = this.words.get(q.keyword.toLowerCase());
    if (w && !w.listed && w.empty.size >= SEARCH_MEMORY.deadWordTowns) return true;
    const p = this.pairs.get(pairOf(q));
    return !!p && p.empty >= SEARCH_MEMORY.deadAfter && p.listed === 0;
  }

  /** One search: its pair counted empty or not; its town and word marked as having shown someone, or not here. */
  private add(q: { keyword: string; place: string }, lastListed: boolean, everListed: boolean) {
    const p = this.pairs.get(pairOf(q)) ?? { empty: 0, listed: 0 };
    if (lastListed) p.listed++;
    else p.empty++;
    this.pairs.set(pairOf(q), p);
    const [town, word] = [q.place.toLowerCase(), q.keyword.toLowerCase()];
    const t = this.towns.get(town) ?? { empty: new Set<string>(), listed: false };
    const w = this.words.get(word) ?? { empty: new Set<string>(), listed: false };
    if (everListed) t.listed = w.listed = true;
    else {
      t.empty.add(word);
      w.empty.add(town);
    }
    this.towns.set(town, t);
    this.words.set(word, w);
  }
}

/** The plan with dead searches left out and the productive pairs first (see SEARCH_MEMORY); `skipped` is how many were left out. */
export function planFromMemory(plan: PeopleQuery[], memory: Map<string, SearchMemoryEntry>, at = new Date()): { plan: PeopleQuery[]; skipped: number } {
  // Per industry word and town: the companies its searches found that passed.
  const pairs = new Map<string, { kept: number }>();
  for (const e of memory.values()) {
    const t = pairs.get(pairOf(e)) ?? { kept: 0 };
    t.kept += e.outcomes.reduce((a, o) => a + o.kept, 0);
    pairs.set(pairOf(e), t);
  }
  const ground = new DeadGround(memory);
  const kept = (pq: PeopleQuery) => pairs.get(pairOf(pq))?.kept ?? 0;
  // Made in the last few days (before `at`, when the sample started): its next page, or nothing when there is none (a
  // page that wasn't full was the last).
  const recently = at.getTime() - SEARCH_MEMORY.nextPageDays * 86_400_000;
  // Each search's own memory looked up once (normalising tens of thousands of searches is most of this function's time).
  const live = plan.flatMap((pq): PeopleQuery[] => {
    const own = memory.get(pq.norm ?? normQuery(pq.q));
    const last = own?.outcomes[own.outcomes.length - 1];
    // One that found no new company isn't made again, nor one on ground found empty (see DeadGround).
    if (last?.fresh === 0 || ground.dead(pq)) return [];
    if (!last || Date.parse(last.at) < recently) return [pq];
    const num = last.num ?? 10;
    if (last.results != null && last.results < num) return [];
    // Ten read: the first hundred in one search (the next ten instead if Serper refuses a hundred). A hundred read: the next hundred.
    if (num <= 10) return [{ ...pq, num: 100, page: 1, fallbackPage: (last.page ?? 1) + 1 }];
    const next = (last.page ?? 1) + 1;
    return next > SEARCH_MEMORY.deepPages ? [] : [{ ...pq, num: 100, page: next }];
  });
  // A stable order otherwise: the plan's own (titles in turn, words and towns shuffled per run).
  const ordered = live.map((pq, i) => ({ pq, i })).sort((a, b) => kept(b.pq) - kept(a.pq) || a.i - b.i).map((x) => x.pq);
  return { plan: ordered, skipped: plan.length - live.length };
}

/** Keeps a search's outcome (outcomes older than SEARCH_MEMORY.keepDays are dropped). */
export async function rememberSearch(db: Db, segment: SourcingSegment, pq: PeopleQuery, r: { listed: number; fresh: number; results?: number; error?: string }): Promise<void> {
  const cache = dbEnrichmentCache(db);
  const key = keyOf(segment, normQuery(pq.q));
  const was = (await cache.get(key)) as SearchMemoryEntry | null;
  const cutoff = Date.now() - SEARCH_MEMORY.keepDays * 86_400_000;
  const outcome: SearchOutcome = {
    at: new Date().toISOString(),
    listed: r.listed,
    fresh: r.fresh,
    kept: 0,
    ...(pq.page && pq.page > 1 ? { page: pq.page } : {}),
    ...(pq.num && pq.num > 10 ? { num: pq.num } : {}),
    ...(r.results != null ? { results: r.results } : {}),
    ...(r.error ? { error: true } : {}),
  };
  await cache.set(key, { title: pq.title, keyword: pq.keyword, place: pq.place, outcomes: [...(was?.outcomes ?? []).filter((o) => Date.parse(o.at) >= cutoff), outcome] });
}

/** A company the search found (`via`, its normalised search) passed the company check: counted on that search's latest outcome. */
export async function rememberKept(db: Db, segment: SourcingSegment, via: string): Promise<void> {
  const cache = dbEnrichmentCache(db);
  const key = keyOf(segment, via);
  const was = (await cache.get(key)) as SearchMemoryEntry | null;
  const last = was?.outcomes?.[was.outcomes.length - 1];
  if (!was || !last) return;
  await cache.set(key, { ...was, outcomes: [...was.outcomes.slice(0, -1), { ...last, kept: last.kept + 1 }] });
}
