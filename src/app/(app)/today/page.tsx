import Link from 'next/link';
import { after } from 'next/server';
import { liveServices, startRefetchIfWaiting } from '@/lib/run-driver';
import { tidyContacts, verifyContacts } from '@/lib/verify-contacts';
import { redraftForContact } from '@/lib/pipeline/redraft';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { icps, leads, people, type Lead, type Person, type Task } from '@/lib/db/schema';
import { contactPriority, icpFor } from '@/lib/tiers';
import { candidateRank } from '@/lib/pipeline/contacts';
import { getCurrentUser, listBdas } from '@/lib/users';
import { assignUnowned } from '@/lib/assign';
import { runDailyDraw } from '@/lib/draw';
import { getAttendance } from '@/lib/attendance';
import {
  companyProgress,
  DAILY_CALL_TARGET,
  DAILY_COMPANY_TARGET,
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
import { formatDate, formatTime } from '@/lib/dates';
import { FIND_NEXT_STEP } from '@/lib/escalate';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { CALL_FEEDBACK, NOT_INTERESTED } from '@/lib/tracker';
import { CopyButton } from '@/components/copy-button';
import { clockInAction, clockOutAction, completeTaskAction, resetTodayLogAction, saveFoundDetailAction, undoTaskAction, updateContactAction } from '../../team-actions';
import { makePrimaryAction } from '../../actions';

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

function Reach({ lead }: { lead: Lead }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {/* Only a number the team found and saved: phone numbers aren't collected automatically. */}
      {lead.contactPhone && (
        <a href={`tel:${lead.contactPhone.replace(/[^\d+]/g, '')}`} className="font-medium text-accent hover:underline">{lead.contactPhone}</a>
      )}
      {lead.contactLinkedin && <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn profile</a>}
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
      {/* Opens in place, under the buttons, so nothing can cut it off on any screen. */}
      <details className="group open:basis-full">
        <summary className="btn-primary list-none px-2.5 py-1 text-xs group-open:ring-2 group-open:ring-accent/30 [&::-webkit-details-marker]:hidden">Connected</summary>
        <form action={completeTaskAction} className="mt-3 w-[min(28rem,calc(100vw-5rem))] space-y-2 rounded-lg border border-line bg-surface-2 p-4">
          <input type="hidden" name="id" value={task.id} />
          <label htmlFor={`note-${task.id}`} className="label">What was discussed *</label>
          <textarea id={`note-${task.id}`} name="note" rows={3} required className="field" placeholder="Spoke with the Plant Head about their current stock count process." />
          <label htmlFor={`fb-${task.id}`} className="label">Call outcome *</label>
          <select id={`fb-${task.id}`} name="feedback" defaultValue="" required className="field">
            <option value="">Choose…</option>
            {CALL_FEEDBACK.filter((f) => f !== 'Wrong number' && f !== 'Not reachable').map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <label htmlFor={`cb-${task.id}`} className="label">Next call on (optional)</label>
          <input id={`cb-${task.id}`} name="callbackDate" type="date" min={istDay()} className="field" />
          <p className="text-xs text-muted">
            {NOT_INTERESTED.join(', ')}: the WhatsApp, email and LinkedIn for this company are ticked off, nothing more goes out. Any other outcome: still send today&apos;s WhatsApp, email and LinkedIn request; the later follow-up rounds stop. A date adds a callback to the top of your list.
          </p>
          <button name="outcome" value="connected" className="btn-primary">Save call</button>
        </form>
      </details>
    </div>
  );
}

/** A small inline field to save a number, email or profile the person found themselves (ContactOut, a call, the website). */
function FoundDetail({ leadId, field, label, placeholder, type }: { leadId: number; field: string; label: string; placeholder: string; type: string }) {
  return (
    <form action={saveFoundDetailAction} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={leadId} />
      <input type="hidden" name="field" value={field} />
      <label htmlFor={`${field}-found-${leadId}`} className="text-xs text-muted">{label}</label>
      <input id={`${field}-found-${leadId}`} name="value" type={type} required placeholder={placeholder} className="field h-8 w-56 py-1 text-xs" />
      <button className={SMALL}>Save</button>
    </form>
  );
}

const STEP_LABEL: Record<Task['kind'], string> = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', linkedin: 'LinkedIn' };

const roundNo = (t: Task) => Number(/Follow-up (\d+)/.exec(t.step)?.[1] ?? 0);
/** The later of two rounds: by due date, then Follow-up 3 after Follow-up 2 on the same day. */
const laterRound = (a: Task, b: Task) => a.dueDate > b.dueDate || (a.dueDate === b.dueDate && roundNo(a) >= roundNo(b));

/** Which round this is, in plain words. */
function roundLabel(task: Task): string {
  if (task.priority) return 'Promised callback';
  if (task.step.startsWith('Day 1')) return 'First contact';
  return task.step;
}

/** One line of a company's checklist: the step, what to say, and the buttons to log it. */
function Step({ item, bda, readOnly, linkedinFull, askPhone }: { item: TodayTask; bda: string; readOnly: boolean; linkedinFull: boolean; askPhone: boolean }) {
  const { task, lead } = item;
  // The P2 flow ran out of people: this row asks for the next person rather than a call.
  const finding = task.step === FIND_NEXT_STEP;
  const wa = task.kind === 'whatsapp' ? whatsappLink(lead.contactPhone, whatsappIntro(lead, bda)) : '';
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
      <div className="flex w-40 shrink-0 items-start gap-2">
        <span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-line bg-surface" aria-hidden />
        <div>
          <div className="text-sm font-medium">{finding ? 'Next contact' : STEP_LABEL[task.kind]}</div>
          {task.priority && <div className="text-xs text-muted">Promised callback</div>}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {readOnly ? (
          <span className="text-xs text-muted">Only {bda} can log this</span>
        ) : (
          <div className="flex flex-wrap items-start gap-2">
            {task.kind === 'call' && (finding ? <Outcome id={task.id} buttons={[['skipped', 'Skip for today']]} /> : <CallActions task={task} />)}
            {task.kind === 'whatsapp' && (
              <>
                {wa ? <a href={wa} target="_blank" rel="noreferrer" className={SMALL}>Open WhatsApp</a> : null}
                <Outcome id={task.id} buttons={[['sent', 'Mark sent'], ['skipped', 'Skip']]} />
              </>
            )}
            {task.kind === 'email' && (
              <>
                <Link href={`/leads/${lead.id}`} className={SMALL}>Open draft</Link>
                <Outcome id={task.id} buttons={[['done', 'Mark sent'], ['skipped', 'Skip']]} />
              </>
            )}
            {task.kind === 'linkedin' &&
              (linkedinFull ? (
                <span className="text-xs text-muted">Daily limit of {DAILY_LINKEDIN_LIMIT} requests reached. This one stays for tomorrow.</span>
              ) : (
                <>
                  {lead.contactLinkedin ? <a href={lead.contactLinkedin} target="_blank" rel="noreferrer" className={SMALL}>Open LinkedIn profile</a> : null}
                  <Outcome id={task.id} buttons={[['sent', 'Request sent'], ['skipped', 'Skip']]} />
                </>
              ))}
          </div>
        )}
        {!readOnly && askPhone && !finding && !lead.contactPhone && (
          <FoundDetail leadId={lead.id} field="contactPhone" label="Found the number? Save it" placeholder="+91 98xxx xxxxx" type="tel" />
        )}
        {!readOnly && task.kind === 'linkedin' && !lead.contactLinkedin && (
          <FoundDetail
            leadId={lead.id}
            field="contactLinkedin"
            label={lead.contactCheckedAt ? 'Not found on LinkedIn automatically. Found it? Paste it' : 'Looking it up on LinkedIn. Found it already? Paste it'}
            placeholder="linkedin.com/in/…"
            type="text"
          />
        )}
        {task.step === FIND_NEXT_STEP && (
          <p className="mt-2 text-xs text-warning-ink">
            The last contact didn&apos;t work out and nobody else is on file. Find a P2 (process owner: inventory, warehouse, procurement or supply chain manager) and add them under Edit point of contact; their plan starts straight away.
          </p>
        )}
        {task.priority && task.note && !task.note.startsWith('auto-retry:') && <div className="mt-1 text-xs text-ink-2">Note: {task.note}</div>}
        <details className={`mt-1.5 ${finding ? 'hidden' : ''}`}>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">{task.kind === 'call' ? 'Talk track' : task.kind === 'linkedin' ? 'Connection note' : 'Message'}</summary>
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
            {task.kind === 'email' && <p className="whitespace-pre-line">{lead.emailSubject ? `Subject: ${lead.emailSubject}\n\n` : ''}{lead.emailBody || 'No draft yet.'}</p>}
            {task.kind === 'linkedin' && (
              <>
                <p>{linkedinNote(lead, bda)}</p>
                <CopyButton text={linkedinNote(lead, bda)} label="Copy note" />
              </>
            )}
          </div>
        </details>
      </div>
    </li>
  );
}

const CONTACT_FIELDS: [name: keyof Lead, label: string, type?: string][] = [
  ['contactName', 'Name'],
  ['contactTitle', 'Designation'],
  ['contactPhone', 'Contact number', 'tel'],
  ['contactLinkedin', 'LinkedIn URL', 'url'],
];

/** Fix or replace the point of contact without leaving Today: the number from ContactOut, a new email, or someone else at the company. */
function EditContact({ lead, others }: { lead: Lead; others: Person[] }) {
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer list-none text-xs font-medium text-accent hover:underline [&::-webkit-details-marker]:hidden">Edit point of contact</summary>
      <div className="mt-2 w-[min(40rem,calc(100vw-5rem))] space-y-3 rounded-lg border border-line bg-surface-2 p-4">
        <form action={updateContactAction} className="space-y-3">
          <input type="hidden" name="id" value={lead.id} />
          <div className="grid gap-2 sm:grid-cols-2">
            {CONTACT_FIELDS.map(([name, label, type]) => (
              <div key={name} className={name === 'contactLinkedin' ? 'sm:col-span-2' : ''}>
                <label htmlFor={`${name}-${lead.id}`} className="label">{label}</label>
                <input id={`${name}-${lead.id}`} name={name} type={type ?? 'text'} defaultValue={String(lead[name] ?? '')} className="field" />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">Changing the name to someone else clears the previous person&apos;s number, email and LinkedIn unless you type new ones.</p>
          <button className="btn-primary px-3 py-1.5 text-sm">Save contact</button>
        </form>
        {others.length > 0 && (
          <form action={makePrimaryAction} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <input type="hidden" name="id" value={lead.id} />
            <div className="min-w-0 flex-1">
              <label htmlFor={`switch-${lead.id}`} className="label">Or switch to someone else found at {lead.company}</label>
              <select id={`switch-${lead.id}`} name="personId" className="field">
                {others.map((p) => (
                  <option key={p.id} value={p.id}>{[p.name, p.title].filter(Boolean).join(' · ')}</option>
                ))}
              </select>
            </div>
            <button className="btn-secondary px-3 py-1.5 text-sm">Make point of contact</button>
          </form>
        )}
      </div>
    </details>
  );
}

/** Everything due today for one company, as a checklist: call first, then WhatsApp, then email. */
type CompanyGroup = { lead: Lead; items: TodayTask[]; priority: boolean; first: string; round: Task };
const KIND_ORDER: Task['kind'][] = ['call', 'whatsapp', 'email', 'linkedin'];

/** A step already logged today: ticked, with what happened and an Undo. */
function DoneStep({ task, readOnly }: { task: Task; readOnly: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="flex w-40 shrink-0 items-start gap-2">
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-accent bg-accent text-white" aria-hidden>
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2.5 6.5l2.5 2.5 4.5-5" /></svg>
        </span>
        <div className="text-sm font-medium text-ink-2">{STEP_LABEL[task.kind]}</div>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 text-xs text-ink-2">
        <span>
          {OUTCOME_LABEL[task.outcome] ?? task.outcome}
          {task.doneAt ? ` at ${formatTime(task.doneAt)}` : ''}
        </span>
        {!readOnly && (
          <form action={undoTaskAction}>
            <input type="hidden" name="id" value={task.id} />
            <button className="text-xs text-muted hover:text-ink hover:underline">Undo</button>
          </form>
        )}
      </div>
    </li>
  );
}

function CompanyCard({
  group,
  bda,
  readOnly,
  others,
  doneToday,
  linkedinFull,
}: {
  group: CompanyGroup;
  bda: string;
  readOnly: boolean;
  others: Person[];
  doneToday: Task[];
  linkedinFull: boolean;
}) {
  const { lead } = group;
  // One row per channel, in the same order every time: open ones to log, the ones logged today ticked.
  // Logging a row also ticks off any earlier rounds of that channel still open (see catchUp).
  const rows = KIND_ORDER.flatMap((k): { kind: Task['kind']; open?: TodayTask; done?: Task }[] => {
    // A promised callback first, else the latest round of this channel; logging a round also ticks off any older one still open.
    const ofKind = group.items.filter((i) => i.task.kind === k);
    const open = ofKind.find((i) => i.task.priority) ?? ofKind.at(-1);
    if (open) return [{ kind: k, open, done: undefined }];
    const done = doneToday.find((t) => t.kind === k);
    return done ? [{ kind: k, open: undefined, done }] : [];
  });
  // Ask for a missing number once per company: on the call row, or on WhatsApp once the call is logged.
  const phoneRow = rows.find((r) => r.open && (r.kind === 'call' || r.kind === 'whatsapp'))?.kind;
  const total = rows.length;
  const ticked = rows.filter((r) => r.done).length;
  return (
    <li className="px-5 py-4" data-company={lead.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">{lead.company}</Link>
          {lead.city && <span className="ml-1.5 text-sm text-muted">{lead.city}</span>}
          {group.priority && <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning-ink">Callback</span>}
          <span className="ml-2 text-xs text-muted">{roundLabel(group.round)} · <span className="tabular-nums">{ticked} of {total} done</span></span>
          <div className="text-sm text-ink-2">
            {lead.contactName}
            {lead.contactTitle ? <span className="text-muted">, {lead.contactTitle}</span> : null}
          </div>
          <Reach lead={lead} />
          {!readOnly && <EditContact lead={lead} others={others} />}
          {others.filter((p) => !p.passedAt).length > 0 && (
            <div className="mt-2 rounded-md border border-line bg-surface-2 px-3 py-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Also at {lead.company}</div>
              <ul className="mt-1 space-y-1">
                {others
                  .filter((p) => !p.passedAt)
                  .slice(0, 3)
                  .map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="font-medium text-ink">{p.name}</span>
                      {p.title && <span className="text-muted">{p.title}</span>}
                      {p.linkedin && <a href={p.linkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a>}
                      {!p.linkedin && <span className="text-muted">no details yet</span>}
                      {!readOnly && (
                        <form action={makePrimaryAction}>
                          <input type="hidden" name="id" value={lead.id} />
                          <input type="hidden" name="personId" value={p.id} />
                          <button className="text-accent hover:underline">Make main contact</button>
                        </form>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        {rows.map((r) =>
          r.open ? (
            <Step key={r.open.task.id} item={r.open} bda={bda} readOnly={readOnly} linkedinFull={linkedinFull} askPhone={r.kind === phoneRow} />
          ) : (
            <DoneStep key={r.done!.id} task={r.done!} readOnly={readOnly} />
          ),
        )}
      </ul>
    </li>
  );
}

/** In the "All" view the list shows its first companies, with a link to the full list. */
const PREVIEW = 10;

const TABS = [
  { key: 'all', label: 'To do' },
  { key: 'done', label: 'Done today' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default async function TodayPage({ searchParams }: PageProps<'/today'>) {
  const me = (await getCurrentUser())!;
  const db = await getDb();
  await assignUnowned(db);
  await runDailyDraw(db);
  await startRefetchIfWaiting();
  await ensureSequences(db);

  const team = await listBdas(db);
  const sp = await searchParams;
  const asked = Number(typeof sp.user === 'string' ? sp.user : 0);
  const viewId = me.role === 'admin' ? (team.find((b) => b.id === asked)?.id ?? team[0]?.id ?? 0) : me.id;
  // The right person on every card before it's drawn (a plant head over someone off the lists, nobody
  // who has left); anything not yet checked on LinkedIn is checked right after the page is sent.
  const switched = viewId ? await tidyContacts(db, { ownerId: viewId }) : [];
  // Main contacts due today that were never checked on LinkedIn are checked before the cards are drawn
  // (a few seconds at most; whatever's left carries on after the page is sent).
  if (viewId) {
    const svc = await liveServices();
    await Promise.race([
      verifyContacts(db, svc, { ownerId: viewId, dueToday: true, mainOnly: true, limit: 10 }),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  }
  after(async () => {
    const d = await getDb();
    const svc = await liveServices();
    for (const id of switched) await redraftForContact(d, svc, id);
    await verifyContacts(d, svc, { ownerId: viewId, limit: 30 });
  });
  const viewing = team.find((b) => b.id === viewId);
  const bda = viewing?.name ?? me.name;
  const own = me.id === viewId;

  const day = istDay();
  const [items, counts, progress, attendance, unattended, demos] = await Promise.all([
    loadTodayTasks(db, viewId, day),
    dayCounts(db, viewId, day),
    companyProgress(db, viewId, day),
    getAttendance(db, viewId, day),
    unattendedInbound(db, viewId),
    db.select().from(leads).where(and(eq(leads.ownerId, viewId), eq(leads.status, 'Meeting Booked'))),
  ]);
  // Filter: a search by company or person.
  const tab: TabKey = TABS.some((t) => t.key === sp.view) ? (sp.view as TabKey) : 'all';
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const needle = q.toLowerCase();
  const matches = (i: TodayTask) =>
    !needle || [i.lead.company, i.lead.contactName, i.lead.city].some((v) => v.toLowerCase().includes(needle));
  const filtered = items.filter(matches);
  // One entry per company, with everything due for it.
  const groupsById = new Map<number, CompanyGroup>();
  for (const i of filtered) {
    const g = groupsById.get(i.lead.id) ?? { lead: i.lead, items: [], priority: false, first: i.task.dueDate, round: i.task };
    g.items.push(i);
    g.priority ||= i.task.priority;
    if (!i.task.priority && (g.round.priority || laterRound(i.task, g.round))) g.round = i.task;
    if (i.task.dueDate < g.first) g.first = i.task.dueDate;
    groupsById.set(i.lead.id, g);
  }
  const groups = [...groupsById.values()].sort(
    (a, b) => Number(b.priority) - Number(a.priority) || a.first.localeCompare(b.first) || a.lead.company.localeCompare(b.lead.company),
  );
  const doneAll = await loadDoneToday(db, viewId, day);
  const doneOf = (leadId: number) => doneAll.filter((d) => d.lead.id === leadId).map((d) => d.task);
  const linkedinFull = counts.linkedinSent >= DAILY_LINKEDIN_LIMIT;
  const done = doneAll.filter((d) => !needle || [d.lead.company, d.lead.contactName].some((v) => v.toLowerCase().includes(needle)));
  const tabCount = (k: TabKey) => (k === 'done' ? done.length : groups.length);
  const link = (next: Record<string, string>) => {
    const p = new URLSearchParams({
      ...(me.role === 'admin' && viewId ? { user: String(viewId) } : {}),
      ...(tab !== 'all' && { view: tab }),
      ...(q && { q }),
      ...next,
    });
    for (const [k, v] of [...p]) if (!v || (k === 'view' && v === 'all')) p.delete(k);
    return `/today${p.size ? `?${p}` : ''}`;
  };
  const showDone = tab === 'done';
  const shownGroups = groups;
  const visible = tab === 'all' && sp.all !== '1' ? shownGroups.slice(0, PREVIEW) : shownGroups;
  // Other people found at these companies, to switch the point of contact to.
  const peopleRows = visible.length ? await db.select().from(people).where(inArray(people.leadId, visible.map((g) => g.lead.id))) : [];
  const icpRows = await db.select().from(icps);
  const icpOf = (l: Lead) => icpFor(l.segment, icpRows);
  // Best first by INVECK's contact priority; people already tried go last.
  const othersOf = (l: Lead) =>
    peopleRows
      // Only people on the ICP's P1/P2/P3 lists: INVECK doesn't want anyone else.
      .filter((p) => p.leadId === l.id && !p.isPrimary && p.name.toLowerCase() !== l.contactName.toLowerCase() && contactPriority(p.title, icpOf(l)) < 99)
      .sort((a, b) => Number(!!a.passedAt) - Number(!!b.passedAt) || candidateRank(a, icpOf(l), l.city) - candidateRank(b, icpOf(l), l.city));
  const startHere = unattended.length + demos.length;

  return (
    <>
      <PageHeader title={own ? `Hello ${bda}!` : `${bda}'s day`} description={`${formatDate(new Date())}. Work the list from the top: callbacks, demos and new inbound leads come first.`}>
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
              <p className="text-xs text-muted">Removes every logged call, message and email, every callback, the attendance and the tracker outcomes for {viewing.name}, and puts back numbers marked wrong. Their outreach plan is made again from day 1. Notes on the lead timelines stay.</p>
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

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Counter label="Companies done today" done={progress.done} goal={DAILY_COMPANY_TARGET} />
        <Counter label="Calls attempted" done={counts.callAttempts} goal={DAILY_CALL_TARGET} />
        <Counter label="Connected calls" done={counts.connectedCalls} />
        <Counter label="WhatsApp sent" done={counts.whatsappSent} />
        <Counter label="Emails sent" done={counts.emailsDone} />
        <Counter label="LinkedIn requests" done={counts.linkedinSent} />
      </div>

      {startHere > 0 && (
        <section className="card mb-6 border-warning-ink/40">
          <div className="rounded-t-lg border-b border-line bg-warning-soft px-5 py-3">
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
          {q && (
            <Link href={link({ q: '' })} className="text-xs text-muted hover:text-ink">Clear search</Link>
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

      {!showDone && visible.length > 0 && (
        <section className="card mb-6">
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-sm font-semibold">
              Companies to contact <span className="font-normal text-muted tabular-nums">{shownGroups.length}</span>
            </h2>
            <p className="text-xs text-muted">
              For each company, do every step today: call, WhatsApp, email and LinkedIn. When all are ticked the company is done for the day. A call marked Not interested ticks off the rest.
            </p>
          </div>
          <ul className="divide-y divide-line">
            {visible.map((g) => (
              <CompanyCard key={g.lead.id} group={g} bda={bda} readOnly={!own} others={othersOf(g.lead)} doneToday={doneOf(g.lead.id)} linkedinFull={linkedinFull} />
            ))}
          </ul>
          {visible.length < shownGroups.length && (
            <Link href={link({ all: '1' })} className="block rounded-b-lg border-t border-line px-5 py-3 text-sm font-medium text-accent hover:bg-surface-2">
              Show all {shownGroups.length}
            </Link>
          )}
        </section>
      )}

      {items.length > 0 && !filtered.length && (
        <div className="card p-8 text-center text-sm text-muted">
          Nothing matches this search. <Link href={link({ q: '' })} className="text-accent hover:underline">Clear search</Link>
        </div>
      )}
      {items.length > 0 && filtered.length > 0 && tab !== 'all' && tab !== 'done' && !shownGroups.length && (
        <div className="card p-8 text-center text-sm text-muted">Nothing due here. <Link href={link({ view: 'all' })} className="text-accent hover:underline">See everything due</Link></div>
      )}

      {!items.length && !startHere && (
        <div className="card p-8 text-center text-sm text-muted">
          Nothing due. New companies the engine researches appear here with their calls, WhatsApp messages and emails.
          <div className="mt-3"><Link href="/leads" className="btn-secondary">See your leads</Link></div>
        </div>
      )}
    </>
  );
}
