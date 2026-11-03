import type { Lead } from '@/lib/db/schema';

/**
 * The remarks saved for a company on the Tracker (its Remark and Call Remark cells), shown as they are, under its contact on Today.
 * Nothing is copied or saved here: the lead's own fields are the single source, so a change on the Tracker shows on Today. A company
 * with no remark shows nothing at all.
 */
export function SavedRemarks({ lead }: { lead: Pick<Lead, 'company' | 'remark' | 'callRemark'> }) {
  const notes = [
    { label: 'Remark', text: lead.remark.trim() },
    { label: 'Call remark', text: lead.callRemark.trim() },
  ].filter((n) => n.text);
  if (!notes.length) return null;
  return (
    <section aria-label={`Remarks for ${lead.company}`} className="mt-2 max-w-2xl rounded-md border border-line bg-surface-2 px-3 py-2">
      <dl className="space-y-1.5 text-sm">
        {notes.map((n) => (
          <div key={n.label}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{n.label}</dt>
            <dd className="whitespace-pre-line break-words text-ink-2">{n.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
