import Link from 'next/link';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { runEvents, runs } from '@/lib/db/schema';
import { activeRun } from '@/lib/runs';
import { PageHeader } from '@/components/page-header';
import { RunButtons } from '@/components/run-buttons';
import { RunLog } from './run-log';

// Runs started from this page keep working after the response (see actions.ts).
export const maxDuration = 300;

const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default async function RunsPage({ searchParams }: PageProps<'/runs'>) {
  const sp = await searchParams;
  const db = await getDb();
  const [history, running] = await Promise.all([db.select().from(runs).orderBy(desc(runs.id)).limit(30), activeRun(db)]);
  const selectedId = Number(sp.id) || running?.id || history[0]?.id;
  const selected = history.find((r) => r.id === selectedId);
  const events = selected ? await db.select().from(runEvents).where(eq(runEvents.runId, selected.id)).orderBy(asc(runEvents.id)).limit(500) : [];

  return (
    <>
      <PageHeader
        title="Runs"
        description="A run finds new prospects (optional), skips existing clients, then researches every new company: qualifies it, finds the decision-maker and email, and drafts outreach."
      >
        <RunButtons running={!!running} runId={running?.id} />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {selected ? (
            <RunLog
              key={selected.id}
              initialRun={JSON.parse(JSON.stringify(selected))}
              initialEvents={JSON.parse(JSON.stringify(events))}
            />
          ) : (
            <div className="card p-8 text-center text-sm text-muted">
              No runs yet. Runs also start automatically every weekday at 9:00 IST once deployed.
            </div>
          )}
        </div>

        <section className="card overflow-hidden">
          <h2 className="px-5 pt-5 pb-3 text-sm font-semibold">History</h2>
          <ul>
            {history.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/runs?id=${r.id}`}
                  className={`block border-t border-line px-5 py-3 text-sm hover:bg-surface-2 ${r.id === selectedId ? 'bg-accent-soft' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Run #{r.id}</span>
                    <span className="text-xs text-muted">{r.status}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {fmt(r.startedAt)} · {r.trigger === 'schedule' ? 'scheduled' : 'manual'}
                    {r.findProspects ? ' · with prospect search' : ''}
                  </div>
                  <div className="text-xs text-ink-2">
                    {r.stats.processed} researched · {r.stats.drafted} drafts
                  </div>
                </Link>
              </li>
            ))}
            {!history.length && <li className="border-t border-line px-5 py-3 text-sm text-muted">Nothing yet.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
