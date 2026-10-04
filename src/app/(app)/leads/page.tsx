import Link from 'next/link';
import { and, desc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { after } from 'next/server';
import { ensureResearch, liveServices, requestOrigin } from '@/lib/run-driver';
import { fillMissingDrafts } from '@/lib/pipeline/redraft';
import { icps, leads, LEAD_STATUSES, type Lead } from '@/lib/db/schema';
import { getCurrentUser, listBdas } from '@/lib/users';
import { assignUnowned } from '@/lib/assign';
import { runDailyDraw } from '@/lib/draw';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { StatusPill } from '@/components/status-pill';
import { bulkLeadAction } from '../../actions';
import { isPast, relativeDays } from '@/lib/dates';
import { fitAssessment, TONE_CLASS } from '@/lib/fit-view';

const PAGE_SIZE = 100;

/** The ICP fit score, the assessment, and (unless qualified) why, with any commercial risk. */
function FitCell({ lead }: { lead: Lead }) {
  const fit = fitAssessment(lead);
  if (!fit) return <span className="text-muted">—</span>;
  // The badge already says "Needs review" or "Not a fit": the line under it says why.
  const why = fit.tone === 'good' ? '' : fit.detail.replace(/^(Needs review|Not a fit):\s*/i, '').replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="max-w-[20rem]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold tabular-nums">{lead.fitScore != null ? `${lead.fitScore}/10` : '—'}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[fit.tone]}`}>{fit.label}</span>
      </div>
      {why && <p className="mt-1 line-clamp-3 text-xs text-ink-2" title={why}>{why}</p>}
      {lead.riskFlags.length > 0 && (
        <p className="mt-1 text-xs text-warning-ink" title="Recorded apart from the ICP fit">Risk: {lead.riskFlags.map((r) => r.label).join(', ')}</p>
      )}
    </div>
  );
}

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
  // Qualified leads missing an email or LinkedIn draft get them written in the background.
  after(async () => { await fillMissingDrafts(await getDb(), await liveServices(), { limit: 8 }); });
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
      // Best ICP fit first, whatever became of the company; companies not assessed yet last.
      .orderBy(sql`${leads.fitScore} desc nulls last`, sql`${leads.finalScore} desc nulls last`, desc(leads.updatedAt))
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
          <button
            name="action"
            value="reassess"
            className="btn-secondary px-2.5 py-1 text-xs"
            title="Companies ruled out or waiting on review are checked again under the evidence rules; their earlier assessment stays on the timeline"
          >
            Reassess fit
          </button>
          <button name="action" value="approve" className="btn-secondary px-2.5 py-1 text-xs">Approve</button>
          <button name="action" value="reject" className="btn-secondary px-2.5 py-1 text-xs">Reject</button>
          <button name="action" value="delete" className="btn-danger px-2.5 py-1 text-xs">Delete</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="w-10 px-4 py-2"><span className="sr-only">Select</span></th>
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">ICP fit</th>
                <th className="px-2 py-2 font-medium">Owner</th>
                <th className="px-2 py-2 font-medium">Decision-maker</th>
                <th className="px-4 py-2 font-medium">LinkedIn</th>
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
                  <td className="px-2 py-3">
                    <FitCell lead={l} />
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
                  <td className="px-4 py-3 whitespace-nowrap">
                    {l.contactLinkedin ? (
                      <a href={l.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted">
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
