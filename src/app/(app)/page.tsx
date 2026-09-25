import Link from 'next/link';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, LEAD_STATUSES, runs } from '@/lib/db/schema';
import { activeRun } from '@/lib/runs';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { RunButtons } from '@/components/run-buttons';

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

/** Horizontal bars, one hue, each labelled with its count; the label carries identity. */
function BarList({ rows }: { rows: { label: React.ReactNode; key: string; value: number; href?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const content = (
          <div className="grid grid-cols-[8.5rem_1fr_2.5rem] sm:grid-cols-[11.5rem_1fr_2.5rem] items-center gap-3 rounded-md px-1 py-0.5 hover:bg-surface-2" title={`${r.key}: ${r.value}`}>
            <div className="truncate text-sm text-ink-2">{r.label}</div>
            <div className="h-3 rounded-r-[4px] bg-bar" style={{ width: r.value ? `max(4px, ${(r.value / max) * 100}%)` : 0 }} />
            <div className="text-right text-sm tabular-nums">{r.value}</div>
          </div>
        );
        return <li key={r.key}>{r.href ? <Link href={r.href}>{content}</Link> : content}</li>;
      })}
    </ul>
  );
}

export default async function Dashboard() {
  const db = await getDb();
  const [byStatus, bySegment, [totals], topLeads, [lastRun], running] = await Promise.all([
    db.select({ status: leads.status, n: sql<number>`count(*)::int` }).from(leads).groupBy(leads.status),
    db
      .select({ segment: leads.segment, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(eq(leads.qualified, true))
      .groupBy(leads.segment),
    db
      .select({
        total: sql<number>`count(*)::int`,
        qualified: sql<number>`(count(*) filter (where qualified))::int`,
        contacts: sql<number>`(count(*) filter (where contact_name <> ''))::int`,
        emails: sql<number>`(count(*) filter (where contact_email <> ''))::int`,
        drafts: sql<number>`(count(*) filter (where status = 'Awaiting Approval'))::int`,
        contacted: sql<number>`(count(*) filter (where status = 'Contacted'))::int`,
      })
      .from(leads),
    db.select().from(leads).where(eq(leads.status, 'Awaiting Approval')).orderBy(desc(leads.finalScore)).limit(6),
    db.select().from(runs).orderBy(desc(runs.id)).limit(1),
    activeRun(db),
  ]);
  const counts: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));

  return (
    <>
      <PageHeader title="Dashboard" description="Prospects found, researched and ready for outreach.">
        <RunButtons running={!!running} runId={running?.id} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Companies" value={totals.total} note={`${counts.New ?? 0} waiting for research`} />
        <StatTile label="Qualified" value={totals.qualified} note="Match an ICP" />
        <StatTile label="Decision-makers found" value={totals.contacts} note={`${totals.emails} with email`} />
        <StatTile label="Drafts to approve" value={totals.drafts} />
        <StatTile label="Contacted" value={totals.contacted} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <section className="card p-5 lg:col-span-3">
          <h2 className="text-sm font-semibold">Pipeline by status</h2>
          <p className="mb-4 text-xs text-muted">Number of companies in each status. Click a row to see them.</p>
          <BarList
            rows={LEAD_STATUSES.filter((s) => s !== 'Processing' || counts[s]).map((s) => ({
              key: s,
              label: s,
              value: counts[s] ?? 0,
              href: `/leads?status=${encodeURIComponent(s)}`,
            }))}
          />
        </section>

        <div className="space-y-6 lg:col-span-2">
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Qualified by segment</h2>
            <p className="mb-4 text-xs text-muted">Qualified companies per ICP.</p>
            {bySegment.length ? (
              <BarList rows={bySegment.map((r) => ({ key: r.segment || 'None', label: r.segment || 'None', value: r.n }))} />
            ) : (
              <p className="text-sm text-muted">Nothing qualified yet.</p>
            )}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold">Last run</h2>
            {lastRun ? (
              <div className="mt-2 text-sm text-ink-2">
                <Link href={`/runs?id=${lastRun.id}`} className="font-medium text-accent hover:underline">
                  Run #{lastRun.id}
                </Link>{' '}
                · {lastRun.status} · {new Date(lastRun.startedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                <div className="mt-1 text-xs text-muted">
                  {lastRun.stats.processed} researched · {lastRun.stats.drafted} drafts · {lastRun.stats.prospectsAdded} new prospects
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">No runs yet. Add companies, or click “Find prospects &amp; research”.</p>
            )}
          </section>
        </div>
      </div>

      <section className="card mt-6 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-sm font-semibold">Top drafts waiting for approval</h2>
          <Link href="/leads?status=Awaiting%20Approval" className="text-sm text-accent hover:underline">
            See all
          </Link>
        </div>
        {topLeads.length ? (
          <table className="w-full text-sm">
            <tbody>
              {topLeads.map((l) => (
                <tr key={l.id} className="border-t border-line hover:bg-surface-2">
                  <td className="px-5 py-3">
                    <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company}</Link>
                    <div className="text-xs text-muted">{l.segment}</div>
                  </td>
                  <td className="hidden px-5 py-3 text-ink-2 sm:table-cell">
                    {l.contactName || '—'}
                    <div className="text-xs text-muted">{l.contactTitle}</div>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums" title="Score out of 100">{l.finalScore ?? '—'}</td>
                  <td className="px-5 py-3 text-right"><StatusPill status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 pb-5 text-sm text-muted">No drafts waiting.</p>
        )}
      </section>
    </>
  );
}
