import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/users';
import { assignUnowned } from '@/lib/assign';
import { ownerScope } from '@/lib/access';
import { CALL_FEEDBACK, LINKEDIN_OUTCOMES, loadTracker, MAIL_OUTCOMES, trackerCells } from '@/lib/tracker';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { TrackerTable, type TrackerViewRow } from './tracker-table';

export default async function TrackerPage({ searchParams }: PageProps<'/tracker'>) {
  const me = (await getCurrentUser())!;
  const db = await getDb();
  await assignUnowned(db);
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim().toLowerCase() : '';
  const feedback = typeof sp.feedback === 'string' ? sp.feedback : '';
  const all = await loadTracker(db, ownerScope(me));
  const rows = all.filter(
    (r) =>
      (!q || [r.lead.company, r.lead.contactName, r.lead.city].some((v) => v.toLowerCase().includes(q))) &&
      (!feedback || (feedback === 'none' ? !r.lead.callFeedback : r.lead.callFeedback === feedback)),
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
        callStatus: c[7],
        callRemark: c[9],
        callsDone: c[10],
        callDate: c[11],
        email: c[12],
        status: c[15],
        segment: c[17],
        poc: c[18],
        date: c[19],
        owner: c[20],
      },
      callFeedback: r.lead.callFeedback,
      mailOutcome: r.mailOutcome,
      linkedinOutcome: r.linkedinOutcome,
      remark: r.lead.remark,
      linkedin: r.lead.contactLinkedin,
      website: r.lead.website,
    };
  });

  return (
    <>
      <PageHeader title="Tracker" description="Every lead in one sheet, with the same columns as the team's Google Sheet. Outcomes and remarks save as you change them.">
        <a href="/api/tracker/csv" download className="btn-secondary">Download CSV</a>
      </PageHeader>
      <AutoFilterForm className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <input type="search" name="q" defaultValue={q} aria-label="Search company, person or city" placeholder="Search company, person or city" className="field h-9 max-w-xs py-1.5" />
        <select name="feedback" defaultValue={feedback} aria-label="Call outcome" className="field h-9 w-auto py-1.5">
          <option value="">Any call outcome</option>
          <option value="none">No outcome yet</option>
          {CALL_FEEDBACK.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <span className="ml-auto text-xs text-muted tabular-nums">{rows.length} of {all.length} leads</span>
      </AutoFilterForm>
      {view.length ? (
        <TrackerTable rows={view} options={{ callFeedback: CALL_FEEDBACK, mailOutcome: MAIL_OUTCOMES, linkedinOutcome: LINKEDIN_OUTCOMES }} showOwner={me.role === 'admin'} />
      ) : (
        <div className="card p-8 text-center text-sm text-muted">No leads here yet. Researched leads appear here.</div>
      )}
    </>
  );
}
