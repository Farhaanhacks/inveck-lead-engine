import Link from 'next/link';
import { Badge, EmptyState, Notice, PageHeader, Stat } from '@/components/blogs/ui';
import { integrationPresence } from '@/lib/blogs/env';
import { overviewStats } from '@/lib/blogs/stats';
import { formatInZone } from '@/lib/blogs/time';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const s = await overviewStats();
  const present = integrationPresence();
  const setup: string[] = [];
  if (!present.gemini) setup.push('Gemini API key (writing and images)');
  if (!present.exa) setup.push('Exa API key (research)');
  if (present.cms !== 'configured') setup.push('CMS connection (publishing is in mock mode until this is verified)');
  if (!present.searchConsole) setup.push('Google Search Console (impressions and clicks)');

  return (
    <>
      <PageHeader title="Overview" description={`Live figures. Days and weeks follow ${s.timezone}.`} />
      <div className="space-y-6">
        {setup.length ? (
          <Notice tone="warn" title="Setup still needed">
            <ul className="list-disc pl-5">{setup.map((x) => <li key={x}>{x}</li>)}</ul>
            <Link href="/blogs/settings" className="mt-2 inline-block underline underline-offset-2">Open Settings &amp; Integrations</Link>
          </Notice>
        ) : null}
        {s.workerStale ? (
          <Notice tone="warn" title="Background worker is not running">
            {s.pendingWork} item{s.pendingWork === 1 ? ' is' : 's are'} waiting for a retry or pickup, but no scheduler has called the app recently. Check your scheduler (cron-job.org) or press Run now in Article Studio.
          </Notice>
        ) : null}
        {s.mockPublished > 0 ? (
          <Notice tone="warn" title={`${s.mockPublished} mock publication${s.mockPublished === 1 ? '' : 's'} not counted`}>
            Mock posts are excluded from the published totals.
          </Notice>
        ) : null}

        <section aria-label="Publishing" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label="Published today" value={s.publishedToday} />
          <Stat label="Published this week" value={s.publishedWeek} />
          <Stat label="Scheduled" value={s.scheduled} />
          <Stat label="Awaiting approval" value={s.awaiting} />
          <Stat label="Generating" value={s.generating} />
          <Stat label="Failed or blocked" value={s.failed} />
        </section>

        <section aria-label="Search performance" className="grid gap-3 md:grid-cols-2">
          {s.search ? (
            <>
              <Stat label="Search impressions (28 days)" value={s.search.impressions.toLocaleString()} hint="Google Search Console" />
              <Stat label="Search clicks (28 days)" value={s.search.clicks.toLocaleString()} hint="Google Search Console" />
            </>
          ) : (
            <div className="md:col-span-2">
              <EmptyState title="Search data not connected">
                Impressions and clicks appear here once Google Search Console is connected. Until then they are shown as unavailable, not zero.
              </EmptyState>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="activity">
            <h2 id="activity" className="section-title">Recent activity</h2>
            {s.recentActivity.length ? (
              <ul className="card divide-y divide-border text-sm">
                {s.recentActivity.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span><span className="font-mono text-xs">{a.action}</span> <span className="text-muted">by {a.actor}</span></span>
                    <time className="shrink-0 text-xs text-muted" dateTime={a.createdAt.toISOString()}>{formatInZone(a.createdAt, s.timezone)}</time>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No activity yet" />
            )}
          </section>
          <section aria-labelledby="attention">
            <h2 id="attention" className="section-title">Errors and required actions</h2>
            {s.attention.length ? (
              <ul className="card divide-y divide-border text-sm">
                {s.attention.map((j) => (
                  <li key={j.id} className="px-4 py-2">
                    <Badge tone="danger">{j.status}</Badge> <span className="text-muted">at stage {j.stage}</span>
                    <p className="mt-1 text-xs text-muted">{(j.error as { message?: string } | null)?.message ?? 'No details recorded'}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing needs attention" />
            )}
          </section>
        </div>
      </div>
    </>
  );
}
