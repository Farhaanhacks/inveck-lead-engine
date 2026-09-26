import Link from 'next/link';
import type { Opportunity } from '@/lib/db/schema';
import { RADAR_LABELS } from '@/lib/pipeline/radar';
import { addOpportunityAction, dismissOpportunityAction } from '@/app/actions';
import { SubmitButton } from './submit-button';
import { RadarScanButton } from './radar-scan-button';

/** New plants and warehouses from the news, to approach before anyone else does. */
export function RadarCard({ fresh, added, total }: { fresh: Opportunity[]; added: Opportunity[]; total: number }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="text-sm font-semibold">New facility radar</h2>
          <p className="text-xs text-muted">New plants and warehouses in the news. Be the first to reach them.</p>
        </div>
        <RadarScanButton />
      </div>

      {fresh.length ? (
        <ul className="mt-3">
          {fresh.map((o) => (
            <li key={o.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-line px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{o.company}</span>
                  <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning-ink">{RADAR_LABELS[o.kind] ?? 'New facility'}</span>
                </div>
                <a href={o.url} target="_blank" rel="noreferrer" className="mt-0.5 block text-sm hover:underline">
                  {o.headline}
                </a>
                <p className="mt-0.5 text-xs text-muted">
                  {[o.location, o.segment, o.source, o.date].filter(Boolean).join(' · ')}
                </p>
                {o.why && <p className="mt-1 text-xs text-ink-2">{o.why}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <form action={addOpportunityAction}>
                  <input type="hidden" name="id" value={o.id} />
                  <SubmitButton className="btn-primary h-8 py-1 text-xs" pendingText="Adding…">Add as lead</SubmitButton>
                </form>
                <form action={dismissOpportunityAction}>
                  <input type="hidden" name="id" value={o.id} />
                  <SubmitButton className="btn-secondary h-8 py-1 text-xs" pendingText="…">Dismiss</SubmitButton>
                </form>
              </div>
            </li>
          ))}
          {total > fresh.length && (
            <li className="border-t border-line px-5 py-2 text-xs text-muted">{total - fresh.length} more waiting; add or dismiss these to see them.</li>
          )}
        </ul>
      ) : (
        <p className="px-5 pt-3 pb-5 text-sm text-muted">
          No new openings waiting. The radar scans the news with every research run (at most twice a day), or click Scan now.
        </p>
      )}

      {added.length > 0 && (
        <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
          Recently added:{' '}
          {added.map((o, i) => (
            <span key={o.id}>
              {i > 0 && ', '}
              {o.leadId ? (
                <Link href={`/leads/${o.leadId}`} className="text-accent hover:underline">{o.company}</Link>
              ) : (
                o.company
              )}
            </span>
          ))}
          . They&apos;re researched on the next run, and their first email opens with the news.
        </p>
      )}
    </section>
  );
}
