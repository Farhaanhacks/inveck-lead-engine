import { AddPointOfContact } from '@/components/add-point-of-contact';
import { PhoneLinks } from '@/components/phone-links';
import { BackLink } from '@/components/nav-history';
import Link from 'next/link';
import { after } from 'next/server';
import { contactPriority, icpFor, tierOf, type Tier } from '@/lib/tiers';
import { TierBadge } from '@/components/tier-badge';
import { basedAbroad } from '@/lib/pipeline/employer';
import { candidateRank } from '@/lib/pipeline/contacts';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, gt, or } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { activities, icps, leads, people, tasks, whatsappMessages, type Lead, type Task, type Person, type WhatsappContact, type WhatsappMessage } from '@/lib/db/schema';
import { Timeline } from '@/components/timeline';
import { istDay } from '@/lib/tasks';
import { formatDate, formatDateTime } from '@/lib/dates';
import { SendWhatsApp } from '@/components/send-whatsapp';
import { inboundDetailsFor, sourceDetails } from '@/lib/inbound-demo';
import { latestMeeting } from '@/lib/meetings';
import { waNumber } from '@/lib/phones';
import { getSettings, type Settings } from '@/lib/settings';
import { waConfig } from '@/lib/whatsapp/cloud';
import { canMessage, CONSENT_WAYS, planWhatsApp, waContacts } from '@/lib/whatsapp/contacts';
import { setWhatsAppConsentAction } from '../../../whatsapp-actions';
import { StatusPill } from '@/components/status-pill';
import { CopyButton } from '@/components/copy-button';
import { SubmitButton } from '@/components/submit-button';
import { getCurrentUser, listBdas } from '@/lib/users';
import { canReassign } from '@/lib/assign';
import { assignOwnerAction } from '../../../team-actions';
import { tidyContacts } from '@/lib/verify-contacts';
import { fillMissingDrafts, redraftForContact } from '@/lib/pipeline/redraft';
import { liveServices } from '@/lib/run-driver';
import { contactAvailability, contactGeography, evidenceLabel, evidenceSource, evidenceTone, fitAssessment, isCorporateContact, riskAssessment, TONE_CLASS, type Assessment } from '@/lib/fit-view';
import { KIND_LABEL } from '@/lib/pipeline/fit';
import { REASSESSABLE } from '@/lib/reassess';
import {
  addLeadAsClientAction,
  confirmFitAction,
  makePrimaryAction,
  markLeftAction,
  markNotFitAction,
  deleteLeadAction,
  reassessFitAction,
  restoreLeadAction,
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

function FollowUpCard({ lead, rounds }: { lead: Lead; rounds: Task[] }) {
  const numbers = [1, 2, 3, 4, 5];
  const stateOf = (n: number) => {
    const mine = rounds.filter((t) => t.followUpRound === n);
    if (!mine.length) return { label: 'Not planned', tone: 'text-muted', due: '' };
    const due = mine.map((t) => t.dueDate).sort()[0];
    if (mine.every((t) => t.doneAt && t.outcome !== 'closed')) return { label: 'Done', tone: 'text-good-ink', due };
    if (mine.some((t) => t.outcome === 'closed')) return { label: 'Cancelled', tone: 'text-muted', due };
    const done = mine.filter((t) => t.doneAt).length;
    return { label: `${done} of ${mine.length} steps done`, tone: due < istDay() ? 'text-warning-ink' : 'text-ink-2', due };
  };
  const nextEmail = rounds.filter((t) => t.kind === 'email' && !t.doneAt).sort((a, b) => a.followUpRound - b.followUpRound)[0];
  const open = lead.status !== 'Deleted' && !!nextEmail;
  return (
    <Section title="Follow-up sequence" aside={<span className="rounded-full bg-neutral-soft px-2 py-0.5 text-xs font-medium text-ink-2">Day 1: {formatDate(new Date(`${lead.followUpStartedOn}T12:00:00+05:30`))}</span>}>
      <p className="mb-3 text-xs text-muted">Five follow-ups, every other working day after the call that started it (weekends and holidays skipped). A connected call stops it; after Follow-up 5 the lead moves to Deleted.</p>
      <ul className="divide-y divide-line text-sm">
        {numbers.map((n) => {
          const s = stateOf(n);
          return (
            <li key={n} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-medium">Follow-up {n}</span>
              <span className="text-xs text-ink-2">{s.due ? formatDate(new Date(`${s.due}T12:00:00+05:30`)) : ''}</span>
              <span className={`text-xs font-medium ${s.tone}`}>{s.label}</span>
            </li>
          );
        })}
      </ul>
      {open && lead.followUpBody ? (
        <form action={sendFollowUpAction} className="mt-4 space-y-3 border-t border-line pt-4">
          <input type="hidden" name="id" value={lead.id} />
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="followUpSubject" className="label">Follow-up {nextEmail.followUpRound} subject</label>
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
            <SubmitButton pendingText="Saving…">Mark follow-up {nextEmail.followUpRound} as sent</SubmitButton>
            <button name="skip" value="1" className="btn-secondary">Skip</button>
          </div>
          <p className="text-xs text-muted">Nothing is sent from here: send it from your own mailbox, then mark it as sent.</p>
        </form>
      ) : open ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-sm text-ink-2">The AI writes the next follow-up email with the next research run, or now if you prefer.</p>
          <form action={writeFollowUpAction}>
            <input type="hidden" name="id" value={lead.id} />
            <SubmitButton className="btn-secondary" pendingText="Writing…">Write it now</SubmitButton>
          </form>
        </div>
      ) : null}
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
            {lead.status === 'Disqualified' && lead.fitStatus === 'review' && !segmentProblem && (
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

/** Evidence lines that only say the team entered someone: not shown. */
const TEAM_EVIDENCE = /^(added by the team|entered by the team|on the team's researched list)$/i;

function PeopleCard({ leadId, company, city, list, tierFor, mainTier }: { leadId: number; company: string; city: string; list: Person[]; tierFor: (title: string) => Tier; mainTier?: Tier }) {
  // People found at the company who aren't contacts for this site aren't shown.
  const contacts = list.filter((p) => p.passedReason !== 'excluded');
  const row = (p: Person) => (
              <tr key={p.id} className="border-t border-line align-top">
                <td className="px-5 py-2.5">
                  <div className="font-medium">
                    {p.name}
                    <TierBadge tier={p.isPrimary && mainTier ? mainTier : (['P1', 'P2', 'P3'].includes(p.tier) ? (p.tier as Tier) : tierFor(p.title))} />
                    {p.isPrimary && !p.passedAt && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Main contact</span>}
                    {p.passedAt && (
                      <span className="ml-2 text-xs font-normal text-muted">
                        {isCorporateContact(p)
                          ? 'corporate contact, for review'
                          : p.passedReason === 'excluded'
                            ? 'not a contact for this site'
                            : p.passedReason === 'unverified' || (p.passedReason === '' && p.isPrimary)
                              ? 'not confirmed on LinkedIn yet, checked again weekly'
                              : 'tried, no luck'}
                      </span>
                    )}
                  </div>
                  <div className="max-w-[16rem] truncate text-xs text-muted" title={p.title}>{p.title || '—'}</div>
                  {(p.location || city) && (
                    <div className="max-w-[16rem] truncate text-xs text-muted" title={p.location}>{p.location ? `Profile: ${p.location}` : 'Profile location not shown'}</div>
                  )}
                  {p.jobLocation && <div className="max-w-[16rem] truncate text-xs text-muted" title={p.jobLocation}>Job here: {p.jobLocation}</div>}
                  {(p.phone || p.email) && (
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
                      <PhoneLinks value={p.phone} />
                      {p.email && <a href={`mailto:${p.email}`} className="text-accent hover:underline">{p.email}</a>}
                    </div>
                  )}
                  {p.responsibility && <div className="max-w-[16rem] truncate text-xs text-muted">Responsible for: {p.responsibility}</div>}
                  {p.evidence && !TEAM_EVIDENCE.test(p.evidence) && <div className="mt-1 max-w-[22rem] text-xs text-ink-2">Evidence: {p.evidence}</div>}
                  {p.passedAt && p.whyNot && <div className="mt-1 max-w-[22rem] text-xs text-ink-2">Not the main contact: {p.whyNot}</div>}
                </td>
                <td className="px-2 py-2.5">
                  {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noreferrer" className="whitespace-nowrap text-accent hover:underline">LinkedIn</a> : <span className="text-muted">—</span>}
                </td>
                <td className="px-5 py-2.5 text-right">
                  <div className="flex flex-col items-end gap-1.5">
                    {(!p.isPrimary || p.passedAt) && (
                      <form action={makePrimaryAction}>
                        <input type="hidden" name="id" value={p.leadId} />
                        <input type="hidden" name="personId" value={p.id} />
                        <SubmitButton className="btn-secondary h-7 px-2 py-0.5 text-xs" pendingText="…">Make main contact</SubmitButton>
                      </form>
                    )}
                    <form action={markLeftAction}>
                      <input type="hidden" name="id" value={p.leadId} />
                      <input type="hidden" name="personId" value={p.id} />
                      <SubmitButton
                        className="btn-secondary h-7 px-2 py-0.5 text-xs"
                        pendingText="…"
                        title="Use only if you know this person no longer works here: they are removed from this lead"
                        confirmText={`Mark ${p.name} as no longer working at ${company}? They will be removed from this lead${p.isPrimary ? ' and the next confirmed person becomes the main contact' : ''}.`}
                      >
                        Mark as left
                      </SubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
  );
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5 pb-3">
        <div>
          <h2 className="text-sm font-semibold">People to contact at {company}</h2>
          <p className="text-xs text-muted">Best first: plant heads, then other operations heads, then process owners. Only people a LinkedIn profile confirms at this company now. The main contact&apos;s job must be at this site: the site their title names, else where their current job is, else their profile location.</p>
        </div>
        <span className="text-xs text-muted">{contacts.length} found</span>
      </div>
      {contacts.length > 0 && (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="px-5 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">LinkedIn</th>
              <th className="px-5 py-2"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
        <tbody>{contacts.map(row)}</tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
        Making someone the main contact rewrites the email for them; the calls and messages on Today go to them from then on.
      </p>
      <div className="px-5 pb-4">
        <AddPointOfContact leadId={leadId} company={company} />
      </div>
    </section>
  );
}

// Research started from this page keeps working after the response.
const WA_STATUS: Record<string, string> = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered' };

/**
 * WhatsApp with the contact from INVECK's business number: whether they agreed to hear from INVECK
 * (and how), the conversation, and sending: the approved template, or free text within 24 hours of
 * their last message.
 */
function WhatsAppCard({
  lead,
  to,
  contact,
  messages,
  names,
  canAct,
  ready,
  settings,
  sender,
}: {
  lead: Lead;
  to: string;
  contact?: WhatsappContact;
  messages: WhatsappMessage[];
  names: Map<number, string>;
  canAct: boolean;
  ready: boolean;
  settings: Settings;
  sender: string;
}) {
  const agreed = canMessage(contact);
  const plan = ready && to ? planWhatsApp(lead, sender, settings, contact) : null;
  const who = (id: number | null) => (id == null ? '' : (names.get(id) ?? 'a team member'));
  return (
    <section id="whatsapp" className="card scroll-mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">WhatsApp</h2>
        <span className="text-xs text-muted">{to ? `+${to}` : 'No number saved for the contact'}</span>
      </div>
      {to && (
        <p className="mt-2 text-sm text-ink-2">
          {contact?.optedOutAt
            ? `Asked not to get WhatsApp messages from INVECK on ${formatDate(contact.optedOutAt)}. Nothing goes to this number unless they agree again.`
            : agreed && contact?.consentAt
              ? `Agreed to WhatsApp messages from INVECK on ${formatDate(contact.consentAt)}: ${(contact.consentHow || 'how not recorded').replace(/^\w/, (ch) => ch.toLowerCase())}${contact.consentBy != null ? `, logged by ${who(contact.consentBy)}` : ''}.`
              : "Hasn't agreed to WhatsApp messages from INVECK yet. Until they do, message them only from your own phone (Open WhatsApp on Today)."}
        </p>
      )}
      {canAct && to && !agreed && (
        <form action={setWhatsAppConsentAction} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="leadId" value={lead.id} />
          <input type="hidden" name="agree" value="1" />
          <div>
            <label htmlFor="wa-how" className="label">How they agreed</label>
            <select id="wa-how" name="how" defaultValue="On a call" className="field h-8 w-auto py-1 text-xs">
              {CONSENT_WAYS.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
          <SubmitButton pendingText="Saving…" className="btn-secondary px-2.5 py-1 text-xs">They agreed to WhatsApp from INVECK</SubmitButton>
          <p className="basis-full text-xs text-muted">Only when they said yes to hearing from INVECK. A number found online or in a directory isn&apos;t agreement.</p>
        </form>
      )}
      {canAct && agreed && contact?.consentBy != null && (
        <form action={setWhatsAppConsentAction} className="mt-1">
          <input type="hidden" name="leadId" value={lead.id} />
          <input type="hidden" name="agree" value="0" />
          <button className="text-xs text-muted hover:text-ink hover:underline">Remove (logged by mistake)</button>
        </form>
      )}
      {messages.length > 0 && (
        <ul className="mt-4 space-y-2">
          {messages.map((m) => (
            <li key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.direction === 'out' ? 'bg-accent-soft' : 'bg-surface-2'}`}>
                <p className="whitespace-pre-line">{m.body}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {formatDateTime(m.at)} · {m.direction === 'out' ? `${WA_STATUS[m.status] ?? m.status}${m.userId != null ? ` · ${who(m.userId)}` : ''}` : contact?.profileName || 'Received'}
                </p>
                {m.status === 'failed' && m.error && <p className="text-[11px] text-critical-ink">{m.error}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canAct && agreed && !ready && <p className="mt-3 text-xs text-muted">Sending from INVECK&apos;s WhatsApp number isn&apos;t set up yet.</p>}
      {canAct && plan && (
        <div className="mt-4">
          {plan.problem ? (
            agreed && <p className="text-xs text-warning-ink">{plan.problem}</p>
          ) : (
            <SendWhatsApp leadId={lead.id} to={`+${plan.to}`} template={plan.template} text={plan.freeUntil ? '' : plan.text} freeUntil={plan.freeUntil ? `until ${formatDateTime(plan.freeUntil)}` : undefined} />
          )}
        </div>
      )}
    </section>
  );
}

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
  const icp = icpFor(lead, segmentRows);
  // Main contact first, then everyone else best first; people set aside after them, and people found
  // at the company who aren't contacts for this site last (shown with the reason, never contacted).
  // Only people INVECK contacts: on the ICP's lists (never directors, HR, admin or IT) and based in
  // India. People the team entered are always shown.
  const team = found
    .filter(
      (p) =>
        p.source === 'Sales team' ||
        p.source === 'Added by the team' ||
        (contactPriority(p.title, icp ?? undefined) < 99 && !(p.location && basedAbroad(p.location, '', p.linkedin))),
    )
    .sort(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) ||
      Number(!!a.passedAt) - Number(!!b.passedAt) ||
      Number(a.passedReason === 'excluded') - Number(b.passedReason === 'excluded') ||
      Number(isCorporateContact(b)) - Number(isCorporateContact(a)) ||
      candidateRank(a, icp ?? undefined, lead.city) - candidateRank(b, icp ?? undefined, lead.city),
  );
  // An inbound demo request from the website form: what the sheet said (source, answers, campaign) and its Teams meeting.
  const demo = (await inboundDetailsFor(db, [id])).get(id);
  const meeting = demo ? await latestMeeting(db, id) : null;
  const inSequence = !!lead.followUpStartedOn;
  const rounds = inSequence ? await db.select().from(tasks).where(and(eq(tasks.leadId, id), gt(tasks.followUpRound, 0))).orderBy(asc(tasks.followUpRound), asc(tasks.id)) : [];
  // WhatsApp with the contact: shown once there is a number, or messages.
  const waTo = waNumber(lead.contactPhone);
  const [waKnown, waMessages] = await Promise.all([
    waContacts(db, [waTo]),
    db
      .select()
      .from(whatsappMessages)
      .where(waTo ? or(eq(whatsappMessages.leadId, id), eq(whatsappMessages.waId, waTo)) : eq(whatsappMessages.leadId, id))
      .orderBy(desc(whatsappMessages.at), desc(whatsappMessages.id))
      .limit(50),
  ]);
  const waReady = !!waConfig();
  const waSettings = waReady ? await getSettings(db) : null;
  const names = new Map(bdas.map((b) => [b.id, b.name]));
  if (me) names.set(me.id, me.name);
  const canAct = !!me && (me.role === 'admin' || lead.ownerId === me.id);
  // Signed with the owner's name, also when an administrator sends.
  const sender = (me?.role === 'admin' && lead.ownerId ? names.get(lead.ownerId) : me?.name) ?? '';

  const hasDraft = !!(lead.emailSubject || lead.emailBody || lead.linkedinMessage);

  return (
    <>
      <div className="mb-2 text-sm">
        <BackLink />
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
          {lead.nameAsFound && lead.nameAsFound !== lead.company && (
            <p className="mt-1 text-xs text-muted">
              Name corrected from &ldquo;{lead.nameAsFound}&rdquo;{lead.nameEvidence ? `: ${lead.nameEvidence}` : ''}
            </p>
          )}
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
          {lead.status === 'Approved' && <StatusButton id={id} action="sent" label="Mark as sent" />}
          {lead.status === 'Approved' && <StatusButton id={id} action="reject" label="Reject" />}
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
          {lead.status === 'Deleted' && (
            <form action={restoreLeadAction}>
              <input type="hidden" name="id" value={id} />
              <SubmitButton className="btn-primary" pendingText="Restoring…">Restore lead</SubmitButton>
            </form>
          )}
          {!['New', 'Processing', 'Contacted', 'Replied', 'Meeting Booked', 'Won', 'Deleted', ...REASSESSABLE].includes(lead.status) && (
            <StatusButton id={id} action="requeue" label="Research again" />
          )}
        </div>
      </div>

      {lead.status === 'Deleted' && (
        <div className="mb-6 rounded-lg border border-line bg-neutral-soft px-4 py-3 text-sm text-ink-2" role="status">
          <span className="font-medium">Deleted{lead.deletedAt ? ` on ${formatDate(lead.deletedAt)}` : ''}.</span> {lead.deletedReason} Its timeline, calls and research are kept; restore it to work it again.
        </div>
      )}

      {demo && (
        <section className="card mb-6 p-5" aria-label="Inbound demo request">
          <h2 className="text-sm font-semibold">Inbound demo request</h2>
          <p className="mt-0.5 text-xs text-muted">From the website demo form (Google Sheet). Not a cold prospect: nothing here was researched.</p>
          {meeting ? (
            <p className="mt-2 text-sm">
              Teams meeting: <span className="font-medium">{meeting.title}</span> on{' '}
              {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(meeting.startsAt)} IST.{' '}
              {meeting.joinUrl.startsWith('https://') && <a href={meeting.joinUrl} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">Join meeting</a>}
            </p>
          ) : (
            <p className="mt-2 text-sm text-warning-ink">No meeting booked yet{demo.reason ? `: ${demo.reason}` : '.'}</p>
          )}
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {sourceDetails(demo.raw).map((d) => (
              <div key={d.label} className="min-w-0">
                <dt className="text-xs text-muted">{d.label}</dt>
                <dd className="break-words">{d.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

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

      {/* Always shown, so a point of contact can be added even before anyone is found. */}
      {(
        <div className="mb-6">
          <PeopleCard leadId={lead.id} company={lead.company} city={lead.city} list={team} tierFor={(title) => tierOf(title, icp ?? undefined)} mainTier={(['P1', 'P2', 'P3'].includes(lead.contactTier) ? lead.contactTier : undefined) as Tier | undefined} />
        </div>
      )}

      {inSequence && (
        <div className="mb-6">
          <FollowUpCard lead={lead} rounds={rounds} />
        </div>
      )}

      {(waTo || waMessages.length > 0) && (
        <div className="mb-6">
          <WhatsAppCard
            lead={lead}
            to={waTo}
            contact={waKnown.get(waTo)}
            messages={[...waMessages].reverse()}
            names={names}
            canAct={canAct}
            ready={!!waSettings}
            settings={waSettings ?? ({} as Settings)}
            sender={sender}
          />
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
