import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { activities, icps, leads, people, type Lead, type Person } from '@/lib/db/schema';
import { Timeline } from '@/components/timeline';
import { FOLLOW_UP_DAYS } from '@/lib/pipeline/follow-ups';
import { SIGNAL_LABELS } from '@/lib/pipeline/signals';
import { formatDate, isPast, relativeDays } from '@/lib/dates';
import { StatusPill } from '@/components/status-pill';
import { CopyButton } from '@/components/copy-button';
import { SubmitButton } from '@/components/submit-button';
import { getCurrentUser, listBdas } from '@/lib/users';
import { canReassign } from '@/lib/assign';
import { assignOwnerAction, findLinkedinAction } from '../../../team-actions';
import {
  addLeadAsClientAction,
  makePrimaryAction,
  deleteLeadAction,
  refreshSignalsAction,
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
  const mailto = lead.contactEmail && lead.followUpBody
    ? `mailto:${lead.contactEmail}?subject=${encodeURIComponent(lead.followUpSubject)}&body=${encodeURIComponent(lead.followUpBody)}`
    : '';
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
            {mailto && <a href={mailto} className="btn-secondary">Open in email app</a>}
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

function SignalsCard({ lead }: { lead: Lead }) {
  return (
    <Section
      title="Buying signals"
      aside={
        <form action={refreshSignalsAction}>
          <input type="hidden" name="id" value={lead.id} />
          <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingText="Checking…">
            {lead.signalsCheckedAt ? 'Check again' : 'Check news'}
          </SubmitButton>
        </form>
      }
    >
      {lead.signals.length ? (
        <ul className="space-y-2.5">
          {lead.signals.map((s) => (
            <li key={s.url} className="border-l-2 border-warning-ink/40 pl-3 text-sm">
              <span>
                <a href={s.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">{s.headline}</a>
                <span className="block text-xs text-muted">
                  {[SIGNAL_LABELS[s.kind] ?? 'News', s.source, s.date].filter(Boolean).join(' · ')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {lead.signalsCheckedAt
            ? `No recent expansion, acquisition, funding or audit news (checked ${relativeDays(lead.signalsCheckedAt)}).`
            : 'Not checked yet. News is checked when a qualified lead is researched.'}
        </p>
      )}
    </Section>
  );
}

function PeopleCard({ company, list }: { company: string; list: Person[] }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5 pb-3">
        <h2 className="text-sm font-semibold">People at {company}</h2>
        <span className="text-xs text-muted">{list.length} found · {list.filter((p) => p.email).length} with email</span>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Email</th>
              <th className="px-2 py-2 font-medium">Phone</th>
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
                    {p.isPrimary && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Main contact</span>}
                  </div>
                  <div className="max-w-[16rem] truncate text-xs text-muted" title={p.title}>{p.title || '—'}</div>
                </td>
                <td className="px-2 py-2.5">
                  {p.email ? <a href={`mailto:${p.email}`} className="hover:underline">{p.email}</a> : <span className="text-muted">—</span>}
                  {p.emailStatus && <div className="max-w-[16rem] truncate text-xs text-muted" title={p.emailStatus}>{p.emailStatus}</div>}
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap">{p.phone || <span className="text-muted">—</span>}</td>
                <td className="px-2 py-2.5">
                  {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noreferrer" className="whitespace-nowrap text-accent hover:underline">LinkedIn</a> : <span className="text-muted">—</span>}
                </td>
                <td className="px-2 py-2.5 text-xs text-ink-2">{p.source}</td>
                <td className="px-5 py-2.5 text-right">
                  {!p.isPrimary && (
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
        Changing the main contact keeps the draft as it is: edit the greeting, or click “Research again” to redraft for them.
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
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  const bdas = await listBdas(db);
  const me = await getCurrentUser();
  if (me?.role === 'bda' && lead.ownerId !== me.id) notFound();
  if (!lead) notFound();
  const [segmentRows, timeline, team] = await Promise.all([
    db.select({ segment: icps.segment }).from(icps),
    db.select().from(activities).where(eq(activities.leadId, id)).orderBy(desc(activities.at), desc(activities.id)),
    db.select().from(people).where(eq(people.leadId, id)).orderBy(desc(people.isPrimary), asc(people.id)),
  ]);
  const segments = segmentRows.map((s) => s.segment);
  const inSequence = lead.status === 'Contacted';

  const mailto = lead.contactEmail
    ? `mailto:${lead.contactEmail}?subject=${encodeURIComponent(lead.emailSubject)}&body=${encodeURIComponent(lead.emailBody)}`
    : '';
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
          {!['New', 'Processing', 'Contacted', 'Replied', 'Meeting Booked', 'Won'].includes(lead.status) && (
            <StatusButton id={id} action="requeue" label="Research again" />
          )}
        </div>
      </div>

      {lead.lastError && (
        <div className="mb-6 rounded-lg border border-line bg-critical-soft px-4 py-3 text-sm text-critical-ink" role="alert">
          <span className="font-medium">Last error:</span> {lead.lastError}
        </div>
      )}

      {(inSequence || lead.signals.length > 0 || lead.qualified) && (
        <div className="mb-6 grid gap-6 lg:grid-cols-5">
          {inSequence && (
            <div className="lg:col-span-3">
              <FollowUpCard lead={lead} />
            </div>
          )}
          <div className={inSequence ? 'lg:col-span-2' : 'lg:col-span-5'}>
            <SignalsCard lead={lead} />
          </div>
        </div>
      )}

      <form action={updateLeadAction} className="grid gap-6 lg:grid-cols-5">
        <input type="hidden" name="id" value={id} />

        <div className="space-y-6 lg:col-span-3">
          <Section
            title="Outreach draft"
            aside={
              mailto && (
                <a href={mailto} className="btn-secondary px-2.5 py-1 text-xs">Open in email app</a>
              )
            }
          >
            {!hasDraft && <p className="mb-3 text-sm text-muted">No draft yet. Drafts are written for qualified leads with a reachable decision-maker.</p>}
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
          <Section title="Fit">
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Score</dt>
                <dd className="text-2xl font-semibold tabular-nums">{lead.finalScore ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">ICP fit</dt>
                <dd className="text-2xl font-semibold tabular-nums">{lead.fitScore ?? '—'}<span className="text-sm text-muted">/10</span></dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Qualified</dt>
                <dd className="text-2xl font-semibold">{lead.qualified === null ? '—' : lead.qualified ? 'Yes' : 'No'}</dd>
              </div>
            </dl>
            {lead.fitReason && <p className="mt-3 text-sm text-ink-2">{lead.fitReason}</p>}
            {lead.scoreBreakdown && <p className="mt-2 text-xs text-muted">{lead.scoreBreakdown}</p>}
          </Section>

          <Section title="Decision-maker">
            <div className="space-y-3">
              {(
                [
                  ['contactName', 'Name', lead.contactName],
                  ['contactTitle', 'Title', lead.contactTitle],
                  ['contactEmail', 'Email', lead.contactEmail],
                  ['contactPhone', 'Direct phone', lead.contactPhone],
                  ['companyPhone', 'Office phone (HQ)', lead.companyPhone],
                  ['contactLinkedin', 'LinkedIn URL', lead.contactLinkedin],
                ] as const
              ).map(([name, label, value]) => (
                <div key={name}>
                  <label htmlFor={name} className="label">{label}</label>
                  <input id={name} name={name} defaultValue={value} className="field" />
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                {lead.emailStatus && <span>Email: {lead.emailStatus}</span>}
                {lead.contactLinkedin && (
                  <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">Open LinkedIn profile</a>
                )}
                {lead.contactName && (
                  <button formAction={findLinkedinAction} formNoValidate className="btn-secondary px-2.5 py-1 text-xs">
                    Check {lead.contactName.split(' ')[0]} on LinkedIn
                  </button>
                )}
              </div>
              <p className="text-xs text-muted">Checks the current designation on LinkedIn and corrects it here if it has changed. Save your edits first.</p>
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
            Edited the contact? Save, then “Research again” to redo the email search and draft with it.
          </p>
        </div>
      </form>

      {team.length > 0 && (
        <div className="mt-6">
          <PeopleCard company={lead.company} list={team} />
        </div>
      )}

      <div className="mt-6">
        <Timeline leadId={id} items={timeline} />
      </div>
    </>
  );
}
