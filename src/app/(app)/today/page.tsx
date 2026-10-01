import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { leads, type Lead, type Task } from '@/lib/db/schema';
import { getCurrentUser, listBdas } from '@/lib/users';
import { assignUnowned } from '@/lib/assign';
import { getAttendance } from '@/lib/attendance';
import {
  DAILY_CA_CONNECTED_CALLS,
  DAILY_CONNECTED_CALLS,
  DAILY_LINKEDIN_LIMIT,
  dayCounts,
  ensureSequences,
  istDay,
  loadDoneToday,
  loadTodayTasks,
  unattendedInbound,
  UNATTENDED_AFTER_HOURS,
  type TodayTask,
} from '@/lib/tasks';
import { callOpener, discoveryQuestions, linkedinNote, whatsappIntro, whatsappLink } from '@/lib/talk';
import { formatDate, formatTime, relativeDays } from '@/lib/dates';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { CALL_FEEDBACK } from '@/lib/tracker';
import { CopyButton } from '@/components/copy-button';
import { clockInAction, clockOutAction, completeTaskAction, resetTodayLogAction, undoTaskAction } from '../../team-actions';

const SMALL = 'btn-secondary px-2.5 py-1 text-xs';

const OUTCOME_LABEL: Record<string, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy or voicemail',
  wrong_number: 'Wrong number',
  sent: 'Sent',
  done: 'Sent',
  skipped: 'Skipped',
};

function Counter({ label, done, goal }: { label: string; done: number; goal?: number }) {
  const pct = goal ? Math.min(100, Math.round((done / goal) * 100)) : 0;
  return (
    <div className="card p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {done}
        {goal ? <span className="text-sm font-normal text-muted"> / {goal}</span> : null}
      </div>
      {goal ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${pct}% of the daily target`}>
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function Who({ lead, task }: { lead: Lead; task: Task }) {
  return (
    <div className="min-w-0">
      <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">{lead.company}</Link>
      <div className="text-sm text-ink-2">
        {lead.contactName}
        {lead.contactTitle ? <span className="text-muted">, {lead.contactTitle}</span> : null}
      </div>
      <div className="mt-0.5 text-xs text-muted">
        {task.step}
        {task.slot !== 'day' && !task.step.toLowerCase().includes(task.slot) ? ` · ${task.slot}` : ''}
      </div>
    </div>
  );
}

function Reach({ lead }: { lead: Lead }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {lead.contactPhone ? (
        <a href={`tel:${lead.contactPhone.replace(/[^\d+]/g, '')}`} className="text-accent hover:underline">{lead.contactPhone}</a>
      ) : (
        <span className="text-warning-ink">No number yet. Find it with ContactOut from the LinkedIn profile.</span>
      )}
      {lead.contactLinkedin && <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn profile</a>}
      {lead.contactEmail && <span className="text-muted">{lead.contactEmail}</span>}
    </div>
  );
}

function Outcome({ id, buttons }: { id: number; buttons: [string, string][] }) {
  return (
    <form action={completeTaskAction} className="flex flex-wrap gap-2">
      <input type="hidden" name="id" value={id} />
      {buttons.map(([value, label]) => (
        <button key={value} name="outcome" value={value} className={SMALL}>{label}</button>
      ))}
    </form>
  );
}

function CallActions({ task }: { task: Task }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Outcome id={task.id} buttons={[['no_answer', 'No answer'], ['busy', 'Busy or voicemail'], ['wrong_number', 'Wrong number']]} />
      <details className="relative">
        <summary className="btn-primary list-none px-2.5 py-1 text-xs [&::-webkit-details-marker]:hidden">Connected</summary>
        <form action={completeTaskAction} className="card absolute right-0 z-10 mt-2 w-80 space-y-2 p-4 shadow-lg">
          <input type="hidden" name="id" value={task.id} />
          <label htmlFor={`note-${task.id}`} className="label">What was discussed *</label>
          <textarea id={`note-${task.id}`} name="note" rows={3} required className="field" placeholder="Spoke with the Plant Head about their current stock count process." />
          <label htmlFor={`fb-${task.id}`} className="label">Call outcome</label>
          <select id={`fb-${task.id}`} name="feedback" defaultValue="" className="field">
            <option value="">Choose…</option>
            {CALL_FEEDBACK.filter((f) => f !== 'Wrong number' && f !== 'Not reachable').map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <label htmlFor={`cb-${task.id}`} className="label">Next call on (optional)</label>
          <input id={`cb-${task.id}`} name="callbackDate" type="date" min={istDay()} className="field" />
          <p className="text-xs text-muted">Saves the call and stops the rest of this sequence. A date adds a callback to the top of your list.</p>
          <button name="outcome" value="connected" className="btn-primary">Save call</button>
        </form>
      </details>
    </div>
  );
}

function TaskRow({ item, bda, readOnly }: { item: TodayTask; bda: string; readOnly?: boolean }) {
  const { task, lead } = item;
  const wa = task.kind === 'whatsapp' ? whatsappLink(lead.contactPhone, whatsappIntro(lead, bda)) : '';
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Who lead={lead} task={task} />
          {item.overdue && <div className="mt-0.5 text-xs font-medium text-critical-ink">Overdue since {relativeDays(new Date(`${task.dueDate}T12:00:00+05:30`))}</div>}
          {task.priority && task.note && <div className="mt-0.5 text-xs text-ink-2">Note: {task.note}</div>}
          <Reach lead={lead} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {readOnly ? <span className="text-xs text-muted">Only {bda} can log this</span> : null}
          {!readOnly && task.kind === 'call' && <CallActions task={task} />}
          {task.kind === 'whatsapp' && (
            <>
              {wa ? <a href={wa} target="_blank" rel="noreferrer" className={SMALL}>Open WhatsApp</a> : null}
              {!readOnly && <Outcome id={task.id} buttons={[['sent', 'Mark sent'], ['skipped', 'Skip']]} />}
            </>
          )}
          {task.kind === 'linkedin' && (
            <>
              {lead.contactLinkedin ? <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className={SMALL}>Open profile</a> : null}
              <CopyButton text={linkedinNote(lead, bda)} label="Copy note" />
              {!readOnly && <Outcome id={task.id} buttons={[['sent', 'Mark sent'], ['skipped', 'Skip']]} />}
            </>
          )}
          {task.kind === 'email' && (
            <>
              <Link href={`/leads/${lead.id}`} className={SMALL}>Open draft</Link>
              {!readOnly && <Outcome id={task.id} buttons={[['done', 'Mark sent'], ['skipped', 'Skip']]} />}
            </>
          )}
        </div>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted hover:text-ink">{task.kind === 'call' ? 'Talk track' : 'Message'}</summary>
        <div className="mt-2 space-y-2 rounded-md bg-surface-2 p-3 text-sm">
          {task.kind === 'call' && (
            <>
              <p>{callOpener(lead, bda)}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
                {discoveryQuestions(lead).map((q) => <li key={q}>{q}</li>)}
              </ul>
            </>
          )}
          {task.kind === 'whatsapp' && (
            <>
              <p>{whatsappIntro(lead, bda)}</p>
              <CopyButton text={whatsappIntro(lead, bda)} label="Copy message" />
            </>
          )}
          {task.kind === 'linkedin' && <p>{linkedinNote(lead, bda)}</p>}
          {task.kind === 'email' && <p className="whitespace-pre-line">{lead.emailSubject ? `Subject: ${lead.emailSubject}\n\n` : ''}{lead.emailBody || 'No draft yet.'}</p>}
        </div>
      </details>
    </li>
  );
}

/** In the "All" view each list shows its first few items, with a link to the full list. */
const PREVIEW = 5;

function Section({ title, hint, items, bda, limit, more, readOnly }: { title: string; hint?: string; items: TodayTask[]; bda: string; limit?: number; more?: string; readOnly?: boolean }) {
  if (!items.length) return null;
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <section className="card mb-6 overflow-hidden">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold">
          {title} <span className="font-normal text-muted tabular-nums">{items.length}</span>
        </h2>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <ul className="divide-y divide-line">
        {shown.map((i) => <TaskRow key={i.task.id} item={i} bda={bda} readOnly={readOnly} />)}
      </ul>
      {more && shown.length < items.length && (
        <Link href={more} className="block border-t border-line px-5 py-3 text-sm font-medium text-accent hover:bg-surface-2">
          Show all {items.length}
        </Link>
      )}
    </section>
  );
}

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'call', label: 'Calls' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Emails' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'done', label: 'Done today' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default async function TodayPage({ searchParams }: PageProps<'/today'>) {
  const me = (await getCurrentUser())!;
  const db = await getDb();
  await assignUnowned(db);
  await ensureSequences(db);

  const team = await listBdas(db);
  const sp = await searchParams;
  const asked = Number(typeof sp.user === 'string' ? sp.user : 0);
  const viewId = me.role === 'admin' ? (team.find((b) => b.id === asked)?.id ?? team[0]?.id ?? 0) : me.id;
  const viewing = team.find((b) => b.id === viewId);
  const bda = viewing?.name ?? me.name;
  const own = me.id === viewId;

  const day = istDay();
  const [items, counts, attendance, unattended, demos] = await Promise.all([
    loadTodayTasks(db, viewId, day),
    dayCounts(db, viewId, day),
    getAttendance(db, viewId, day),
    unattendedInbound(db, viewId),
    db.select().from(leads).where(and(eq(leads.ownerId, viewId), eq(leads.status, 'Meeting Booked'))),
  ]);
  // Filters: one channel at a time, a search by company or person, only leads with a phone number, only overdue.
  const tab: TabKey = TABS.some((t) => t.key === sp.view) ? (sp.view as TabKey) : 'all';
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const withPhone = sp.phone === '1';
  const overdueOnly = sp.overdue === '1';
  const needle = q.toLowerCase();
  const matches = (i: TodayTask) =>
    (!needle || [i.lead.company, i.lead.contactName, i.lead.city].some((v) => v.toLowerCase().includes(needle))) &&
    (!withPhone || !!i.lead.contactPhone) &&
    (!overdueOnly || i.overdue);
  const filtered = items.filter(matches);
  const callbacks = filtered.filter((i) => i.task.priority);
  const rest = filtered.filter((i) => !i.task.priority);
  const byKind = (k: Task['kind']) => rest.filter((i) => i.task.kind === k);
  const done = (await loadDoneToday(db, viewId, day)).filter((d) => !needle || [d.lead.company, d.lead.contactName].some((v) => v.toLowerCase().includes(needle)));
  const tabCount = (k: TabKey) => (k === 'all' ? rest.length : k === 'done' ? done.length : byKind(k).length);
  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({
      ...(me.role === 'admin' && viewId ? { user: String(viewId) } : {}),
      ...(tab !== 'all' && { view: tab }),
      ...(q && { q }),
      ...(withPhone && { phone: '1' }),
      ...(overdueOnly && { overdue: '1' }),
      ...next,
    });
    for (const [k, v] of [...p]) if (!v || (k === 'view' && v === 'all')) p.delete(k);
    return `/today${p.size ? `?${p}` : ''}`;
  };
  const show = (k: Task['kind']) => tab === 'all' || tab === k;
  const showDone = tab === 'done';
  const limit = tab === 'all' ? PREVIEW : undefined;
  const startHere = unattended.length + callbacks.length + demos.length;

  return (
    <>
      <PageHeader title="Today" description={`${formatDate(new Date())}. Work the list from the top: callbacks, demos and new inbound leads come first.`}>
        {me.role === 'admin' && team.length > 0 && (
          <AutoFilterForm className="flex items-center gap-2">
            <label htmlFor="user" className="sr-only">Show the list of</label>
            <select id="user" name="user" defaultValue={viewId} className="field w-auto py-1.5">
              {team.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </AutoFilterForm>
        )}
      </PageHeader>

      {me.role === 'admin' && !team.length && <p className="mb-6 text-sm text-muted">No team members yet.</p>}
      {me.role === 'admin' && viewing && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 text-sm text-ink-2">
          <span>You are looking at {viewing.name}&apos;s list. Only {viewing.name} can log calls and messages here, so the numbers are always theirs.</span>
          <details className="relative">
            <summary className="btn-secondary list-none px-2.5 py-1 text-xs [&::-webkit-details-marker]:hidden">Clear test activity</summary>
            <form action={resetTodayLogAction} className="card absolute right-0 z-30 mt-2 w-80 space-y-2 p-4 shadow-lg">
              <input type="hidden" name="userId" value={viewing.id} />
              <p className="text-sm font-medium text-ink">Start {viewing.name} from zero?</p>
              <p className="text-xs text-muted">Removes every logged call, message and email, every callback and the attendance for {viewing.name}. Their outreach plan is made again from day 1. Notes on the lead timelines stay.</p>
              <button className="btn-danger">Clear and start fresh</button>
            </form>
          </details>
        </div>
      )}

      <section className="card mb-6 flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
        <div>
          <span className="font-medium">{bda}</span>
          <span className="ml-3 text-ink-2">
            {attendance?.clockInAt
              ? attendance.clockOutAt
                ? `Clocked in ${formatTime(attendance.clockInAt)}, out ${formatTime(attendance.clockOutAt)}`
                : `Clocked in at ${formatTime(attendance.clockInAt)}`
              : 'Not clocked in'}
            {attendance ? <span className="text-muted">{` · first seen ${formatTime(attendance.firstSeenAt)}`}</span> : null}
          </span>
        </div>
        {own && me.id ? (
          attendance?.clockInAt && !attendance.clockOutAt ? (
            <form action={clockOutAction}><button className="btn-secondary">Clock out</button></form>
          ) : (
            <form action={clockInAction}><button className="btn-primary">{attendance?.clockOutAt ? 'Clock in again' : 'Clock in'}</button></form>
          )
        ) : null}
      </section>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Counter label="Connected calls today" done={counts.connectedCalls} goal={DAILY_CONNECTED_CALLS} />
        <Counter label="Connected calls with CAs" done={counts.caConnectedCalls} goal={DAILY_CA_CONNECTED_CALLS} />
        <Counter label="LinkedIn requests sent" done={counts.linkedinSent} goal={DAILY_LINKEDIN_LIMIT} />
        <div className="card p-4 text-sm">
          <div className="text-xs text-muted">Also logged today</div>
          <dl className="mt-1 space-y-0.5">
            {(
              [
                ['Call attempts', counts.callAttempts],
                ['WhatsApp sent', counts.whatsappSent],
                ['Emails sent', counts.emailsDone],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-ink-2">{label}</dt>
                <dd className="font-medium tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {startHere > 0 && (
        <section className="card mb-6 overflow-hidden border-warning-ink/40">
          <div className="border-b border-line bg-warning-soft px-5 py-3">
            <h2 className="text-sm font-semibold text-warning-ink">Start here <span className="font-normal tabular-nums">{startHere}</span></h2>
          </div>
          <ul className="divide-y divide-line">
            {unattended.map((l) => (
              <li key={`in-${l.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company}</Link>
                  <div className="text-xs font-medium text-critical-ink">Inbound lead untouched for over {UNATTENDED_AFTER_HOURS} hours. Call, understand, qualify.</div>
                </div>
                <Link href={`/leads/${l.id}`} className={SMALL}>Open lead</Link>
              </li>
            ))}
            {demos.map((l) => (
              <li key={`demo-${l.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.company}</Link>
                  <div className="text-xs text-ink-2">Demo or meeting booked{l.contactName ? ` with ${l.contactName}` : ''}. Customer meetings come first.</div>
                </div>
                <Link href={`/leads/${l.id}`} className={SMALL}>Open lead</Link>
              </li>
            ))}
            {callbacks.map((i) => <TaskRow key={i.task.id} item={i} bda={bda} readOnly={!own} />)}
          </ul>
        </section>
      )}

      <div className="sticky top-0 z-20 -mx-4 mb-6 border-b border-line bg-page/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
        <nav className="flex flex-wrap gap-1.5" aria-label="Show">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={link({ view: t.key })}
              aria-current={tab === t.key ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${tab === t.key ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}
            >
              {t.label} <span className="tabular-nums">{tabCount(t.key)}</span>
            </Link>
          ))}
        </nav>
        <AutoFilterForm className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {me.role === 'admin' && viewId ? <input type="hidden" name="user" value={viewId} /> : null}
          {tab !== 'all' && <input type="hidden" name="view" value={tab} />}
          <label htmlFor="today-q" className="sr-only">Search company or person</label>
          <input id="today-q" type="search" name="q" defaultValue={q} placeholder="Search company or person" className="field h-9 max-w-xs py-1.5" />
          <label className="flex items-center gap-1.5 text-ink-2">
            <input type="checkbox" name="phone" value="1" defaultChecked={withPhone} /> Has a phone number
          </label>
          <label className="flex items-center gap-1.5 text-ink-2">
            <input type="checkbox" name="overdue" value="1" defaultChecked={overdueOnly} /> Overdue only
          </label>
          {(q || withPhone || overdueOnly) && (
            <Link href={link({ q: '', phone: '', overdue: '' })} className="text-xs text-muted hover:text-ink">Clear filters</Link>
          )}
        </AutoFilterForm>
      </div>

      {!showDone && done.length > 0 && (
        <p className="-mt-3 mb-4 text-xs text-muted">
          Logged items leave the list. {done.length} done today:{' '}
          <Link href={link({ view: 'done' })} className="text-accent hover:underline">see them or undo</Link>.
        </p>
      )}

      {showDone && (
        <section className="card mb-6 overflow-hidden">
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-sm font-semibold">Done today <span className="font-normal text-muted tabular-nums">{done.length}</span></h2>
            <p className="text-xs text-muted">Everything logged today. The lead stays in Leads, and its next step comes back on the day it is due. Undo puts an item back on today&apos;s list.</p>
          </div>
          {done.length ? (
            <ul className="divide-y divide-line">
              {done.map(({ task, lead }) => (
                <li key={task.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">{lead.company}</Link>
                    <span className="text-sm text-ink-2">{lead.contactName ? ` · ${lead.contactName}` : ''}</span>
                    <div className="text-xs text-ink-2">
                      <span className="font-medium">{OUTCOME_LABEL[task.outcome] ?? task.outcome}</span>
                      {' · '}{task.title}{task.doneAt ? ` · ${formatTime(task.doneAt)}` : ''}
                    </div>
                    {task.note && task.outcome === 'connected' && <div className="text-xs text-muted">{task.note}</div>}
                  </div>
                  {own && (
                    <form action={undoTaskAction}>
                      <input type="hidden" name="id" value={task.id} />
                      <button className={SMALL}>Undo</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-muted">Nothing logged yet today.</p>
          )}
        </section>
      )}

      {show('call') && <Section title="Calls" hint="Connected means a live conversation with the decision-maker, not an attempt." items={byKind('call')} bda={bda} readOnly={!own} limit={limit} more={link({ view: 'call' })} />}
      {show('whatsapp') && <Section title="WhatsApp" items={byKind('whatsapp')} bda={bda} readOnly={!own} limit={limit} more={link({ view: 'whatsapp' })} />}
      {show('email') && <Section title="Emails" items={byKind('email')} bda={bda} readOnly={!own} limit={limit} more={link({ view: 'email' })} />}
      {show('linkedin') && <Section title="LinkedIn requests" hint={`At most ${DAILY_LINKEDIN_LIMIT} a day. ${Math.max(0, DAILY_LINKEDIN_LIMIT - counts.linkedinSent)} left today.`} items={byKind('linkedin')} bda={bda} readOnly={!own} limit={limit} more={link({ view: 'linkedin' })} />}

      {items.length > 0 && !filtered.length && (
        <div className="card p-8 text-center text-sm text-muted">
          Nothing matches these filters. <Link href={link({ q: '', phone: '', overdue: '' })} className="text-accent hover:underline">Clear filters</Link>
        </div>
      )}
      {items.length > 0 && filtered.length > 0 && tab !== 'all' && tab !== 'done' && !tabCount(tab) && (
        <div className="card p-8 text-center text-sm text-muted">Nothing due here. <Link href={link({ view: 'all' })} className="text-accent hover:underline">See everything due</Link></div>
      )}

      {!items.length && !startHere && (
        <div className="card p-8 text-center text-sm text-muted">
          Nothing due. New companies the engine researches appear here with their calls, WhatsApp messages, emails and LinkedIn requests.
          <div className="mt-3"><Link href="/leads" className="btn-secondary">See your leads</Link></div>
        </div>
      )}
    </>
  );
}
