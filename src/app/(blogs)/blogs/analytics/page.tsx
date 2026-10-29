import { Badge, EmptyState, Notice, PageHeader, Stat, Table } from '@/components/blogs/ui';
import { loadLastSync } from '@/lib/blogs/analytics/last-sync';
import { analyticsReport, combine } from '@/lib/blogs/analytics/report';
import { fmtInt, NO_DATA, searchConsoleView } from '@/lib/blogs/analytics/view';
import { blogActor } from '@/lib/blogs/auth';
import { getDb } from '@/lib/blogs/db/client';
import { integrationPresence } from '@/lib/blogs/env';
import { getSetting } from '@/lib/blogs/settings';
import { formatInZone } from '@/lib/blogs/time';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 28;

export default async function AnalyticsPage() {
  await blogActor();
  const db = await getDb();
  const present = integrationPresence();
  const [report, lastSync, queue] = await Promise.all([analyticsReport(db, new Date(), WINDOW_DAYS), loadLastSync(db), getSetting('queue')]);
  const view = searchConsoleView(report.rows, report.searchCoverage);
  const ga = combine(report.rows.filter((r) => r.sessions !== null || r.returning !== null));

  return (
    <>
      <PageHeader title="Analytics" description={`Last ${WINDOW_DAYS} days for published articles. Unavailable data is shown as ${NO_DATA}, never as zero.`} />
      <div className="space-y-8">
        {!present.searchConsole ? (
          <Notice tone="warn" title="Google Search Console is not connected">
            Set GOOGLE_SERVICE_ACCOUNT_JSON and GSC_SITE_URL in the server environment, and add the service account as a user on the Search Console property.
          </Notice>
        ) : null}

        <section aria-labelledby="sync">
          <h2 id="sync" className="section-title">Daily sync</h2>
          <div className="card flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
            {lastSync ? (
              <div>
                <p className="flex items-center gap-2 font-medium">
                  Last run {formatInZone(lastSync.at, queue.timezone)}
                  <Badge tone={lastSync.failure ? 'danger' : lastSync.errors.length ? 'warn' : 'ok'}>{lastSync.failure ? 'failed' : lastSync.errors.length ? 'finished with errors' : 'ok'}</Badge>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {lastSync.failure
                    ? lastSync.failure
                    : [`${lastSync.searchRows} Search Console day rows stored for ${lastSync.articles} article${lastSync.articles === 1 ? '' : 's'}`, lastSync.unmatched ? `${lastSync.unmatched} rows for pages that are not our articles` : '', ...lastSync.errors.map((e) => `${e.provider}: ${e.message}`), ...lastSync.skipped].filter(Boolean).join(' · ')}
                </p>
              </div>
            ) : (
              <p className="text-muted">No sync has run yet. It runs once a day at about 09:00 IST.</p>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">Search Console data runs about two days behind, so the newest posts take a few days to appear.</p>
        </section>

        <section aria-labelledby="search">
          <h2 id="search" className="section-title">Search (Google Search Console)</h2>
          {view.state === 'no_articles' ? (
            <EmptyState title="No published articles to measure">Only posts published to the live site with a public address are included. Test (mock) publications are left out.</EmptyState>
          ) : view.state === 'no_rows' ? (
            <EmptyState title="No Search Console data yet">
              {view.articles} published article{view.articles === 1 ? '' : 's'} found, but Search Console has no rows for {view.articles === 1 ? 'it' : 'them'} in the last {WINDOW_DAYS} days. New pages usually take a few days to show up.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted">
                Data from {view.coverage.first} to {view.coverage.last} · {view.withData} of {view.articles} article{view.articles === 1 ? '' : 's'} with data
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Clicks" value={view.totals.clicks} />
                <Stat label="Impressions" value={view.totals.impressions} />
                <Stat label="CTR" value={view.totals.ctr} hint="Clicks ÷ impressions" />
                <Stat label="Average position" value={view.totals.position} hint="Weighted by impressions" />
              </div>
              <Table head={['Article', 'Clicks', 'Impressions', 'CTR', 'Position', 'Top queries']}>
                {view.rows.map((r) => (
                  <tr key={r.articleId} className="align-top">
                    <td className="px-4 py-2.5">
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">{r.title}</a>
                      <p className="text-xs text-muted">Published {formatInZone(r.publishedAt, queue.timezone)} · {r.days ? `${r.days} day${r.days === 1 ? '' : 's'} of data` : 'no data yet'}</p>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{r.clicks}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.impressions}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.ctr}</td>
                    <td className="px-4 py-2.5 tabular-nums">{r.position}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {r.queries.length ? (
                        <details>
                          <summary className="cursor-pointer">{r.queries[0].query}{r.queries.length > 1 ? ` +${r.queries.length - 1}` : ''}</summary>
                          <ul className="mt-1 space-y-1">
                            {r.queries.map((q) => <li key={q.query}><span className="font-medium">{q.query}</span><br /><span className="text-muted">{q.detail}</span></li>)}
                          </ul>
                        </details>
                      ) : <span className="text-muted">{NO_DATA}</span>}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </section>

        <section aria-labelledby="engagement">
          <h2 id="engagement" className="section-title">Engagement (Google Analytics 4)</h2>
          {!present.ga4 ? (
            <p className="text-sm text-muted">Not connected. Kept separate from search figures; set GA4_PROPERTY_ID to add sessions and returning visitors.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Sessions" value={fmtInt(ga.sessions)} />
              <Stat label="Engaged sessions" value={fmtInt(ga.engagedSessions)} />
              <Stat label="Returning visitors" value={fmtInt(ga.returning)} />
            </div>
          )}
        </section>
      </div>
    </>
  );
}
