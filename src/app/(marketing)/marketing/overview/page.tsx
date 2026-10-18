import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { marketingPage } from '@/lib/access';
import { contentCounts } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';

function Tile({ label, value, note, tone = 'bg-surface text-ink' }: { label: string; value: number; note?: string; tone?: string }) {
  return (
    <div className={`glass-tint rounded-2xl p-4 ${tone}`}>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </div>
  );
}

/** Content activity only: what has gone out and what is in the pipeline. */
export default async function MarketingOverview() {
  await marketingPage();
  const c = await contentCounts(await getDb());
  return (
    <>
      <PageHeader title="Overview" description="What has been posted, and what is coming.">
        <Link href="/marketing/calendar" className="btn-primary">Back to the Content Calendar</Link>
      </PageHeader>
      <h2 className="mb-2 text-sm font-semibold">Posted</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile label="Total posted" value={c.posted} tone="bg-good-soft/70 text-good-ink" />
        <Tile label="Posted on Instagram" value={c.instagramPosted} tone="bg-rose-soft/70 text-rose-ink" />
        <Tile label="Posted on LinkedIn" value={c.linkedinPosted} tone="bg-accent-soft/70 text-accent" />
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">In progress</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Scheduled" value={c.scheduled} tone="bg-violet-soft/70 text-violet" />
        <Tile label="Draft" value={c.draft} tone="bg-neutral-soft/70 text-ink-2" />
        <Tile label="Pending approval" value={c.pendingApproval} tone="bg-warning-soft/70 text-warning-ink" />
        <Tile label="Waiting for dependency" value={c.waiting} tone="bg-critical-soft/70 text-critical-ink" />
      </div>
    </>
  );
}
