import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { candidateCompanies, settings, sourcingTests } from '../db/schema';
import { normCompany } from '../pipeline/text';
import type { FoundContact } from './people-first';
import type { SourcingSegment } from './linkedin-pages';

/**
 * Companies a search found people at but didn't get to check, because it already had what it wanted.
 * Finding them cost people searches; they're kept so the next Sourcing test or Morning Sample Run checks
 * them first instead of searching for new people. A company is taken out when a test takes it to check
 * (what's left unchecked goes back at its end). People move on, so one older than this isn't used.
 */
export const BACKLOG_DAYS = 30;

export type Candidate = { employer: string; contacts: FoundContact[] };

/** Keeps companies left unchecked (the latest people found replace older ones). */
export async function saveBacklog(db: Db, segment: SourcingSegment, items: Candidate[]): Promise<number> {
  const rows = new Map<string, Candidate>();
  for (const c of items) {
    const norm = normCompany(c.employer);
    if (norm && c.contacts.length && !rows.has(norm)) rows.set(norm, c);
  }
  for (const [norm, c] of rows) {
    await db
      .insert(candidateCompanies)
      .values({ segment, employer: c.employer, norm, contacts: JSON.parse(JSON.stringify(c.contacts)) })
      .onConflictDoUpdate({ target: [candidateCompanies.segment, candidateCompanies.norm], set: { employer: c.employer, contacts: JSON.parse(JSON.stringify(c.contacts)), foundAt: new Date() } });
  }
  return rows.size;
}

/**
 * Takes up to `limit` companies for a segment out of the backlog, newest first, leaving out those the
 * caller already knows (a lead, a client, INVECK's own lists). Ones too old are dropped.
 */
export async function takeBacklog(db: Db, segment: SourcingSegment, known: Set<string>, limit = 300): Promise<Candidate[]> {
  await backfillBacklog(db);
  await db.delete(candidateCompanies).where(lt(candidateCompanies.foundAt, new Date(Date.now() - BACKLOG_DAYS * 86_400_000)));
  const rows = await db.select().from(candidateCompanies).where(eq(candidateCompanies.segment, segment)).orderBy(desc(candidateCompanies.foundAt)).limit(limit);
  if (!rows.length) return [];
  await db.delete(candidateCompanies).where(inArray(candidateCompanies.id, rows.map((r) => r.id)));
  return rows.filter((r) => !known.has(r.norm)).map((r) => ({ employer: r.employer, contacts: r.contacts as FoundContact[] }));
}

/** How many companies are waiting in the backlog, per segment. */
export async function backlogCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.select({ segment: candidateCompanies.segment, n: sql<number>`count(*)::int` }).from(candidateCompanies).groupBy(candidateCompanies.segment);
  return Object.fromEntries(rows.map((r) => [r.segment, Number(r.n)]));
}

type PendingSegment = { segment: SourcingSegment; pending?: Candidate[] };

/**
 * Once: the companies earlier tests and samples left unchecked (in their reports) go into the backlog, so
 * the ones found before it existed aren't lost either.
 */
async function backfillBacklog(db: Db) {
  const done = await db.select().from(settings).where(eq(settings.key, 'backlogBackfillV1'));
  if (done.length) return;
  const tests = await db.select({ segment: sourcingTests.segment, mode: sourcingTests.mode, report: sourcingTests.report }).from(sourcingTests).where(and(inArray(sourcingTests.mode, ['people', 'morning'])));
  for (const t of tests) {
    const r = t.report as { companies?: { employer: string; screen?: string; contacts?: FoundContact[] }[]; search?: { segments?: PendingSegment[] } } | null;
    if (!r) continue;
    if (t.mode === 'people' && Array.isArray(r.companies)) {
      const left = r.companies.filter((c) => c.screen === 'unchecked' && c.contacts?.length).map((c) => ({ employer: c.employer, contacts: c.contacts! }));
      if (left.length) await saveBacklog(db, t.segment as SourcingSegment, left);
    }
    if (t.mode === 'morning') for (const s of r.search?.segments ?? []) if (s.pending?.length) await saveBacklog(db, s.segment, s.pending);
  }
  await db.insert(settings).values({ key: 'backlogBackfillV1', value: { at: new Date().toISOString() } }).onConflictDoNothing();
}
