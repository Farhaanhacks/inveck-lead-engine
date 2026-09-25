import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { icps, leads } from '@/lib/db/schema';
import { StatusPill } from '@/components/status-pill';
import { CopyButton } from '@/components/copy-button';
import { SubmitButton } from '@/components/submit-button';
import { deleteLeadAction, setLeadStatusAction, updateLeadAction } from '../../../actions';

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

export default async function LeadPage({ params }: PageProps<'/leads/[id]'>) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) notFound();
  const segments = (await db.select({ segment: icps.segment }).from(icps)).map((s) => s.segment);

  const mailto = lead.contactEmail
    ? `mailto:${lead.contactEmail}?subject=${encodeURIComponent(lead.emailSubject)}&body=${encodeURIComponent(lead.emailBody)}`
    : '';
  const hasDraft = !!(lead.emailSubject || lead.emailBody || lead.linkedinMessage);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/leads" className="text-ink-2 hover:text-ink">← Leads</Link>
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
        </div>
        <div className="flex flex-wrap gap-2">
          {lead.status === 'Awaiting Approval' && <StatusButton id={id} action="approve" label="Approve" primary />}
          {(lead.status === 'Approved' || lead.status === 'Awaiting Approval') && <StatusButton id={id} action="sent" label="Mark as sent" />}
          {(lead.status === 'Awaiting Approval' || lead.status === 'Approved') && <StatusButton id={id} action="reject" label="Reject" />}
          {lead.status !== 'New' && lead.status !== 'Processing' && <StatusButton id={id} action="requeue" label="Research again" />}
        </div>
      </div>

      {lead.lastError && (
        <div className="mb-6 rounded-lg border border-line bg-critical-soft px-4 py-3 text-sm text-critical-ink" role="alert">
          <span className="font-medium">Last error:</span> {lead.lastError}
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
                  ['contactPhone', 'Phone', lead.contactPhone],
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
              </div>
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
    </>
  );
}
