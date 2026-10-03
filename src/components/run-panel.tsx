'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { RunSummary, RunView } from '@/lib/run-view';
import { stopRunAction } from '@/app/actions';
import { StatusPill } from './status-pill';
import { SubmitButton } from './submit-button';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Research activity on the dashboard: live progress while a run is going, then what it found
 * per company. The raw log stays one click away for troubleshooting.
 */
export function RunPanel({ runs, initial }: { runs: RunSummary[]; initial: RunView | null }) {
  const [view, setView] = useState(initial);
  const [selected, setSelected] = useState(initial?.run.id ?? runs[0]?.id);
  const router = useRouter();
  const running = view?.run.status === 'running';

  // Load another run, or keep polling the one that's running.
  useEffect(() => {
    if (!selected) return;
    let stop = false;
    const load = async () => {
      const res = await fetch(`/api/runs/${selected}`, { cache: 'no-store' });
      if (!res.ok || stop) return;
      const next = (await res.json()) as RunView;
      setView((prev) => {
        if (prev?.run.status === 'running' && next.run.status !== 'running') router.refresh();
        return next;
      });
    };
    if (view?.run.id !== selected) void load();
    if (!running && view?.run.id === selected) return;
    const timer = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [selected, running, view?.run.id, router]);

  if (!view) {
    return (
      <section id="activity" className="card scroll-mt-6 p-5">
        <h2 className="text-sm font-semibold">Research activity</h2>
        <p className="mt-2 text-sm text-muted">No research yet. Add companies and they’re researched straight away, or click “Find new prospects”. Research also runs every weekday at 6:00 am IST.</p>
      </section>
    );
  }

  const { run, leads, total } = view;
  const s = run.stats;
  const pct = total ? Math.round((s.processed / total) * 100) : 0;
  const warnings = view.events.filter((e) => e.level !== 'info').length;

  return (
    <section id="activity" className="card scroll-mt-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Research activity</h2>
          {running ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden /> Running
            </span>
          ) : (
            <span className="text-xs text-muted">
              {run.status === 'done' ? 'Finished' : run.status === 'cancelled' ? 'Stopped' : 'Failed'}
              {run.status === 'failed' && run.error && <span className="text-critical-ink">: {run.error}</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {running && !run.cancelRequested && (
            <form action={stopRunAction}>
              <input type="hidden" name="id" value={run.id} />
              <SubmitButton className="btn-secondary h-8 py-1 text-xs" pendingText="Stopping…">Stop after current companies</SubmitButton>
            </form>
          )}
          <label htmlFor="run-picker" className="sr-only">Show research from</label>
          <select
            id="run-picker"
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            className="field h-8 w-auto py-1 text-xs"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {when(r.startedAt)} · {r.processed} researched{r.findProspects ? ' + prospects' : ''}{r.trigger === 'schedule' ? ' (scheduled)' : r.trigger === 'auto' ? ' (new companies)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {running && (
        <div className="px-5 pt-4">
          <div className="flex justify-between text-xs text-ink-2">
            <span className="truncate pr-4">{view.current || 'Starting…'}</span>
            <span className="shrink-0 tabular-nums">
              {s.processed} of {total}
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Research progress">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
          </div>
        </div>
      )}
      {run.error && <p className="px-5 pt-3 text-sm text-critical-ink">{run.error}</p>}

      <dl className="grid grid-cols-3 gap-3 px-5 py-4 sm:grid-cols-4 xl:grid-cols-7">
        <Stat label="New prospects" value={s.prospectsAdded} />
        <Stat label="Researched" value={s.processed} />
        <Stat label="Drafts ready" value={s.drafted} />
        <Stat label="Needs review" value={s.needsReview ?? 0} />
        <Stat label="Disqualified" value={s.disqualified} />
        <Stat label="Clients skipped" value={s.existingClients} />
        <Stat label="Problems" value={s.errors} />
      </dl>

      {leads.length > 0 && (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="px-5 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Result</th>
                <th className="px-2 py-2 font-medium">Decision-maker</th>
                <th className="px-5 py-2 text-right font-medium">ICP fit</th>
              </tr>
            </thead>
            <tbody>
              {[...leads].reverse().map((l) => (
                <tr key={l.id} className="border-t border-line align-top hover:bg-surface-2">
                  <td className="px-5 py-2.5">
                    <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company}</Link>
                    {l.notes.length > 0 && (
                      <div className="mt-0.5 cursor-help text-xs text-muted" title={l.notes.join('\n')}>
                        {l.notes.length === 1 ? '1 note' : `${l.notes.length} notes`}: {l.notes[0].slice(0, 70)}{l.notes[0].length > 70 ? '…' : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2.5"><StatusPill status={l.status} /></td>
                  <td className="px-2 py-2.5 text-ink-2">{l.contact || <span className="text-muted">—</span>}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{l.fitScore != null ? `${l.fitScore}/10` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="border-t border-line">
        <summary className="cursor-pointer px-5 py-3 text-xs text-muted hover:text-ink">
          Show details ({view.events.length} steps{warnings ? `, ${warnings} notes` : ''})
        </summary>
        <ol className="max-h-80 overflow-y-auto px-5 pb-4 font-mono text-xs leading-relaxed">
          {view.events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="shrink-0 text-muted tabular-nums">
                {new Date(e.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}
              </span>
              <span className={`min-w-0 break-words ${e.level === 'error' ? 'text-critical-ink' : e.level === 'warn' ? 'text-muted' : 'text-ink-2'}`}>
                {e.level === 'error' && <span className="font-semibold">Error: </span>}
                {e.message}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
