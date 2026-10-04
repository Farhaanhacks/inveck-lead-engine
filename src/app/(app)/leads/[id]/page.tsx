import Link from 'next/link';
import { after } from 'next/server';
import { contactPriority, icpFor } from '@/lib/tiers';
import { candidateRank } from '@/lib/pipeline/contacts';
import { notFound } from 'next/navigation';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { activities, icps, leads, people, type Lead, type Person } from '@/lib/db/schema';
import { Timeline } from '@/components/timeline';
import { FOLLOW_UP_DAYS } from '@/lib/pipeline/follow-ups';
import { formatDate, isPast, relativeDays } from '@/lib/dates';
import { StatusPill } from '@/components/status-pill';
import { CopyButton } from '@/components/copy-button';
import { SubmitButton } from '@/components/submit-button';
import { getCurrentUser, listBdas } from '@/lib/users';
import { canReassign } from '@/lib/assign';
import { assignOwnerAction } from '../../../team-actions';
import { tidyContacts } from '@/lib/verify-contacts';
import { fillMissingDrafts, redraftForContact } from '@/lib/pipeline/redraft';
import { liveServices } from '@/lib/run-driver';
import { contactAvailability, contactGeography, evidenceLabel, evidenceSource, evidenceTone, fitAssessment, riskAssessment, TONE_CLASS, type Assessment } from '@/lib/fit-view';
import { KIND_LABEL } from '@/lib/pipeline/fit';
import { REASSESSABLE } from '@/lib/reassess';
import {
  addLeadAsClientAction,
  confirmFitAction,
  makePrimaryAction,
  markNotFitAction,
  deleteLeadAction,
  reassessFitAction,
  sendFollowUpAction,
  setLeadStatusAction,
  updateLeadAction,
  writeFollowUpAction,
} from '../../../actions';

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StatusButton({ id, action, label, primary }: { id: number; action: string; label: string; primary?: boolean }) {
  return (
    <form action={setLeadStatusAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      <SubmitButton className={primary ? 'btn-primary' : 'btn-secondary'}>{label}</SubmitButton>
    </form>
  );
}

function FollowUpCard({ lead }: { lead: Lead }) {
  const step = lead.followUpStep + 1;
  const total = FOLLOW_UP_DAYS.length;
  if (lead.followUpStep >= total) {
    return (
      <Section title="Follow-ups">
        <p className="text-sm text-ink-2">
          Sequence finished: first email and {total} follow-ups sent. Mark the lead as replied, won or lost when you hear back.
        </p>
      </Section>
    );
  }
  const due = lead.nextFollowUpAt;
  const overdue = !!due && isPast(due);
  return (
    <Section
      title={`Follow-up ${step} of ${total}`}
      aside={
        due && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${overdue ? 'bg-warning-soft text-warning-ink' : 'bg-neutral-soft text-ink-2'}`}>
            Due {relativeDays(due)} · {formatDate(due)}
          </span>
        )
      }
    >
      {lead.followUpBody ? (
        <form action={sendFollowUpAction} className="space-y-3">
          <input type="hidden" name="id" value={lead.id} />
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="followUpSubject" className="label">Subject</label>
              <CopyButton text={lead.followUpSubject} />
            </div>
            <input id="followUpSubject" name="followUpSubject" defaultValue={lead.followUpSubject} className="field" />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="followUpBody" className="label">Body</label>
              <CopyButton text={lead.followUpBody} />
            </div>
            <textarea id="followUpBody" name="followUpBody" defaultValue={lead.followUpBody} rows={6} className="field leading-relaxed" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton pendingText="Saving…">Mark follow-up {step} as sent</SubmitButton>
            <button name="skip" value="1" className="btn-secondary">Skip</button>
          </div>
          <p className="text-xs text-muted">Send it as a reply to your first email, then mark it as sent. The next follow-up is scheduled automatically.</p>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-2">
            {due ? (overdue ? 'Due now. ' : `Scheduled ${relativeDays(due)}. `) : ''}The AI writes it with the next research run, or now if you prefer.
          </p>
          <form action={writeFollowUpAction}>
            <input type="hidden" name="id" value={lead.id} />
            <SubmitButton className="btn-secondary" pendingText="Writing…">Write it now</SubmitButton>
          </form>
        </div>
      )}
    </Section>
  );
}



function Pill({ a }: { a: Pick<Assessment, 'label' | 'tone'> }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[a.tone]}`}>{a.label}</span>;
}

/** A link only for a real web address (sources come from websites and search results). */
function SourceLink({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return null;
  let label = url;
  try {
    const u = new URL(url);
    label = `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}`;
  } catch {}
  return (
    <a href={url} target="_blank" rel="noreferrer" className="break-all text-xs text-accent hover:underline" title={url}>
      {label.length > 60 ? `${label.slice(0, 59)}…` : label}
    </a>
  );
}

/**
 * The four separate judgements on a lead: whether the company fits the ICP (with the evidence for
 * each criterion), commercial risk, whether there's someone to contact, and whether they're at this site.
 */
function AssessmentCard({ lead, primary, listed, canAct }: { lead: Lead; primary?: Person; listed: Person[]; canAct: boolean }) {
  const fit = fitAssessment(lead);
  const risk = riskAssessment(lead);
  const items: [string, Assessment, string][] = [
    ['Company fit', fit ?? { label: 'Not researched yet', tone: 'neutral', detail: '' }, lead.fitScore != null ? `ICP fit ${lead.fitScore}/10` : ''],
    ['Commercial risk', risk, ''],
    ['Contact availability', contactAvailability(lead, listed), ''],
    ['Contact geography', contactGeography(lead, primary), ''],
  ];
  const reviewable = canAct && (REASSESSABLE as readonly string[]).includes(lead.status);
  // Flagged before research (no segment, or one no active ICP has): fix the segment, then reassess.
  const segmentProblem = lead.fitStatus === 'review' && !lead.assessedIcp;
  const decision = fit?.detail ?? '';
  const aiReason = lead.fitStatus && lead.fitReason && lead.fitReason !== lead.fitDecision ? lead.fitReason : '';
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Assessment</h2>
          <p className="mt-0.5 text-xs text-muted">
            {lead.assessedIcp ? `Checked against the ${lead.assessedIcp} ICP${lead.assessedAt ? ` on ${formatDate(lead.assessedAt)}` : ''}. ` : ''}
            Company fit, commercial risk and contacts are judged separately.
          </p>
        </div>
        {reviewable && (
          <div className="flex flex-wrap gap-2">
            <form action={reassessFitAction}>
              <input type="hidden" name="id" value={lead.id} />
              <SubmitButton className="btn-secondary" pendingText="Queuing…">Reassess fit</SubmitButton>
            </form>
            {!segmentProblem && (
              <details className="relative">
                <summary className="btn-primary list-none [&::-webkit-details-marker]:hidden">Confirm fit</summary>
                <form action={confirmFitAction} className="card absolute right-0 z-10 mt-2 w-80 space-y-2 p-4 shadow-lg">
                  <input type="hidden" name="id" value={lead.id} />
                  <p className="text-sm font-medium">Confirm {lead.company} fits?</p>
                  <label htmlFor="confirm-note" className="label">Why (optional)</label>
                  <textarea id="confirm-note" name="note" rows={2} className="field" placeholder="e.g. Chassis maker with 4 plants; insolvency doesn't change the fit" />
                  <p className="text-xs text-muted">Your call stands over the AI&apos;s. Contacts are found and drafts written next; the earlier assessment stays on the timeline.</p>
                  <SubmitButton pendingText="Confirming…">Confirm fit</SubmitButton>
                </form>
              </details>
            )}
            {lead.status === 'Needs Review' && !segmentProblem && (
              <details className="relative">
                <summary className="btn-secondary list-none [&::-webkit-details-marker]:hidden">Not a fit</summary>
                <form action={markNotFitAction} className="card absolute right-0 z-10 mt-2 w-80 space-y-2 p-4 shadow-lg">
                  <input type="hidden" name="id" value={lead.id} />
                  <p className="text-sm font-medium">Rule {lead.company} out?</p>
                  <label htmlFor="notfit-note" className="label">Why (optional)</label>
                  <textarea id="notfit-note" name="note" rows={2} className="field" />
                  <SubmitButton pendingText="Saving…">Not a fit</SubmitButton>
                </form>
              </details>
            )}
          </div>
        )}
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(([title, a, extra]) => (
          <div key={title} className="min-w-0">
            <dt className="text-xs text-muted">{title}</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              <Pill a={a} />
              {extra && <span className="text-sm font-semibold tabular-nums">{extra}</span>}
            </dd>
            {title !== 'Company fit' && a.detail && <dd className="mt-1 text-xs text-ink-2">{a.detail}</dd>}
          </div>
        ))}
      </dl>

      {decision && <p className="mt-4 text-sm leading-relaxed text-ink-2">{decision}</p>}
      {segmentProblem && reviewable && <p className="mt-2 text-xs text-muted">Choose the segment under Company below, save, then press Reassess fit.</p>}
      {aiReason && <p className="mt-2 text-xs text-muted">The AI&apos;s summary: {aiReason}</p>}

      {lead.riskFlags.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {lead.riskFlags.map((r, i) => (
            <li key={i} className="rounded-md border border-line bg-warning-soft/40 px-3 py-2 text-xs text-ink-2">
              <span className="font-medium text-warning-ink">{r.label}:</span> “{r.evidence}” <SourceLink url={r.url} />
              {!r.verified && <span className="text-muted"> (not found in a source)</span>}
            </li>
          ))}
        </ul>
      )}

      {lead.fitEvidence.length > 0 && (
        <details className="mt-4" open={lead.fitStatus !== 'qualified'}>
          <summary className="cursor-pointer text-sm text-accent">Evidence for each criterion ({lead.fitEvidence.length})</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Criterion</th>
                  <th className="py-2 pr-3 font-medium">Finding</th>
                  <th className="py-2 font-medium">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {lead.fitEvidence.map((e) => (
                  <tr key={e.id} className="border-t border-line align-top">
                    <td className="w-[38%] py-2 pr-3">
                      <div className="text-xs text-muted">{e.id} · {KIND_LABEL[e.kind] ?? e.kind}</div>
                      <div className="text-ink-2">{e.criterion}</div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap"><Pill a={{ label: evidenceLabel(e), tone: evidenceTone(e) }} /></td>
                    <td className="py-2">
                      {e.evidence ? <p className="text-ink-2">{e.status === 'unknown' ? e.evidence : `“${e.evidence}”`}</p> : <span className="text-muted">—</span>}
                      <div className="mt-0.5 flex flex-wrap gap-x-2">
                        {e.url && <SourceLink url={e.url} />}
                        {evidenceSource(e) && <span className="text-xs text-muted">{evidenceSource(e)}</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function PeopleCard({ company, city, list }: { company: string; city: string; list: Person[] }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5 pb-3">
        <div>
          <h2 className="text-sm font-semibold">People to contact at {company}</h2>
          <p className="text-xs text-muted">Best first: plant heads, then other operations heads, then process owners. Only people a LinkedIn profile confirms at this company now; the main contact also at this site.</p>
        </div>
        <span className="text-xs text-muted">{list.length} found</span>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">LinkedIn</th>
              <th className="px-2 py-2 font-medium">Found via</th>
              <th className="px-5 py-2"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className="border-t border-line align-top">
                <td className="px-5 py-2.5">
                  <div className="font-medium">
                    {p.name}
                    {p.isPrimary && !p.passedAt && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Main contact</span>}
                    {p.passedAt && (
                      <span className="ml-2 text-xs font-normal text-muted">
                        {p.passedReason === 'unverified' || (p.passedReason === '' && p.isPrimary) ? 'not confirmed on LinkedIn yet, checked again weekly' : 'tried, no luck'}
                      </span>
                    )}
                  </div>
                  <div className="max-w-[16rem] truncate text-xs text-muted" title={p.title}>{p.title || '—'}</div>
                  {(p.location || city) && (
                    <div className="max-w-[16rem] truncate text-xs text-muted" title={p.location}>{p.location || 'Location not confirmed'}</div>
                  )}
                </td>
                <td className="px-2 py-2.5">
                  {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noreferrer" className="whitespace-nowrap text-accent hover:underline">LinkedIn</a> : <span className="text-muted">—</span>}
                </td>
                <td className="px-2 py-2.5 text-xs text-ink-2">{p.source}</td>
                <td className="px-5 py-2.5 text-right">
                  {(!p.isPrimary || p.passedAt) && (
                    <form action={makePrimaryAction}>
                      <input type="hidden" name="personId" value={p.id} />
                      <SubmitButton className="btn-secondary h-7 px-2 py-0.5 text-xs" pendingText="…">Make main contact</SubmitButton>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
        Making someone the main contact rewrites the email for them; the calls and messages on Today go to them from then on.
      </p>
    </section>
  );
}

// Research started from this page keeps working after the response.
export const maxDuration = 300;

export default async function LeadPage({ params }: PageProps<'/leads/[id]'>) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = await getDb();
  const me = await getCurrentUser();
  // A missing lead, or (for a team member) someone else's, is not found; nothing about it is touched.
  const [visible] = await db.select({ ownerId: leads.ownerId }).from(leads).where(eq(leads.id, id));
  if (!visible || (me?.role === 'bda' && visible.ownerId !== me.id)) notFound();
  // Nobody who has left the company is shown: cleared before the page is drawn,
  // and the best-ranked person on file is the main contact while outreach hasn't started.
  if ((await tidyContacts(db, { leadId: id })).length) after(async () => redraftForContact(await getDb(), await liveServices(), id));
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) notFound();
  // A qualified lead missing its email or LinkedIn draft gets them written in the background.
  if (lead.qualified && (!lead.emailBody || !lead.linkedinMessage)) after(async () => { await fillMissingDrafts(await getDb(), await liveServices(), { leadId: id }); });
  const bdas = await listBdas(db);
  const [segmentRows, timeline, found] = await Promise.all([
    db.select().from(icps),
    db.select().from(activities).where(eq(activities.leadId, id)).orderBy(desc(activities.at), desc(activities.id)),
    db.select().from(people).where(eq(people.leadId, id)).orderBy(desc(people.isPrimary), asc(people.id)),
  ]);
  const segments = segmentRows.map((s) => s.segment);
  const icp = icpFor(lead.segment, segmentRows);
  // Main contact first, then everyone else best first; people already tried go last.
  // Only people on the ICP's P1/P2/P3 lists (and the main contact): INVECK doesn't want anyone else.
  const team = found.filter((p) => p.isPrimary || contactPriority(p.title, icp ?? undefined) < 99).sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(!!a.passedAt) - Number(!!b.passedAt) || candidateRank(a, icp ?? undefined, lead.city) - candidateRank(b, icp ?? undefined, lead.city),
  );
  const inSequence = lead.status === 'Contacted';

  const hasDraft = !!(lead.emailSubject || lead.emailBody || lead.linkedinMessage);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/leads" className="inline-flex items-center gap-1 text-ink-2 hover:text-ink"><svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3 5 8l5 5" /></svg>Leads</Link>
      </div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{lead.company}</h1>
            <StatusPill status={lead.status} />
          </div>
          <p className="mt-1 text-sm text-ink-2">
            {[lead.segment, lead.city].filter(Boolean).join(' · ')}
            {lead.website && (
              <>
                {' · '}
                <a href={`https://${lead.website}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{lead.website}</a>
              </>
            )}
          </p>
          {lead.source && <p className="mt-1 text-xs text-muted">Source: {lead.source}</p>}
          {bdas.length > 0 && me && !canReassign(me, lead) && (
            <p className="mt-2 text-xs text-muted">Owner: {bdas.find((b) => b.id === lead.ownerId)?.name ?? 'someone else'}. Only they or an administrator can hand this lead over.</p>
          )}
          {bdas.length > 0 && me && canReassign(me, lead) && (
            <form action={assignOwnerAction} className="mt-2 flex items-center gap-2 text-xs">
              <input type="hidden" name="id" value={id} />
              <label htmlFor="ownerId" className="text-muted">Owner</label>
              <select id="ownerId" name="ownerId" defaultValue={lead.ownerId ?? ''} className="field w-auto py-1 text-xs">
                {!lead.ownerId && <option value="">Not assigned yet</option>}
                {bdas.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button className="btn-secondary px-2.5 py-1 text-xs">Change owner</button>
              {lead.inbound && <span className="text-muted">Inbound lead</span>}
            </form>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {lead.status === 'Awaiting Approval' && <StatusButton id={id} action="approve" label="Approve" primary />}
          {(lead.status === 'Approved' || lead.status === 'Awaiting Approval') && <StatusButton id={id} action="sent" label="Mark as sent" />}
          {(lead.status === 'Awaiting Approval' || lead.status === 'Approved') && <StatusButton id={id} action="reject" label="Reject" />}
          {lead.status === 'Contacted' && <StatusButton id={id} action="replied" label="They replied" primary />}
          {(lead.status === 'Contacted' || lead.status === 'Replied') && <StatusButton id={id} action="meeting" label="Meeting booked" />}
          {(lead.status === 'Contacted' || lead.status === 'Replied' || lead.status === 'Meeting Booked') && (
            <>
              <details className="relative">
                <summary className="btn-secondary list-none [&::-webkit-details-marker]:hidden">Won · add as client</summary>
                <form action={addLeadAsClientAction} className="card absolute right-0 z-10 mt-2 w-80 space-y-2 p-4 shadow-lg">
                  <input type="hidden" name="id" value={id} />
                  <p className="text-sm font-medium">Add {lead.company} to current clients?</p>
                  <label htmlFor="whyBought" className="label">Why they bought INVECK (optional)</label>
                  <textarea id="whyBought" name="whyBought" rows={3} className="field" placeholder="e.g. Quarterly stock verification across 4 plants" />
                  <p className="text-xs text-muted">Marks the lead as Won and adds a row to the client sheet, so it&apos;s never prospected again.</p>
                  <SubmitButton pendingText="Adding…">Add as client</SubmitButton>
                </form>
              </details>
              <StatusButton id={id} action="lost" label="Lost" />
            </>
          )}
          {lead.status === 'Won' && (
            <Link href="/targets#clients" className="btn-secondary">View in clients</Link>
          )}
          {!['New', 'Processing', 'Contacted', 'Replied', 'Meeting Booked', 'Won', ...REASSESSABLE].includes(lead.status) && (
            <StatusButton id={id} action="requeue" label="Research again" />
          )}
        </div>
      </div>

      {lead.lastError && (
        <div className="mb-6 rounded-lg border border-line bg-critical-soft px-4 py-3 text-sm text-critical-ink" role="alert">
          <span className="font-medium">Last error:</span> {lead.lastError}
        </div>
      )}

      {lead.status !== 'New' && lead.status !== 'Processing' && lead.status !== 'Existing Client' && (
        <div className="mb-6">
          <AssessmentCard lead={lead} primary={found.find((p) => p.isPrimary && !p.passedAt)} listed={team} canAct={!!me && (me.role === 'admin' || lead.ownerId === me.id)} />
        </div>
      )}

      {team.length > 0 && (
        <div className="mb-6">
          <PeopleCard company={lead.company} city={lead.city} list={team} />
        </div>
      )}

      {inSequence && (
        <div className="mb-6">
          <FollowUpCard lead={lead} />
        </div>
      )}

      <form action={updateLeadAction} className="grid gap-6 lg:grid-cols-5">
        <input type="hidden" name="id" value={id} />

        <div className="space-y-6 lg:col-span-3">
          <Section
            title="Outreach draft"
          >
            {!hasDraft && <p className="mb-3 text-sm text-muted">No draft yet. Drafts are written once the company is a confirmed fit, even before a contact is found.</p>}
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="emailSubject" className="label">Email subject</label>
                  {lead.emailSubject && <CopyButton text={lead.emailSubject} />}
                </div>
                <input id="emailSubject" name="emailSubject" defaultValue={lead.emailSubject} className="field" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="emailBody" className="label">Email body</label>
                  {lead.emailBody && <CopyButton text={lead.emailBody} />}
                </div>
                <textarea id="emailBody" name="emailBody" defaultValue={lead.emailBody} rows={10} className="field font-[inherit] leading-relaxed" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="linkedinMessage" className="label">LinkedIn message (send by hand)</label>
                  {lead.linkedinMessage && <CopyButton text={lead.linkedinMessage} />}
                </div>
                <textarea id="linkedinMessage" name="linkedinMessage" defaultValue={lead.linkedinMessage} rows={3} className="field" />
              </div>
            </div>
          </Section>

          <Section title="Research">
            {lead.researchSummary ? (
              <p className="text-sm leading-relaxed whitespace-pre-line text-ink-2">{lead.researchSummary}</p>
            ) : (
              <p className="text-sm text-muted">Not researched yet.</p>
            )}
          </Section>

          {lead.otherDecisionMakers && (
            <Section title="Other decision-makers & notes">
              <p className="text-sm leading-relaxed whitespace-pre-line text-ink-2">{lead.otherDecisionMakers}</p>
            </Section>
          )}
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Section title="Decision-maker">
            <div className="space-y-3">
              {(
                [
                  ['contactName', 'Name', lead.contactName],
                  ['contactTitle', 'Title', lead.contactTitle],
                  ['contactPhone', 'Phone (if the team found one)', lead.contactPhone],
                  ['contactLinkedin', 'LinkedIn URL', lead.contactLinkedin],
                ] as const
              ).map(([name, label, value]) => (
                <div key={name}>
                  <label htmlFor={name} className="label">{label}</label>
                  <input id={name} name={name} defaultValue={value} className="field" />
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                {lead.contactLinkedin && (
                  <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">Open LinkedIn profile</a>
                )}
              </div>
              {lead.contactName && (
                <p className="text-xs text-muted">
                  {lead.contactCheckedAt
                    ? `Checked on LinkedIn ${formatDate(lead.contactCheckedAt)}${lead.contactLinkedin ? '' : ': no profile found'}. Rechecked automatically every month and whenever the contact changes.`
                    : 'Being checked on LinkedIn automatically (profile and current designation).'}
                </p>
              )}
            </div>
          </Section>

          <Section title="Company">
            <div className="space-y-3">
              <div>
                <label htmlFor="company" className="label">Company</label>
                <input id="company" name="company" defaultValue={lead.company} required className="field" />
              </div>
              <div>
                <label htmlFor="website" className="label">Website</label>
                <input id="website" name="website" defaultValue={lead.website} className="field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="city" className="label">City</label>
                  <input id="city" name="city" defaultValue={lead.city} className="field" />
                </div>
                <div>
                  <label htmlFor="segment" className="label">Segment</label>
                  <select id="segment" name="segment" defaultValue={lead.segment} className="field">
                    {!segments.includes(lead.segment) && <option value={lead.segment}>{lead.segment || '—'}</option>}
                    {segments.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </Section>

          <div className="flex items-center justify-between gap-2">
            <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
            <button formAction={deleteLeadAction} className="btn-danger">Delete lead</button>
          </div>
          <p className="text-xs text-muted">
            A contact you enter here counts as confirmed, and a new person gets the email rewritten for them (unless you edited the draft in the same save).
          </p>
        </div>
      </form>


      <div className="mt-6">
        <Timeline leadId={id} items={timeline} />
      </div>
    </>
  );
}
