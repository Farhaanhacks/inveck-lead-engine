import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/users';
import { assignUnowned } from '@/lib/assign';
import { runDailyDraw } from '@/lib/draw';
import { ownerScope } from '@/lib/access';
import { CALL_FEEDBACK, CALL_STATUSES, cleanDay, CONTACT_CHANNELS, DATE_FILTERS, inDayRange, LINKEDIN_OUTCOMES, loadTracker, MAIL_OUTCOMES, trackerCells } from '@/lib/tracker';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { TrackerTable, type TrackerViewRow } from './tracker-table';
import { icps } from '@/lib/db/schema';

export default async function TrackerPage({ searchParams }: PageProps<'/tracker'>) {
  const me = (await getCurrentUser())!;
  const db = await getDb();
  await assignUnowned(db);
  await runDailyDraw(db);
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim().toLowerCase() : '';
  const feedback = typeof sp.feedback === 'string' ? sp.feedback : '';
  // A date, or a range of dates (start and end), on the day the lead was added or last called.
  const dateBy = DATE_FILTERS.some((d) => d.value === sp.dateBy) ? (sp.dateBy as 'added' | 'call') : 'added';
  const from = cleanDay(sp.from);
  const to = cleanDay(sp.to);
  const backwards = !!from && !!to && from > to;
  const [all, segmentRows] = await Promise.all([loadTracker(db, ownerScope(me)), db.select({ segment: icps.segment, active: icps.active }).from(icps)]);
  const segments = segmentRows.filter((r) => r.active).map((r) => r.segment);
  const rows = all.filter(
    (r) =>
      (!q || [r.lead.company, r.lead.contactName, r.lead.city].some((v) => v.toLowerCase().includes(q))) &&
      (!feedback || (feedback === 'none' ? !r.lead.callFeedback : r.lead.callFeedback === feedback)) &&
      (backwards || inDayRange(dateBy === 'call' ? r.lastCallAt : r.lead.createdAt, from, to)),
  );
  const view: TrackerViewRow[] = rows.map((r) => {
    const c = trackerCells(r);
    return {
      id: r.lead.id,
      cells: {
        company: c[0],
        location: c[1],
        name: c[3],
        title: c[4],
        phone: c[6],
        email: r.lead.contactEmail,
        callStatus: c[7],
        callRemark: c[9],
        callsDone: c[10],
        callDate: c[11],
        status: c[14],
        segment: c[16],
        poc: c[17],
        date: c[18],
        owner: c[19],
      },
      callStatus: r.lead.callStatus,
      autoCallStatus: r.autoCallStatus,
      callFeedback: r.lead.callFeedback,
      contactChannel: r.lead.contactChannel,
      autoChannel: r.autoChannel,
      mailOutcome: r.mailOutcome,
      linkedinOutcome: r.linkedinOutcome,
      remark: r.lead.remark,
      linkedin: r.lead.contactLinkedin,
      website: r.lead.website,
    };
  });

  return (
    <>
      <PageHeader title="Tracker" description="Every lead in one table, with the columns INVECK asked for plus mail and LinkedIn outcomes. Outcomes and remarks save as you change them.">
        <a href="/api/tracker/csv" download className="btn-secondary">Download CSV</a>
      </PageHeader>
      <AutoFilterForm className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <input type="search" name="q" defaultValue={q} aria-label="Search company, person or city" placeholder="Search company, person or city" className="field h-9 max-w-xs py-1.5" />
        <select name="feedback" defaultValue={feedback} aria-label="Call outcome" className="field h-9 w-auto py-1.5">
          <option value="">Any call outcome</option>
          <option value="none">No outcome yet</option>
          {CALL_FEEDBACK.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Filter by date</legend>
          <select name="dateBy" defaultValue={dateBy} aria-label="Which date to filter on" className="field h-9 w-auto py-1.5">
            {DATE_FILTERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <label className="flex items-center gap-1 text-muted">
            From
            <input type="date" name="from" defaultValue={from} max={to || undefined} aria-label="From date" className="field h-9 w-auto py-1.5" />
          </label>
          <label className="flex items-center gap-1 text-muted">
            To
            <input type="date" name="to" defaultValue={to} min={from || undefined} aria-label="To date" className="field h-9 w-auto py-1.5" />
          </label>
          {(from || to) && (
            <a href={`/tracker?${new URLSearchParams({ ...(q ? { q } : {}), ...(feedback ? { feedback } : {}) })}`} className="text-xs font-medium text-accent hover:underline">Clear dates</a>
          )}
        </fieldset>
        <span className="ml-auto text-xs text-muted tabular-nums">{rows.length} of {all.length} leads</span>
      </AutoFilterForm>
      {backwards && <p role="alert" className="mb-3 text-xs text-critical-ink">The start date is after the end date, so the dates are not being used. Pick a start on or before the end.</p>}
      {(from || to) && !backwards && (
        <p className="mb-3 text-xs text-muted">
          {DATE_FILTERS.find((d) => d.value === dateBy)!.label}: {from && to ? (from === to ? from : `${from} to ${to}`) : from ? `from ${from}` : `up to ${to}`}.
          {dateBy === 'call' ? ' Leads not called yet are left out.' : ''}
        </p>
      )}
      <TrackerTable rows={view} options={{ contactChannel: CONTACT_CHANNELS, callStatus: CALL_STATUSES, callFeedback: CALL_FEEDBACK, mailOutcome: MAIL_OUTCOMES, linkedinOutcome: LINKEDIN_OUTCOMES }} showOwner={me.role === 'admin'} segments={segments} />
    </>
  );
}
