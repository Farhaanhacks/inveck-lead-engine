import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { marketingPage } from '@/lib/access';
import { contentCounts } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';
import { PlatformLogo } from '@/components/platform-logo';
import type { ContentPlatform } from '@/lib/content-meta';

function Tile({ label, value, note, platform }: { label: string; value: number; note?: string; platform?: ContentPlatform }) {
  return (
    <div className="glass rounded-2xl bg-surface/60 p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        {platform && <PlatformLogo platform={platform} size={14} />}
        {label}
      </div>
      <div className="mt-2 text-4xl font-semibold tracking-tight text-ink tabular-nums">{value}</div>
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
        <Tile label="Total posted" value={c.posted} />
        <Tile label="Posted on Instagram" value={c.instagramPosted} platform="instagram" />
        <Tile label="Posted on LinkedIn" value={c.linkedinPosted} platform="linkedin" />
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">In progress</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Scheduled" value={c.scheduled} />
        <Tile label="Draft" value={c.draft} />
        <Tile label="Pending approval" value={c.pendingApproval} />
        <Tile label="Waiting for dependency" value={c.waiting} />
      </div>
    </>
  );
}
