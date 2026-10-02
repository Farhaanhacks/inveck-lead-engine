import Link from 'next/link';
import { and, desc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { ensureResearch, requestOrigin } from '@/lib/run-driver';
import { icps, leads, LEAD_STATUSES } from '@/lib/db/schema';
import { getCurrentUser, listBdas } from '@/lib/users';
import { assignUnowned } from '@/lib/assign';
import { runDailyDraw } from '@/lib/draw';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { StatusPill } from '@/components/status-pill';
import { bulkLeadAction } from '../../actions';
import { isPast, relativeDays } from '@/lib/dates';

const PAGE_SIZE = 100;

// Research started from this page keeps working after the response.
export const maxDuration = 300;

export default async function LeadsPage({ searchParams }: PageProps<'/leads'>) {
  const sp = await searchParams;
  const status = typeof sp.status === 'string' ? sp.status : '';
  const segment = typeof sp.segment === 'string' ? sp.segment : '';
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const page = Math.max(1, Number(sp.page) || 1);

  await ensureResearch(await requestOrigin());
  const db = await getDb();
  await assignUnowned(db);
  await runDailyDraw(db);
  const me = await getCurrentUser();
  const team = await listBdas(db);
  const names = new Map(team.map((b) => [b.id, b.name]));
  // Team members see only their own leads. Administrators can look at everyone's or one person's.
  const isAdmin = me?.role === 'admin';
  const ownerParam = !isAdmin ? 'me' : typeof sp.owner === 'string' ? sp.owner : 'all';
  const ownerId = ownerParam === 'me' ? me?.id : Number(ownerParam) || 0;
  const filters: SQL[] = [];
  if (ownerId) filters.push(eq(leads.ownerId, ownerId));
  if (segment) filters.push(eq(leads.segment, segment));
  if (q) filters.push(or(ilike(leads.company, `%${q}%`), ilike(leads.contactName, `%${q}%`), ilike(leads.city, `%${q}%`))!);
  const where = filters.length ? and(...filters) : undefined;
  // "All" leaves out disqualified companies; they have their own filter.
  const whereWithStatus = status
    ? and(where, eq(leads.status, status as (typeof LEAD_STATUSES)[number]))
    : and(where, ne(leads.status, 'Disqualified'));

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
  const all = Object.entries(counts).reduce((a, [s, n]) => (s === 'Disqualified' ? a : a + n), 0);

  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({ ...(status && { status }), ...(segment && { segment }), ...(q && { q }), owner: ownerParam, ...next });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/leads${p.size ? `?${p}` : ''}`;
  };

  return (
    <>
      <PageHeader title="Leads" description="Every company, its research, decision-maker and outreach draft.">
        <Link href="/leads/new" className="btn-primary">Add companies</Link>
      </PageHeader>

      <AutoFilterForm className="mb-4 flex flex-wrap gap-2">
        {status && <input type="hidden" name="status" value={status} />}
        <input type="hidden" name="owner" value={ownerParam} />
        <input type="search" aria-label="Search company, contact or city" name="q" defaultValue={q} placeholder="Search company, contact or city" className="field max-w-xs" />
        <select aria-label="Segment" name="segment" defaultValue={segment} className="field w-auto">
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.segment} value={s.segment}>{s.segment}</option>
          ))}
        </select>
      </AutoFilterForm>

      {isAdmin && team.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="mr-1 text-muted">Showing</span>
          {me && me.id ? (
            <Link href={link({ owner: 'me', page: '' })} className={`rounded-full border px-3 py-1 ${ownerParam === 'me' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}>My leads</Link>
          ) : null}
          <Link href={link({ owner: 'all', page: '' })} className={`rounded-full border px-3 py-1 ${ownerParam === 'all' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}>Everyone</Link>
          {team.filter((b) => b.id !== me?.id).map((b) => (
            <Link key={b.id} href={link({ owner: String(b.id), page: '' })} className={`rounded-full border px-3 py-1 ${ownerParam === String(b.id) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}>{b.name}</Link>
          ))}
        </div>
      )}

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
          <table className="w-full min-w-[1020px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="w-10 px-4 py-2"><span className="sr-only">Select</span></th>
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Owner</th>
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
                  <td className="px-2 py-3">
                    <StatusPill status={l.status} />
                    {l.status === 'Contacted' && l.nextFollowUpAt && (
                      <div className={`mt-1 text-xs ${isPast(l.nextFollowUpAt) ? 'font-medium text-warning-ink' : 'text-muted'}`}>
                        Follow-up {l.followUpStep + 1} {isPast(l.nextFollowUpAt) ? 'due' : relativeDays(l.nextFollowUpAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-3 text-ink-2">
                    {l.ownerId ? names.get(l.ownerId) ?? '' : <span className="text-muted">—</span>}
                    {l.inbound && <div className="text-xs text-muted">Inbound</div>}
                  </td>
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
                    {l.contactPhone && (
                      <a href={`tel:${l.contactPhone.replace(/[^+\d]/g, '')}`} className="block hover:underline">{l.contactPhone}</a>
                    )}
                    {l.companyPhone && (
                      <a href={`tel:${l.companyPhone.replace(/[^+\d]/g, '')}`} className={`block hover:underline ${l.contactPhone ? 'text-xs text-muted' : ''}`}>
                        {l.companyPhone} <span className="text-xs text-muted">(HQ)</span>
                      </a>
                    )}
                    {!l.contactPhone && !l.companyPhone && <span className="text-muted">—</span>}
                  </td>
                  <td className="px-2 py-3 whitespace-nowrap">
                    {l.contactLinkedin ? (
                      <a href={l.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a>
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
