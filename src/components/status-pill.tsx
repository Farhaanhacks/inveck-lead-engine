import type { LeadStatus } from '@/lib/db/schema';

// Status colours are reserved for states and always shown with their text label.
const TONE: Record<LeadStatus, string> = {
  New: 'bg-neutral-soft text-ink-2',
  Processing: 'bg-accent-soft text-accent',
  'Existing Client': 'bg-neutral-soft text-ink-2',
  Disqualified: 'bg-neutral-soft text-ink-2',
  'Needs Manual Contact': 'bg-warning-soft text-warning-ink',
  'Low Score': 'bg-warning-soft text-warning-ink',
  'Awaiting Approval': 'bg-accent-soft text-accent',
  Approved: 'bg-good-soft text-good-ink',
  Contacted: 'bg-good-soft text-good-ink',
  Replied: 'bg-good-soft text-good-ink',
  'Meeting Booked': 'bg-good-soft text-good-ink',
  Won: 'bg-good-soft text-good-ink',
  Lost: 'bg-neutral-soft text-ink-2',
  Rejected: 'bg-neutral-soft text-ink-2',
  Error: 'bg-critical-soft text-critical-ink',
};

export function StatusPill({ status }: { status: string }) {
  const tone = TONE[status as LeadStatus] ?? TONE.New;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}>{status}</span>;
}
