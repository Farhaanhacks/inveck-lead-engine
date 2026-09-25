import type { Activity } from '@/lib/db/schema';
import { formatDateTime, relativeDays } from '@/lib/dates';
import { addActivityAction } from '@/app/actions';
import { SubmitButton } from './submit-button';

// Marker per kind: a symbol plus the text, never colour alone.
const MARK: Record<string, { symbol: string; label: string; tone: string }> = {
  added: { symbol: '+', label: 'Added', tone: 'bg-neutral-soft text-ink-2' },
  researched: { symbol: '⌕', label: 'Research', tone: 'bg-accent-soft text-accent' },
  contact: { symbol: '👤', label: 'Contact found', tone: 'bg-accent-soft text-accent' },
  signal: { symbol: '🔔', label: 'Buying signal', tone: 'bg-warning-soft text-warning-ink' },
  draft: { symbol: '✎', label: 'Draft', tone: 'bg-accent-soft text-accent' },
  approved: { symbol: '✓', label: 'Approved', tone: 'bg-good-soft text-good-ink' },
  sent: { symbol: '✉', label: 'Sent', tone: 'bg-good-soft text-good-ink' },
  follow_up_drafted: { symbol: '✎', label: 'Follow-up drafted', tone: 'bg-accent-soft text-accent' },
  follow_up_sent: { symbol: '✉', label: 'Follow-up sent', tone: 'bg-good-soft text-good-ink' },
  stage: { symbol: '→', label: 'Stage', tone: 'bg-neutral-soft text-ink-2' },
  note: { symbol: '✱', label: 'Note', tone: 'bg-neutral-soft text-ink-2' },
  call: { symbol: '☎', label: 'Call', tone: 'bg-neutral-soft text-ink-2' },
  meeting: { symbol: '◷', label: 'Meeting', tone: 'bg-good-soft text-good-ink' },
  error: { symbol: '!', label: 'Problem', tone: 'bg-critical-soft text-critical-ink' },
};

export function Timeline({ leadId, items }: { leadId: number; items: Activity[] }) {
  return (
    <section className="card p-5">
      <h2 className="mb-4 text-sm font-semibold">Activity</h2>
      <form action={addActivityAction} className="mb-6 space-y-2">
        <input type="hidden" name="id" value={leadId} />
        <label htmlFor="activity-text" className="sr-only">Add to the timeline</label>
        <textarea id="activity-text" name="text" rows={2} required placeholder="Add a note, or log a call or meeting…" className="field" />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="activity-kind" className="sr-only">Type</label>
          <select id="activity-kind" name="kind" defaultValue="note" className="field w-auto py-1.5">
            <option value="note">Note</option>
            <option value="call">Call</option>
            <option value="meeting">Meeting</option>
          </select>
          <SubmitButton className="btn-secondary" pendingText="Adding…">Add to timeline</SubmitButton>
        </div>
      </form>

      {items.length ? (
        <ol className="relative space-y-4 border-l border-line pl-6">
          {items.map((a) => {
            const m = MARK[a.kind] ?? MARK.note;
            return (
              <li key={a.id} className="relative">
                <span
                  className={`absolute top-0 -left-[2.3rem] flex h-6 w-6 items-center justify-center rounded-full text-xs ring-4 ring-surface ${m.tone}`}
                  aria-hidden
                >
                  {m.symbol}
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="font-medium text-ink-2">{m.label}</span>
                  <time dateTime={a.at.toISOString()} title={formatDateTime(a.at)}>
                    {relativeDays(a.at)} · {formatDateTime(a.at)}
                  </time>
                </div>
                <p className="mt-0.5 text-sm whitespace-pre-line">{a.text}</p>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted">Nothing yet. Research, drafts, sends, follow-ups and notes appear here.</p>
      )}
    </section>
  );
}
