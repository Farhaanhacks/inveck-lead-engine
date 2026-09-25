'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Run, RunEvent } from '@/lib/db/schema';
import { stopRunAction } from '../../actions';
import { SubmitButton } from '@/components/submit-button';

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-ink-2',
  warn: 'text-warning-ink',
  error: 'text-critical-ink',
};

/** Shows a run's progress, polling while it's running. */
export function RunLog({ initialRun, initialEvents }: { initialRun: Run; initialEvents: RunEvent[] }) {
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState(initialEvents);
  const router = useRouter();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/runs/${run.id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { run: Run; events: RunEvent[] };
      setRun(data.run);
      setEvents(data.events);
      if (data.run.status !== 'running') router.refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [run.id, run.status, router]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length]);

  const s = run.stats;
  const stats = [
    ['New prospects', s.prospectsAdded],
    ['Researched', s.processed],
    ['Drafts', s.drafted],
    ['Disqualified', s.disqualified],
    ['Existing clients', s.existingClients],
    ['Errors', s.errors],
  ] as const;

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="text-sm font-semibold">
            Run #{run.id}{' '}
            <span className={`ml-1 text-xs font-normal ${run.status === 'failed' ? 'text-critical-ink' : 'text-muted'}`}>
              {run.status === 'running' && <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" aria-hidden />}
              {run.status}
            </span>
          </h2>
          {run.error && <p className="mt-1 text-sm text-critical-ink">{run.error}</p>}
        </div>
        {run.status === 'running' && !run.cancelRequested && (
          <form action={stopRunAction}>
            <input type="hidden" name="id" value={run.id} />
            <SubmitButton className="btn-secondary" pendingText="Stopping…">Stop after current leads</SubmitButton>
          </form>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 px-5 py-4 sm:grid-cols-6">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="max-h-[28rem] overflow-y-auto border-t border-line px-5 py-3 font-mono text-xs leading-relaxed">
        {events.map((e) => (
          <div key={e.id} className={`flex gap-3 ${LEVEL_STYLE[e.level] ?? ''}`}>
            <span className="shrink-0 text-muted tabular-nums">{new Date(e.at).toLocaleTimeString('en-IN', { hour12: false })}</span>
            <span className="min-w-0 break-words">
              {e.level !== 'info' && <span className="font-semibold uppercase">{e.level} </span>}
              {e.message}
            </span>
          </div>
        ))}
        {!events.length && <p className="text-muted">Starting…</p>}
        <div ref={bottom} />
      </div>
    </section>
  );
}
