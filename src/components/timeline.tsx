import type { Activity } from '@/lib/db/schema';
import { formatDateTime, relativeDays } from '@/lib/dates';
import { addActivityAction } from '@/app/actions';
import { SubmitButton } from './submit-button';

// Marker per kind: a coloured dot plus the label text, never colour alone.
const MARK: Record<string, { label: string; tone: string }> = {
  added: { label: 'Added', tone: 'text-muted' },
  researched: { label: 'Research', tone: 'text-accent' },
  contact: { label: 'Contact found', tone: 'text-accent' },
  signal: { label: 'In the news', tone: 'text-warning-ink' },
  draft: { label: 'Draft', tone: 'text-accent' },
  approved: { label: 'Approved', tone: 'text-good-ink' },
  sent: { label: 'Sent', tone: 'text-good-ink' },
  follow_up_drafted: { label: 'Follow-up drafted', tone: 'text-accent' },
  follow_up_sent: { label: 'Follow-up sent', tone: 'text-good-ink' },
  stage: { label: 'Stage', tone: 'text-muted' },
  note: { label: 'Note', tone: 'text-muted' },
  call: { label: 'Call', tone: 'text-muted' },
  meeting: { label: 'Meeting', tone: 'text-good-ink' },
  error: { label: 'Problem', tone: 'text-critical-ink' },
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
                <span className={`absolute top-1 -left-[1.95rem] h-2.5 w-2.5 rounded-full bg-current ring-4 ring-surface ${m.tone}`} aria-hidden />
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
