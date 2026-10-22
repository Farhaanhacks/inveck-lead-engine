import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { enrichmentCache } from '@/lib/db/schema';
import { MANUFACTURING, LOGISTICS } from '@/lib/db/seed';
import { normQuery } from '@/lib/pipeline/query-history';
import { planFromMemory, rememberKept, rememberSearch, SEARCH_MEMORY, searchMemory, type SearchMemoryEntry } from '@/lib/sourcing/search-memory';
import type { PeopleQuery } from '@/lib/sourcing/people-first';

/** The Morning Sample Run's memory of its people searches: dead ones left out, productive industries and towns first. */

const query = (title: string, keyword: string, place: string): PeopleQuery => ({
  q: ['site:linkedin.com/in', `"${title}"`, `"${keyword}"`, place].join(' '),
  form: 'industry',
  title,
  keyword,
  place,
});
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const entry = (pq: PeopleQuery, outcomes: Partial<SearchMemoryEntry['outcomes'][number]>[]): [string, SearchMemoryEntry] => [
  normQuery(pq.q),
  { title: pq.title, keyword: pq.keyword, place: pq.place, outcomes: outcomes.map((o) => ({ at: daysAgo(1), listed: 0, fresh: 0, kept: 0, ...o })) },
];

describe('the sample plan from what earlier searches found', () => {
  const plan = [
    query('Plant Head', 'forging', 'Pune'),
    query('Plant Head', 'casting', 'Hosur'),
    query('Works Manager', 'forging', 'Pune'),
    query('Works Manager', 'casting', 'Hosur'),
    query('Plant Head', 'machining', 'Rajkot'),
    query('Works Manager', 'machining', 'Rajkot'),
    query('Operations Head', 'machining', 'Rajkot'),
    query('Operations Head', 'gears', 'Chennai'),
  ];

  it('changes nothing with no memory', () => {
    expect(planFromMemory(plan, new Map())).toEqual({ plan, skipped: 0 });
  });

  it('leaves out a search whose last outcome found no new company, and keeps one that found some', () => {
    const memory = new Map([entry(plan[0], [{ listed: 4, fresh: 0 }]), entry(plan[1], [{ listed: 3, fresh: 2 }])]);
    const out = planFromMemory(plan, memory);
    expect(out.skipped).toBe(1);
    expect(out.plan).not.toContainEqual(plan[0]);
    expect(out.plan).toContainEqual(plan[1]);
    // Its last outcome counts: it found something the time before, nothing the last time.
    expect(planFromMemory(plan, new Map([entry(plan[1], [{ listed: 3, fresh: 2 }, { listed: 3, fresh: 0 }])])).plan).not.toContainEqual(plan[1]);
  });

  it(`leaves out an industry word and town once ${SEARCH_MEMORY.deadAfter} searches there found nobody on the lists, and none found anyone`, () => {
    // Two titles found nobody making machined parts in Rajkot: the third isn't searched.
    const dead = new Map([entry(plan[4], [{ listed: 0 }]), entry(plan[5], [{ listed: 0 }])]);
    const out = planFromMemory(plan, dead);
    expect(out.plan.map((q) => q.q)).toEqual(plan.filter((q) => q.keyword !== 'machining').map((q) => q.q));
    expect(out.skipped).toBe(3);
    // Once is not "repeatedly": the other titles are still searched.
    expect(planFromMemory(plan, new Map([entry(plan[4], [{ listed: 0 }])])).plan).toContainEqual(plan[6]);
    // Someone on the lists there even once: still searched.
    const mixed = new Map([entry(plan[4], [{ listed: 0 }]), entry(plan[5], [{ listed: 0 }]), entry(query('Plant Manager', 'machining', 'Rajkot'), [{ listed: 2, fresh: 1 }])]);
    expect(planFromMemory(plan, mixed).plan).toContainEqual(plan[6]);
  });

  it('takes first the industry words and towns whose searches found companies that passed, most first, else keeps the order', () => {
    const memory = new Map([
      entry(query('Plant Manager', 'gears', 'Chennai'), [{ listed: 3, fresh: 2, kept: 1 }]),
      entry(query('Plant Manager', 'casting', 'Hosur'), [{ listed: 5, fresh: 3, kept: 2 }]),
    ]);
    const out = planFromMemory(plan, memory);
    expect(out.skipped).toBe(0);
    expect(out.plan.map((q) => `${q.title}/${q.keyword}`)).toEqual([
      'Plant Head/casting',
      'Works Manager/casting',
      'Operations Head/gears',
      'Plant Head/forging',
      'Works Manager/forging',
      'Plant Head/machining',
      'Works Manager/machining',
      'Operations Head/machining',
    ]);
  });
});

describe('the memory itself', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  it('keeps each outcome per segment, counts the companies kept, and reads only what was known before a sample started', async () => {
    const pq = query('Plant Head', 'forging', 'Pune');
    await rememberSearch(db, MANUFACTURING, pq, { listed: 3, fresh: 2 });
    await rememberKept(db, MANUFACTURING, normQuery(pq.q));
    await rememberKept(db, MANUFACTURING, normQuery(pq.q));
    const later = new Date(Date.now() + 1000);
    const memory = await searchMemory(db, MANUFACTURING, later);
    expect(memory.get(normQuery(pq.q))?.outcomes).toMatchObject([{ listed: 3, fresh: 2, kept: 2 }]);
    // Another segment's memory is its own.
    expect((await searchMemory(db, LOGISTICS, later)).size).toBe(0);
    // A sample that started before the search was made doesn't see it (its plan stays the same on every invocation).
    expect((await searchMemory(db, MANUFACTURING, new Date(Date.now() - 60_000))).size).toBe(0);
    // A second search adds an outcome; the latest one decides.
    await rememberSearch(db, MANUFACTURING, pq, { listed: 3, fresh: 0 });
    const twice = (await searchMemory(db, MANUFACTURING, new Date(Date.now() + 1000))).get(normQuery(pq.q))!;
    expect(twice.outcomes.map((o) => o.fresh)).toEqual([2, 0]);
  });

  it(`forgets outcomes older than ${SEARCH_MEMORY.days} days for the plan, and failed searches altogether`, async () => {
    const old = query('Plant Head', 'forging', 'Pune');
    const failed = query('Works Manager', 'forging', 'Pune');
    await db.insert(enrichmentCache).values({
      key: `sample-search:v1:${MANUFACTURING}:${normQuery(old.q)}`,
      provider: 'sample-search',
      value: { title: old.title, keyword: old.keyword, place: old.place, outcomes: [{ at: daysAgo(SEARCH_MEMORY.days + 1), listed: 0, fresh: 0, kept: 0 }] },
    });
    await rememberSearch(db, MANUFACTURING, failed, { listed: 0, fresh: 0, error: 'no credits' });
    expect((await searchMemory(db, MANUFACTURING, new Date(Date.now() + 1000))).size).toBe(0);
  });
});
