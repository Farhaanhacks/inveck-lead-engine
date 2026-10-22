import Link from 'next/link';
import type { MorningHealth } from '@/lib/sourcing/morning';

const time = (d: Date) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(d);

const OFF: Record<Exclude<MorningHealth['off'], '' | 'not_started'>, string> = {
  weekend: 'No search today: the 6 am run searches Monday to Friday.',
  holiday: 'No search today: a holiday in Settings (and no draw).',
  disabled: 'The 6 am prospect search is turned off in Settings.',
};

const longDay = (day: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T00:00:00Z`));

const STOPPED: Record<string, string> = {
  cap: "stopped at the day's search limit",
  dry: 'stopped: the searches stopped finding anyone new',
  exhausted: 'stopped: every search planned has been made recently',
  failed: 'stopped: Google search failed',
};

/** Today's 6 am run at a glance: what it found, what the 8 am draw needs, and whether the searches are running thin. */
export function MorningCard({ health: h }: { health: MorningHealth }) {
  const r = h.run;
  const status = !r
    ? h.off === 'not_started'
      ? `The morning search and draw start on ${longDay(h.startsOn)}: nothing is searched for or handed out before then.`
      : h.off
      ? OFF[h.off]
      : 'Not started yet: the run starts at 6:00 am India time and the draw is at 8:00 am.'
    : r.status === 'running'
      ? `Running since ${time(r.startedAt)}${r.rounds > 1 ? ` (search round ${r.rounds})` : ''}.`
      : r.status === 'done'
        ? `Finished at ${time(r.finishedAt ?? r.startedAt)}.`
        : r.status === 'failed'
          ? `Failed${r.error ? `: ${r.error}` : ''}.`
          : 'Stopped.';
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">This morning</h2>
        {r && (
          <Link href={`/?run=${r.id}#activity`} className="text-sm text-accent hover:underline">
            Open the run log
          </Link>
        )}
      </div>
      <p className={`mt-1 text-sm ${r?.status === 'failed' ? 'text-critical-ink' : 'text-ink-2'}`}>{status}</p>
      {r && (
        <p className="mt-1 text-xs text-muted">
          {r.added} new companies found, {r.researched} researched: {r.approved} approved, {r.disqualified} ruled out by the ICP check.
        </p>
      )}

      <p className="mt-1 text-xs text-muted">
        Google searches today: <span className={h.budget && h.searchesToday >= h.budget ? 'font-medium text-warning-ink' : 'tabular-nums'}>{h.searchesToday.toLocaleString('en-IN')}{h.budget ? ` of ${h.budget.toLocaleString('en-IN')}` : ''}</span> credits{h.budget ? ' (Settings)' : ', no daily limit'}.
        {h.budget && h.searchesToday >= h.budget ? ' The budget is used: what is left waits for tomorrow.' : ''}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {h.segments.map((s) => {
          const short = s.need - s.ready;
          return (
            <div key={s.segment} className="rounded-lg border border-line p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{s.segment}</span>
                <span className={`text-xs ${short > 0 ? 'text-warning-ink' : 'text-good-ink'}`}>{short > 0 ? `${short} short` : 'Enough for the draw'}</span>
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {s.ready}
                <span className="text-sm font-normal text-muted"> of {s.need} ready for the draw</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {s.wanted ? `Today's search: ${s.found} of ${s.wanted} found${s.stopped && s.stopped !== 'target' ? `, ${STOPPED[s.stopped] ?? s.stopped}` : ''}.` : r ? 'Today’s search: none needed.' : ''}
                {s.waiting ? ` ${s.waiting} waiting for research.` : ''}
              </p>
            </div>
          );
        })}
      </div>

      {h.thin.length > 0 && (
        <div className="mt-4 rounded-lg bg-warning-soft p-3 text-sm text-warning-ink">
          <p className="font-medium">The searches are running thin</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {h.thin.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
