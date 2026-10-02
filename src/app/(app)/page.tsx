import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { ensureResearch, requestOrigin } from '@/lib/run-driver';
import { leads, opportunities } from '@/lib/db/schema';
import { RadarCard } from '@/components/radar-card';
import { getAnalytics, type Best } from '@/lib/analytics';
import { Funnel, WeeklyColumns } from '@/components/charts';
import { relativeDays } from '@/lib/dates';
import { activeRun } from '@/lib/runs';
import { getRunView, listRuns } from '@/lib/run-view';
import { RunPanel } from '@/components/run-panel';
import { PageHeader } from '@/components/page-header';
import { RunButtons } from '@/components/run-buttons';
import { HunterNotice } from '@/components/hunter-notice';
import { adminPage } from '@/lib/access';
import { listBdas } from '@/lib/users';

// Runs started from this page keep working after the response (see actions.ts).
export const maxDuration = 300;

function StatTile({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-muted">{note}</div>}
    </div>
  );
}

function BestRow({ label, best }: { label: string; best: Best }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">
        {best ? (
          <>
            <span className="font-medium">{best.name}</span>
            <span className="text-ink-2">
              {' '}· {best.hits} of {best.total} {best.metric === 'replied' ? 'replied' : 'qualified'} ({best.rate}%)
            </span>
          </>
        ) : (
          <span className="text-muted">Not enough data yet</span>
        )}
      </dd>
    </div>
  );
}

export default async function Dashboard({ searchParams }: PageProps<'/'>) {
  await adminPage();
  const wanted = Number((await searchParams).run) || 0;
  await ensureResearch(await requestOrigin());
  const db = await getDb();
  const team = await listBdas(db);
  const [byStatus, analytics, [totals], topLeads, runList, running, fresh, added, [{ waiting }]] = await Promise.all([
    db.select({ status: leads.status, n: sql<number>`count(*)::int` }).from(leads).groupBy(leads.status),
    getAnalytics(db),
    db
      .select({
        total: sql<number>`count(*)::int`,
        qualified: sql<number>`(count(*) filter (where qualified))::int`,
        contacts: sql<number>`(count(*) filter (where contact_name <> ''))::int`,
        emails: sql<number>`(count(*) filter (where contact_email <> ''))::int`,
        drafts: sql<number>`(count(*) filter (where status = 'Awaiting Approval'))::int`,
      })
      .from(leads),
    db.select().from(leads).where(eq(leads.status, 'Awaiting Approval')).orderBy(desc(leads.finalScore)).limit(6),
    listRuns(db),
    activeRun(db),
    db.select().from(opportunities).where(eq(opportunities.status, 'new')).orderBy(desc(opportunities.id)).limit(6),
    db.select().from(opportunities).where(eq(opportunities.status, 'added')).orderBy(desc(opportunities.id)).limit(3),
    db.select({ waiting: sql<number>`count(*)::int` }).from(opportunities).where(eq(opportunities.status, 'new')),
  ]);
  const counts: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const shownRun = wanted || running?.id || runList[0]?.id;
  const runView = shownRun ? await getRunView(db, shownRun) : null;
  const activity = <RunPanel key={shownRun ?? 0} runs={runList} initial={runView ? JSON.parse(JSON.stringify(runView)) : null} />;

  return (
    <>
      <PageHeader title="Dashboard" description="Prospects found, researched and ready for outreach.">
        <RunButtons running={!!running} runId={running?.id} team={team.map((u) => ({ id: u.id, name: u.name }))} />
      </PageHeader>

      <div className="mb-6 empty:hidden">
        <HunterNotice />
      </div>

      {running && <div className="mb-6">{activity}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Companies" value={totals.total} note={`${counts.New ?? 0} waiting for research`} />
        <StatTile label="Qualified" value={totals.qualified} note={`${totals.contacts} decision-makers, ${totals.emails} emails`} />
        <StatTile label="Drafts to approve" value={totals.drafts} />
        <StatTile
          label="Emails sent"
          value={analytics.funnel[2].value}
          note={`${analytics.awaitingReply} awaiting reply · ${analytics.followUpsDue.length} follow-ups due`}
        />
        <StatTile label="Replied" value={analytics.funnel[3].value} note={analytics.replyRate != null ? `${analytics.replyRate}% reply rate` : 'No emails sent yet'} />
      </div>

      <div className="mt-6">
        <RadarCard fresh={fresh} added={added} total={waiting} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <section className="card p-5 lg:col-span-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Funnel</h2>
            <Link href="/pipeline" className="text-sm text-accent hover:underline">Open pipeline board</Link>
          </div>
          <p className="mb-4 text-xs text-muted">Companies at each step, and how many made it from the step before.</p>
          <Funnel steps={analytics.funnel} />
        </section>

        <div className="space-y-6 lg:col-span-2">
          <section className="card p-5">
            <h2 className="text-sm font-semibold">What’s working</h2>
            <p className="mb-3 text-xs text-muted">
              {analytics.bestSegment?.metric === 'replied' ? 'By reply rate.' : 'By qualification rate, until replies come in.'}
            </p>
            <dl className="space-y-3">
              <BestRow label="Best segment" best={analytics.bestSegment} />
              <BestRow label="Best lead source" best={analytics.bestSource} />
            </dl>
          </section>

          <section className="card p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Follow-ups due</h2>
              <span className="text-xs text-muted tabular-nums">{analytics.followUpsDue.length}</span>
            </div>
            {analytics.followUpsDue.length ? (
              <ul className="mt-2 divide-y divide-line">
                {analytics.followUpsDue.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link href={`/leads/${l.id}`} className="min-w-0 truncate font-medium hover:underline">
                      {l.company}
                    </Link>
                    <span className="shrink-0 text-xs text-warning-ink">
                      Follow-up {l.followUpStep + 1} · {l.followUpBody ? 'draft ready' : 'due'} {l.nextFollowUpAt ? relativeDays(l.nextFollowUpAt) : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">Nothing due. Follow-ups are scheduled for day 3 and day 7 after a lead is marked as sent.</p>
            )}
          </section>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <section className="card p-5 lg:col-span-3">
          <h2 className="text-sm font-semibold">Weekly activity</h2>
          <p className="mb-4 text-xs text-muted">Last 8 weeks, Monday to Sunday. Hover a column for its value.</p>
          <div className="grid gap-6 sm:grid-cols-2">
            <WeeklyColumns title="First emails sent" weeks={analytics.weeks} pick={(w) => w.sent} max={Math.max(...analytics.weeks.flatMap((w) => [w.sent, w.replied]))} />
            <WeeklyColumns title="Replies" weeks={analytics.weeks} pick={(w) => w.replied} max={Math.max(...analytics.weeks.flatMap((w) => [w.sent, w.replied]))} />
          </div>
        </section>

        <section className="card overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <h2 className="text-sm font-semibold">Top drafts to approve</h2>
            <Link href="/leads?status=Awaiting%20Approval" className="text-sm text-accent hover:underline">See all</Link>
          </div>
          {topLeads.length ? (
            <ul>
              {topLeads.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 border-t border-line px-5 py-2.5 text-sm hover:bg-surface-2">
                  <span className="min-w-0">
                    <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company}</Link>
                    <span className="block truncate text-xs text-muted">{[l.contactName, l.contactTitle].filter(Boolean).join(' · ') || l.segment}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-2" title="Score out of 100">{l.finalScore ?? '—'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 pb-5 text-sm text-muted">No drafts waiting.</p>
          )}
        </section>
      </div>

      {!running && <div className="mt-6">{activity}</div>}
    </>
  );
}
