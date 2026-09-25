import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { leads, runEvents, runs, type Run, type RunEvent } from './db/schema';
import { getSettings } from './settings';

export type RunLead = {
  id: number;
  company: string;
  status: string;
  contact: string;
  score: number | null;
  signal: string;
  notes: string[];
};

export type RunView = {
  run: Run;
  events: RunEvent[];
  leads: RunLead[];
  /** Companies this run will research in total (for the progress bar). */
  total: number;
  /** The latest thing the run did, for the one-line status. */
  current: string;
};

export type RunSummary = { id: number; startedAt: string; status: Run['status']; trigger: string; findProspects: boolean; processed: number; drafted: number };

export async function listRuns(db: Db, limit = 20): Promise<RunSummary[]> {
  const rows = await db.select().from(runs).orderBy(desc(runs.id)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    status: r.status,
    trigger: r.trigger,
    findProspects: r.findProspects,
    processed: r.stats.processed,
    drafted: r.stats.drafted,
  }));
}

/** Everything the dashboard shows about one run: results per company, progress and the technical log. */
export async function getRunView(db: Db, id: number): Promise<RunView | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return null;
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, id)).orderBy(asc(runEvents.id)).limit(1000);

  const leadIds = [...new Set(events.map((e) => e.leadId).filter((x): x is number => x != null))];
  const rows = leadIds.length ? await db.select().from(leads).where(inArray(leads.id, leadIds)) : [];
  const byId = new Map(rows.map((l) => [l.id, l]));
  const notes = new Map<number, string[]>();
  for (const e of events) {
    if (e.leadId == null || e.level === 'info') continue;
    // "Honeywell: website not readable (…)" → "website not readable (…)"
    const text = e.message.replace(/^[^:]+:\s*/, '');
    notes.set(e.leadId, [...(notes.get(e.leadId) ?? []), text]);
  }
  const list: RunLead[] = leadIds
    .map((lid) => byId.get(lid))
    .filter((l): l is NonNullable<typeof l> => !!l)
    .map((l) => ({
      id: l.id,
      company: l.company,
      status: l.status,
      contact: [l.contactName, l.contactTitle].filter(Boolean).join(' · '),
      score: l.finalScore,
      signal: l.signals[0]?.headline ?? '',
      notes: notes.get(l.id) ?? [],
    }));

  let total = run.stats.processed;
  if (run.status === 'running') {
    const settings = await getSettings(db);
    const [{ waiting }] = await db
      .select({ waiting: sql<number>`count(*)::int` })
      .from(leads)
      .where(inArray(leads.status, ['New', 'Processing']));
    total = Math.min(settings.dailyLimit, run.stats.processed + waiting);
  }
  const last = events.at(-1)?.message ?? '';
  return { run, events, leads: list, total: Math.max(total, run.stats.processed), current: last };
}
