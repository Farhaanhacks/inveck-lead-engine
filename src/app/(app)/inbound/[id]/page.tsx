import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { adminPage } from '@/lib/access';
import { getDb } from '@/lib/db';
import { activities } from '@/lib/db/schema';
import { formatDate, formatDateTime } from '@/lib/dates';
import { INBOUND_STATUSES, loadInbound, RESPONSE_KINDS, RESPONSE_LABEL, SOURCE_LABEL, statusLabel } from '@/lib/inbound-leads';
import { sourceDetails } from '@/lib/inbound-demo';
import { logInboundActivityAction, setInboundStatusAction } from '@/app/inbound-actions';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { response: 'Response', follow_up_sent: 'Follow-up sent', note: 'Note', stage: 'Status', added: 'Added', contact: 'Contact', meeting: 'Meeting', call: 'Call', error: 'Error' };

/** One inbound lead: who they are, what the sheet said, the meeting, and the response and follow-up history. */
export default async function InboundLeadPage({ params }: PageProps<'/inbound/[id]'>) {
  await adminPage();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = await getDb();
  const r = (await loadInbound(db)).find((x) => x.id === id);
  if (!r) notFound();
  const history = await db.select().from(activities).where(eq(activities.leadId, id)).orderBy(desc(activities.at), desc(activities.id));
  const l = r.lead;

  return (
    <>
      <PageHeader title={l.company} description={`Inbound demo request from ${l.contactName || 'the website form'}${l.city ? `, ${l.city}` : ''}.`}>
        <Link href="/inbound" className="btn-secondary">Back to Inbound leads</Link>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Lead</h2>
            <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted">Contact</dt><dd>{l.contactName || '—'}</dd></div>
              <div><dt className="text-xs text-muted">Email</dt><dd>{l.contactEmail ? <a href={`mailto:${l.contactEmail}`} className="text-accent hover:underline">{l.contactEmail}</a> : '—'}</dd></div>
              <div><dt className="text-xs text-muted">Phone</dt><dd>{l.contactPhone || '—'}</dd></div>
              <div><dt className="text-xs text-muted">Assigned BDA</dt><dd>{r.bda || 'Unassigned'}</dd></div>
              <div><dt className="text-xs text-muted">Source</dt><dd>{SOURCE_LABEL[r.source]}</dd></div>
              <div><dt className="text-xs text-muted">Registered</dt><dd>{formatDateTime(r.registeredAt)}</dd></div>
              <div><dt className="text-xs text-muted">Status</dt><dd><StatusPill status={statusLabel(r)} /></dd></div>
              <div><dt className="text-xs text-muted">Segment</dt><dd>{l.segment || '—'}</dd></div>
            </dl>
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold">Meeting</h2>
            {r.meeting ? (
              <div className="mt-2 text-sm">
                <p><span className="font-medium">{r.meeting.title}</span></p>
                <p className="text-ink-2">{formatDateTime(r.meeting.startsAt)} IST · organised by {r.meeting.organizerEmail}</p>
                {r.meeting.joinUrl.startsWith('https://') && <a href={r.meeting.joinUrl} target="_blank" rel="noreferrer" className="btn-primary mt-3 inline-flex">Join meeting</a>}
              </div>
            ) : (
              <p className="mt-2 text-sm text-warning-ink">No Teams meeting booked yet. It is created at the next sync once the sheet has a chosen slot and the BDA&apos;s Outlook is connected.</p>
            )}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold">Response and follow-up history</h2>
            <form action={logInboundActivityAction} className="mt-3 space-y-2">
              <input type="hidden" name="id" value={id} />
              <div className="flex flex-wrap gap-2">
                <label htmlFor="act-kind" className="sr-only">What happened</label>
                <select id="act-kind" name="kind" defaultValue="response" className="field w-auto">
                  {RESPONSE_KINDS.map((k) => <option key={k} value={k}>{RESPONSE_LABEL[k]}</option>)}
                </select>
              </div>
              <label htmlFor="act-text" className="sr-only">Details</label>
              <textarea id="act-text" name="text" rows={3} required maxLength={2000} placeholder="What they said, or what was sent" className="field" />
              <button className="btn-primary">Add to history</button>
            </form>
            <ul className="mt-4 divide-y divide-line text-sm">
              {history.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="flex items-center gap-2 text-xs text-muted"><span className="font-medium text-ink-2">{KIND_LABEL[a.kind] ?? a.kind}</span><span>{formatDateTime(a.at)}</span></div>
                  <p className="whitespace-pre-line">{a.text}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Update status</h2>
            <p className="mt-1 text-xs text-muted">Meeting scheduled is set only by a real Teams meeting.</p>
            <form action={setInboundStatusAction} className="mt-3 flex gap-2">
              <input type="hidden" name="id" value={id} />
              <label htmlFor="st" className="sr-only">Status</label>
              <select id="st" name="status" defaultValue={(INBOUND_STATUSES as readonly string[]).includes(l.status) ? l.status : 'Replied'} className="field flex-1">
                {INBOUND_STATUSES.map((s) => <option key={s} value={s}>{s === 'Replied' ? 'Replied (awaiting meeting)' : s}</option>)}
              </select>
              <button className="btn-secondary">Save</button>
            </form>
          </section>
          <section className="card p-5">
            <h2 className="text-sm font-semibold">What the sheet said</h2>
            <p className="mt-1 text-xs text-muted">Kept exactly as submitted, including the source and UTM values the Website / LinkedIn label comes from.</p>
            <dl className="mt-3 space-y-2 text-sm">
              {sourceDetails(r.raw).map((d) => (
                <div key={d.label}><dt className="text-xs text-muted">{d.label}</dt><dd className="break-words">{d.value}</dd></div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">Imported {formatDate(r.registeredAt)}.</p>
          </section>
        </div>
      </div>
    </>
  );
}
