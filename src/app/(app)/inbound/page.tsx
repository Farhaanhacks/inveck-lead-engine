import Link from 'next/link';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { InboundSync } from '@/components/inbound-sync';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { adminPage } from '@/lib/access';
import { getDb } from '@/lib/db';
import { formatDate, formatDateTime } from '@/lib/dates';
import { filterRows, inboundCounts, loadInbound, monthLabel, monthsOf, SOURCE_LABEL, statusLabel, validMonth, type InboundSource } from '@/lib/inbound-leads';
import { sourceLine } from '@/lib/inbound-demo';

export const dynamic = 'force-dynamic';

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Inbound leads (administrators): demo requests from the website form's sheet, apart from prospecting leads. */
export default async function InboundPage({ searchParams }: PageProps<'/inbound'>) {
  await adminPage();
  const sp = await searchParams;
  const source = (sp.source === 'website' || sp.source === 'linkedin' ? sp.source : '') as InboundSource | '';
  const month = validMonth(sp.month) ? sp.month : '';
  const all = await loadInbound(await getDb());
  const months = monthsOf(all);
  // The month and source filters work together; the cards count exactly the leads listed.
  const rows = filterRows(all, { source, month });
  const c = inboundCounts(rows);
  const filtered = !!(source || month);

  return (
    <>
      <PageHeader title="Inbound leads" description="People who asked for a demo through the website form. Kept apart from prospecting leads, and not part of Today's cold-call queues.">
        <InboundSync />
      </PageHeader>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card label="Total inbound leads" value={c.total} />
        <Card label="Website leads" value={c.website} />
        <Card label="LinkedIn leads" value={c.linkedin} />
        <Card label="Meetings scheduled" value={c.meetings} />
        <Card label="Leads with a response" value={c.responded} />
      </div>

      <AutoFilterForm className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="in-source" className="sr-only">Source</label>
        <select id="in-source" name="source" defaultValue={source} className="field w-auto">
          <option value="">All sources</option>
          <option value="website">Website</option>
          <option value="linkedin">LinkedIn</option>
        </select>
        <label htmlFor="in-month" className="sr-only">Month</label>
        <select id="in-month" name="month" defaultValue={month} className="field w-auto">
          <option value="">All months</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          {month && !months.includes(month) && <option value={month}>{monthLabel(month)}</option>}
        </select>
        {filtered && <Link href="/inbound" className="text-sm text-accent hover:underline">Clear filters</Link>}
        <span className="text-xs text-muted tabular-nums">{rows.length} of {all.length}</span>
      </AutoFilterForm>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              {['Company', 'Contact', 'Assigned BDA', 'Source', 'Registered', 'Meeting', 'Status', 'Responses'].map((h) => <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-muted">{all.length ? <>Nothing matches these filters. <Link href="/inbound" className="text-accent hover:underline">Clear filters</Link></> : 'No inbound leads yet. They appear here once the sheet is synced.'}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-3 py-2.5"><Link href={`/inbound/${r.id}`} className="font-medium hover:underline">{r.lead.company}</Link>{r.lead.city && <div className="text-xs text-muted">{r.lead.city}</div>}</td>
                <td className="px-3 py-2.5">
                  <div>{r.lead.contactName}</div>
                  <div className="text-xs text-muted">{r.lead.contactEmail}</div>
                  <div className="text-xs text-muted">{r.lead.contactPhone}</div>
                </td>
                <td className="px-3 py-2.5">{r.bda || <span className="text-muted">Unassigned</span>}</td>
                <td className="px-3 py-2.5">
                  <div className="font-medium">{SOURCE_LABEL[r.source]}</div>
                  <div className="max-w-[16rem] text-xs text-muted">{sourceLine(r.raw)}</div>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">{formatDate(r.registeredAt)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.meeting ? (
                    <>
                      <div>{formatDateTime(r.meeting.startsAt)}</div>
                      {r.meeting.joinUrl.startsWith('https://') && <a href={r.meeting.joinUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">Join meeting</a>}
                    </>
                  ) : <span className="text-muted">Not booked</span>}
                </td>
                <td className="px-3 py-2.5"><StatusPill status={statusLabel(r)} /></td>
                <td className="px-3 py-2.5 tabular-nums">{r.responses > 0 ? `${r.responses}${r.lastResponseAt ? ` · ${formatDate(r.lastResponseAt)}` : ''}` : <span className="text-muted">None</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
