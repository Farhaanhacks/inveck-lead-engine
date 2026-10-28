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
 * - reads a search made in the last `nextPageDays` that found companies further down, its next page, not the same
 *   page again (it would show the same people, at companies now known; from 28 Oct 2026), up to page `lastPage`,
 *   and not past a page that wasn't full;
 * - leaves out the rest of an industry word and town pair when `deadAfter` of its searches showed nobody on
 *   the lists, and none ever showed anyone;
 * - takes first the pairs whose searches found companies that passed, most first.
 * Only what was known when the sample started counts, so its plan is the same on every invocation.
 */
export const SEARCH_MEMORY = { days: 30, deadAfter: 2, keepDays: 90, nextPageDays: 7, lastPage: 5 } as const;

/** One search's outcome: `page`, the page of results read (1 when absent), and `results`, how many it showed. */
export type SearchOutcome = { at: string; listed: number; fresh: number; kept: number; page?: number; results?: number; error?: boolean };
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

/** The plan with dead searches left out and the productive pairs first (see SEARCH_MEMORY); `skipped` is how many were left out. */
export function planFromMemory(plan: PeopleQuery[], memory: Map<string, SearchMemoryEntry>, at = new Date()): { plan: PeopleQuery[]; skipped: number } {
  // Per industry word and town: searches whose last outcome showed nobody on the lists, those that showed someone, companies kept.
  const pairs = new Map<string, { empty: number; listed: number; kept: number }>();
  for (const e of memory.values()) {
    const t = pairs.get(pairOf(e)) ?? { empty: 0, listed: 0, kept: 0 };
    if (e.outcomes[e.outcomes.length - 1].listed > 0) t.listed++;
    else t.empty++;
    t.kept += e.outcomes.reduce((a, o) => a + o.kept, 0);
    pairs.set(pairOf(e), t);
  }
  const dead = (pq: PeopleQuery) => {
    const own = memory.get(normQuery(pq.q));
    if (own && own.outcomes[own.outcomes.length - 1].fresh === 0) return true;
    const t = pairs.get(pairOf(pq));
    return !!t && t.empty >= SEARCH_MEMORY.deadAfter && t.listed === 0;
  };
  const kept = (pq: PeopleQuery) => pairs.get(pairOf(pq))?.kept ?? 0;
  // Made in the last few days (before `at`, when the sample started): its next page, or nothing when there is none (a
  // page that wasn't full was the last).
  const recently = at.getTime() - SEARCH_MEMORY.nextPageDays * 86_400_000;
  const live = plan.flatMap((pq): PeopleQuery[] => {
    if (dead(pq)) return [];
    const own = memory.get(normQuery(pq.q));
    const last = own?.outcomes[own.outcomes.length - 1];
    if (!last || Date.parse(last.at) < recently) return [pq];
    const next = (last.page ?? 1) + 1;
    if (next > SEARCH_MEMORY.lastPage || (last.results != null && last.results < 10)) return [];
    return [{ ...pq, page: next }];
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
  const outcome: SearchOutcome = { at: new Date().toISOString(), listed: r.listed, fresh: r.fresh, kept: 0, ...(pq.page && pq.page > 1 ? { page: pq.page } : {}), ...(r.results != null ? { results: r.results } : {}), ...(r.error ? { error: true } : {}) };
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
