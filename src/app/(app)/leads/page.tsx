import Link from 'next/link';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { icps, leads, LEAD_STATUSES } from '@/lib/db/schema';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { bulkLeadAction } from '../../actions';

const PAGE_SIZE = 100;

export default async function LeadsPage({ searchParams }: PageProps<'/leads'>) {
  const sp = await searchParams;
  const status = typeof sp.status === 'string' ? sp.status : '';
  const segment = typeof sp.segment === 'string' ? sp.segment : '';
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const page = Math.max(1, Number(sp.page) || 1);

  const db = await getDb();
  const filters: SQL[] = [];
  if (segment) filters.push(eq(leads.segment, segment));
  if (q) filters.push(or(ilike(leads.company, `%${q}%`), ilike(leads.contactName, `%${q}%`), ilike(leads.city, `%${q}%`))!);
  const where = filters.length ? and(...filters) : undefined;
  const whereWithStatus = status ? and(where, eq(leads.status, status as (typeof LEAD_STATUSES)[number])) : where;

  const [rows, byStatus, segments, [{ total }]] = await Promise.all([
    db
      .select()
      .from(leads)
      .where(whereWithStatus)
      .orderBy(desc(leads.finalScore), desc(leads.updatedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ status: leads.status, n: sql<number>`count(*)::int` }).from(leads).where(where).groupBy(leads.status),
    db.select({ segment: icps.segment }).from(icps),
    db.select({ total: sql<number>`count(*)::int` }).from(leads).where(whereWithStatus),
  ]);
  const counts: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const all = Object.values(counts).reduce((a, b) => a + b, 0);

  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(status && { status }), ...(segment && { segment }), ...(q && { q }), ...next });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/leads${p.size ? `?${p}` : ''}`;
  };

  return (
    <>
      <PageHeader title="Leads" description="Every company, its research, decision-maker and outreach draft.">
        <Link href="/leads/new" className="btn-primary">Add companies</Link>
      </PageHeader>

      <form className="mb-4 flex flex-wrap gap-2" action="/leads">
        {status && <input type="hidden" name="status" value={status} />}
        <input name="q" defaultValue={q} placeholder="Search company, contact or city" className="field max-w-xs" />
        <select name="segment" defaultValue={segment} className="field w-auto">
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.segment} value={s.segment}>{s.segment}</option>
          ))}
        </select>
        <button className="btn-secondary">Filter</button>
      </form>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <Link href={link({ status: '', page: '' })} className={`rounded-full border px-3 py-1 text-xs ${!status ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}>
          All <span className="tabular-nums">{all}</span>
        </Link>
        {LEAD_STATUSES.filter((s) => counts[s]).map((s) => (
          <Link
            key={s}
            href={link({ status: s, page: '' })}
            className={`rounded-full border px-3 py-1 text-xs ${status === s ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}
          >
            {s} <span className="tabular-nums">{counts[s]}</span>
          </Link>
        ))}
      </div>

      <form action={bulkLeadAction} className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
          <span className="text-ink-2">With selected:</span>
          <button name="action" value="requeue" className="btn-secondary px-2.5 py-1 text-xs">Research again</button>
          <button name="action" value="approve" className="btn-secondary px-2.5 py-1 text-xs">Approve</button>
          <button name="action" value="reject" className="btn-secondary px-2.5 py-1 text-xs">Reject</button>
          <button name="action" value="delete" className="btn-danger px-2.5 py-1 text-xs">Delete</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="w-10 px-4 py-2"><span className="sr-only">Select</span></th>
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Decision-maker</th>
                <th className="px-2 py-2 font-medium">Email</th>
                <th className="px-2 py-2 font-medium">Phone</th>
                <th className="px-2 py-2 font-medium">LinkedIn</th>
                <th className="px-4 py-2 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="border-t border-line align-top hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <input type="checkbox" name="ids" value={l.id} aria-label={`Select ${l.company}`} />
                  </td>
                  <td className="px-2 py-3">
                    <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company}</Link>
                    <div className="text-xs text-muted">{[l.segment, l.city, l.website].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-2 py-3"><StatusPill status={l.status} /></td>
                  <td className="px-2 py-3">
                    {l.contactName ? (
                      <>
                        <div>{l.contactName}</div>
                        <div className="max-w-[13rem] truncate text-xs text-muted">{l.contactTitle}</div>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-2 py-3">
                    {l.contactEmail ? (
                      <a href={`mailto:${l.contactEmail}`} className="block max-w-[13rem] truncate hover:underline" title={l.contactEmail}>{l.contactEmail}</a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    {l.emailStatus && <div className="text-xs text-muted">{l.emailStatus}</div>}
                  </td>
                  <td className="px-2 py-3 whitespace-nowrap">
                    {l.contactPhone ? (
                      <a href={`tel:${l.contactPhone.replace(/[^+\d]/g, '')}`} className="hover:underline">{l.contactPhone}</a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-2 py-3 whitespace-nowrap">
                    {l.contactLinkedin ? (
                      <a href={l.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">Profile ↗</a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{l.finalScore ?? '—'}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted">
                    No leads here. <Link href="/leads/new" className="text-accent hover:underline">Add companies</Link> or run a prospect search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </form>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-2">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            {page > 1 && <Link href={link({ page: String(page - 1) })} className="btn-secondary">Previous</Link>}
            {page * PAGE_SIZE < total && <Link href={link({ page: String(page + 1) })} className="btn-secondary">Next</Link>}
          </div>
        </div>
      )}
    </>
  );
}
