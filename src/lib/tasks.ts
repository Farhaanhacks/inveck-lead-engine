import { and, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { activities, companyDays, leads, tasks, type Lead, type Task, type TaskKind } from './db/schema';

export const DAILY_LINKEDIN_LIMIT = 50;
/** The step that asks the team for a person to contact (nobody confirmed at the company's site yet). */
export const FIND_NEXT_STEP = 'Find the next person';
/** After this many unanswered calls to one person, stop the automatic call-again reminders: try the next person (P2). */
export const MAX_CALL_ATTEMPTS = 5;
/** Calls each person should attempt in a day. */
export const DAILY_CALL_TARGET = 40;
/** Companies each person should complete in a day (every step done). */
export const DAILY_COMPANY_TARGET = 40;
/** CA firms reached in a day, for the people who work CA firms (CA_TEAM). */
export const DAILY_CA_TARGET = 20;
/** Who works CA firms, by first name: they get their own daily CA count, apart from the companies. */
const CA_TEAM = ['puja', 'anchal', 'aanchal'];
export const worksCaFirms = (name: string) => CA_TEAM.includes(name.trim().split(/\s+/)[0]?.toLowerCase() ?? '');
export const DAILY_CA_CONNECTED_CALLS = 10;
/** Inbound leads nobody has touched after this long are flagged. */
export const UNATTENDED_AFTER_HOURS = 2;

const DAY_MS = 86_400_000;

/** Today's date in India, as YYYY-MM-DD. */
export function istDay(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** The instants an Indian day starts and ends. */
export function istDayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The day itself, or the Monday after when it falls on a weekend. */
export function firstWorkingDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

export function addWorkingDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  for (let left = n; left > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) left--;
  }
  return iso(d);
}

export type PlannedTask = { kind: TaskKind; step: string; title: string; dueDate: string; slot: 'morning' | 'day' | 'evening' };

/**
 * The P1 sequence: everything at once. Day 1 is a call, a WhatsApp, an email and a LinkedIn
 * connection request; then call + WhatsApp + email on each of the next three working days. Every
 * step is planned even without a number or address, so the row shows what is missing.
 */
export function planSequence(startDay: string): PlannedTask[] {
  const d1 = firstWorkingDay(startDay);
  const plan: PlannedTask[] = [];
  const rounds = ['Day 1', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3'];
  rounds.forEach((step, i) => {
    const dueDate = addWorkingDays(d1, i);
    plan.push({ kind: 'call', step, title: `${step}: call`, dueDate, slot: 'day' });
    plan.push({ kind: 'whatsapp', step, title: `${step}: WhatsApp`, dueDate, slot: 'day' });
    plan.push({ kind: 'email', step, title: `${step}: email`, dueDate, slot: 'day' });
    if (i === 0) plan.push({ kind: 'linkedin', step, title: 'Send the LinkedIn connection request', dueDate, slot: 'day' });
  });
  return plan;
}

/** CA firms: their own Today flow (see planCaSequence). */
export const CA_SEGMENT = /\b(ca|chartered|audit|accountant)/i;
export const isCaSegment = (segment: string) => CA_SEGMENT.test(segment);
/** A CA firm's LinkedIn request is out: this step waits for it to be accepted (not a to-do for the day). */
export const CA_WAITING_STEP = 'Request accepted?';
/** A CA firm whose request wasn't accepted (or that has no LinkedIn): reached by call, WhatsApp and email. */
export const CA_FALLBACK_STEP = 'Not accepted on LinkedIn';
/** Marks the steps a CA firm's LinkedIn request (or skipping it) set up, so Undo can take them away. */
export const CA_AFTER_NOTE = 'ca-after:';

/**
 * A CA firm starts with only a LinkedIn connection request. Once it is sent, Today shows "Request
 * accepted" until someone clicks it; not accepted by the next working day, the firm gets a call, a
 * WhatsApp and an email that day (see planCaFallback). Accepted, or all three done: the firm is done.
 */
export function planCaSequence(startDay: string): PlannedTask[] {
  return [{ kind: 'linkedin', step: 'Day 1', title: 'Send the LinkedIn connection request', dueDate: firstWorkingDay(startDay), slot: 'day' }];
}

/** After a CA firm's request: the waiting step (from today) and, if it isn't accepted, the call, WhatsApp and email on `fallbackDay`. */
export function planCaFallback(today: string, fallbackDay: string, waiting: boolean): PlannedTask[] {
  const plan: PlannedTask[] = waiting ? [{ kind: 'linkedin', step: CA_WAITING_STEP, title: 'Waiting for the LinkedIn request to be accepted', dueDate: today, slot: 'day' }] : [];
  for (const [kind, label] of [['call', 'call'], ['whatsapp', 'WhatsApp'], ['email', 'email']] as const) {
    plan.push({ kind, step: CA_FALLBACK_STEP, title: `${CA_FALLBACK_STEP}: ${label}`, dueDate: fallbackDay, slot: 'day' });
  }
  return plan;
}

/** Statuses where the lead is being worked on, so outreach tasks make sense. */
export const WORKING_STATUSES = ['Awaiting Approval', 'Approved', 'Contacted'] as const;
/** Once a lead is here, open sequence tasks stop showing (promised callbacks still do). */
const STOPPED_STATUSES = ['Replied', 'Meeting Booked', 'Won', 'Lost', 'Disqualified', 'Needs Review', 'Rejected', 'Existing Client', 'Error', 'Needs Manual Contact'] as const;
/**
 * Here the day's steps no longer show. A conversation or a meeting still finishes today's steps
 * (moving there already ended the later rounds).
 */
const HIDDEN_STATUSES = STOPPED_STATUSES.filter((s) => s !== 'Replied' && s !== 'Meeting Booked');

/**
 * The steps Today shows: those of a lead being worked; promised callbacks always; and for a lead
 * waiting for a contact, the step to find one. (Used with tasks joined to their lead.)
 */
const SHOWN_ON_TODAY = or(eq(tasks.priority, true), notInArray(leads.status, HIDDEN_STATUSES), and(eq(tasks.step, FIND_NEXT_STEP), eq(leads.status, 'Needs Manual Contact')));

/**
 * Puts every owned lead on its owner's Today list. Safe to call repeatedly.
 * - A lead with a decision-maker and no plan yet gets the P1 sequence (first call, WhatsApp, email and
 *   LinkedIn request on the next working day). So does one whose only open step was finding someone,
 *   now that someone is named (that step is closed).
 * - A lead waiting for a contact (Needs Manual Contact) with nothing planned gets a step to find one:
 *   nobody confirmed at the site yet, or the named person still to be confirmed there.
 */
export async function ensureSequences(db: Db, today = istDay()): Promise<number> {
  const openFind = db
    .select({ one: sql`1` })
    .from(tasks)
    .where(and(eq(tasks.leadId, leads.id), isNull(tasks.doneAt), eq(tasks.step, FIND_NEXT_STEP)));
  const openOther = db
    .select({ one: sql`1` })
    .from(tasks)
    .where(and(eq(tasks.leadId, leads.id), isNull(tasks.doneAt), ne(tasks.step, FIND_NEXT_STEP)));
  const waiting = await db
    .select({ id: leads.id, ownerId: leads.ownerId, segment: leads.segment })
    .from(leads)
    .where(
      and(
        isNotNull(leads.ownerId),
        inArray(leads.status, [...WORKING_STATUSES]),
        ne(leads.contactName, ''),
        or(notExists(db.select({ one: sql`1` }).from(tasks).where(eq(tasks.leadId, leads.id))), and(exists(openFind), notExists(openOther))),
      ),
    )
    .limit(500);
  if (waiting.length) {
    await db
      .update(tasks)
      .set({ doneAt: new Date(), outcome: 'closed' })
      .where(and(inArray(tasks.leadId, waiting.map((l) => l.id)), isNull(tasks.doneAt), eq(tasks.step, FIND_NEXT_STEP)));
  }
  const rows = waiting.flatMap((l) => (isCaSegment(l.segment) ? planCaSequence(today) : planSequence(today)).map((t) => ({ ...t, leadId: l.id, ownerId: l.ownerId! })));
  for (let i = 0; i < rows.length; i += 500) await db.insert(tasks).values(rows.slice(i, i + 500));

  const finding = await db
    .select({ id: leads.id, ownerId: leads.ownerId, contactName: leads.contactName, city: leads.city })
    .from(leads)
    .where(
      and(
        isNotNull(leads.ownerId),
        eq(leads.status, 'Needs Manual Contact'),
        notExists(db.select({ one: sql`1` }).from(tasks).where(and(eq(tasks.leadId, leads.id), isNull(tasks.doneAt)))),
      ),
    )
    .limit(500);
  const due = firstWorkingDay(today);
  const find = finding.map((l) => ({
    leadId: l.id,
    ownerId: l.ownerId!,
    kind: 'call' as const,
    step: FIND_NEXT_STEP,
    title: l.contactName
      ? `Confirm ${l.contactName} is at the ${l.city || 'company\'s'} site, or find the person to contact`
      : 'Find the person to contact (plant head, else a P2 process owner)',
    dueDate: due,
    slot: 'day' as const,
  }));
  for (let i = 0; i < find.length; i += 500) await db.insert(tasks).values(find.slice(i, i + 500));
  return waiting.length + finding.length;
}

/** When the next steps are due after today, and for how many companies: shown when nothing is due today. */
export async function nextDue(db: Db, ownerId: number, today = istDay()): Promise<{ day: string; companies: number } | null> {
  // The same steps Today will show that day, counted by company: never those of a lead that was
  // deleted, set aside, rejected or sent to review.
  const [row] = await db
    .select({ day: sql<string>`min(${tasks.dueDate})` })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(eq(tasks.ownerId, ownerId), isNull(tasks.doneAt), gt(tasks.dueDate, today), SHOWN_ON_TODAY));
  if (!row?.day) return null;
  const [n] = await db
    .select({ n: sql<number>`count(distinct ${tasks.leadId})::int` })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(eq(tasks.ownerId, ownerId), isNull(tasks.doneAt), eq(tasks.dueDate, row.day), SHOWN_ON_TODAY));
  return { day: row.day, companies: Number(n?.n ?? 0) };
}

export type TodayTask = { task: Task; lead: Lead; overdue: boolean };

const SLOT_ORDER = { morning: 0, day: 1, evening: 2 } as const;

/** Open tasks due today or earlier for one person, most urgent first: promised callbacks, then overdue, then by time of day. */
export async function loadTodayTasks(db: Db, ownerId: number, today = istDay(), now = new Date()): Promise<TodayTask[]> {
  const rows = await db
    .select({ task: tasks, lead: leads })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(
      and(
        eq(tasks.ownerId, ownerId),
        isNull(tasks.doneAt),
        lte(tasks.dueDate, today),
        SHOWN_ON_TODAY,
      ),
    );
  return rows
    // A call again set for 5 pm (or 9 am) shows from then.
    .filter((r) => !notYet(r.task, today, now))
    .map((r) => ({ ...r, overdue: r.task.dueDate < today }))
    .sort(
      (a, b) =>
        Number(b.task.priority) - Number(a.task.priority) ||
        a.task.dueDate.localeCompare(b.task.dueDate) ||
        SLOT_ORDER[a.task.slot] - SLOT_ORDER[b.task.slot] ||
        a.task.id - b.task.id,
    );
}

/**
 * A number was actually dialled: connected, no answer, busy or wrong number. "No contact found" (no
 * number to call) and skipped steps are not calls.
 */
export const CALL_ATTEMPT_OUTCOMES = ['connected', 'no_answer', 'busy', 'wrong_number'] as const;
export const isCallAttempt = (outcome: string) => (CALL_ATTEMPT_OUTCOMES as readonly string[]).includes(outcome);

export type DayCounts = { connectedCalls: number; caConnectedCalls: number; callAttempts: number; linkedinSent: number; whatsappSent: number; emailsDone: number };

/** What a person got done on an Indian day. A connected call is a conversation, not an attempt. */
export async function dayCounts(db: Db, ownerId: number, day = istDay()): Promise<DayCounts> {
  const { start, end } = istDayBounds(day);
  const rows = await db
    .select({ kind: tasks.kind, outcome: tasks.outcome, segment: leads.segment })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(eq(tasks.ownerId, ownerId), gte(tasks.doneAt, start), lt(tasks.doneAt, end)));
  const c: DayCounts = { connectedCalls: 0, caConnectedCalls: 0, callAttempts: 0, linkedinSent: 0, whatsappSent: 0, emailsDone: 0 };
  for (const r of rows) {
    if (r.outcome === 'closed') continue;
    if (r.kind === 'call' && isCallAttempt(r.outcome)) {
      c.callAttempts++;
      if (r.outcome === 'connected') {
        c.connectedCalls++;
        if (CA_SEGMENT.test(r.segment)) c.caConnectedCalls++;
      }
    } else if (r.kind === 'linkedin' && r.outcome === 'sent') c.linkedinSent++;
    else if (r.kind === 'whatsapp' && r.outcome === 'sent') c.whatsappSent++;
    else if (r.kind === 'email' && r.outcome === 'done') c.emailsDone++;
  }
  return c;
}

/** What a person did to a lead that counts as someone having looked at it. */
const TOUCH_KINDS = ['note', 'call', 'meeting', 'approved', 'sent', 'stage', 'follow_up_sent'] as const;

/** Inbound leads that nobody has touched for a while. Everyone's when ownerId is null. */
export async function unattendedInbound(db: Db, ownerId: number | null, now = new Date()): Promise<Lead[]> {
  const cutoff = new Date(now.getTime() - UNATTENDED_AFTER_HOURS * 3_600_000);
  return db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.inbound, true),
        ownerId === null ? undefined : eq(leads.ownerId, ownerId),
        lt(leads.createdAt, cutoff),
        // An inbound lead whose fit is still being reviewed asked to hear from us: it still needs a call.
        notInArray(leads.status, [...STOPPED_STATUSES.filter((s) => s !== 'Needs Review'), 'Contacted']),
        notExists(db.select({ one: sql`1` }).from(activities).where(and(eq(activities.leadId, leads.id), inArray(activities.kind, [...TOUCH_KINDS])))),
        notExists(db.select({ one: sql`1` }).from(tasks).where(and(eq(tasks.leadId, leads.id), isNotNull(tasks.doneAt)))),
      ),
    )
    .orderBy(leads.createdAt);
}

/** What a person logged on an Indian day, newest first, so they can see where an item went and undo it. */
export async function loadDoneToday(db: Db, ownerId: number, day = istDay()): Promise<{ task: Task; lead: Lead }[]> {
  const { start, end } = istDayBounds(day);
  return db
    .select({ task: tasks, lead: leads })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(eq(tasks.ownerId, ownerId), gte(tasks.doneAt, start), lt(tasks.doneAt, end), ne(tasks.outcome, 'closed')))
    .orderBy(sql`${tasks.doneAt} desc`, sql`${tasks.id} desc`);
}

/** Open steps due by `day` that show on Today for a lead (callbacks always; the sequence only while the lead is being worked). */
/**
 * A try again set up because a call didn't connect the same day: the 5 pm call after no answer, or the
 * next number after a wrong one. The attempt was made, so these don't keep the company open for the day.
 */
export const isSameDayRetry = (t: Pick<Task, 'note' | 'slot' | 'title'>) =>
  t.note.startsWith('auto-retry:') && (t.slot === 'evening' || t.title === 'Call the next number');

async function openStepsFor(db: Db, leadId: number, day: string): Promise<number> {
  const rows = await db
    .select({ id: tasks.id, note: tasks.note, slot: tasks.slot, title: tasks.title })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt), lte(tasks.dueDate, day), ne(tasks.step, CA_WAITING_STEP), or(eq(tasks.priority, true), notInArray(leads.status, HIDDEN_STATUSES))));
  return rows.filter((r) => !isSameDayRetry(r)).length;
}

/**
 * Someone was actually reached out to: a number dialled, a message or request sent, a request
 * accepted. Not skips, not "No contact found" (nothing to dial).
 */
const REAL_OUTREACH = [...CALL_ATTEMPT_OUTCOMES, 'sent', 'done', 'accepted'] as const;

/** Something was really done for the company that day: a call attempted or a message sent (not only skips). */
async function workedOn(db: Db, leadId: number, day: string): Promise<boolean> {
  const { start, end } = istDayBounds(day);
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.leadId, leadId), gte(tasks.doneAt, start), lt(tasks.doneAt, end), inArray(tasks.outcome, [...REAL_OUTREACH])))
    .limit(1);
  return !!row;
}

/**
 * Records a company as done for the day once every step due for it is ticked off and at least one was
 * really done (a call attempted or a message sent: skipping everything doesn't count), and takes it
 * back off when something is undone or a new step for today appears.
 */
export async function markCompanyDay(db: Db, leadId: number, ownerId: number, day = istDay()): Promise<boolean> {
  const finished = (await openStepsFor(db, leadId, day)) === 0 && (await workedOn(db, leadId, day));
  if (finished) await db.insert(companyDays).values({ leadId, ownerId, day }).onConflictDoNothing();
  else await db.delete(companyDays).where(and(eq(companyDays.leadId, leadId), eq(companyDays.day, day)));
  return finished;
}

/** How many companies on a person's list for the day are fully done. */
export async function companyProgress(db: Db, ownerId: number, day = istDay(), opts: { ca?: boolean } = {}): Promise<{ done: number; total: number; backlog: number }> {
  const [allFinished, allOpen] = await Promise.all([
    db.select({ leadId: companyDays.leadId, segment: leads.segment }).from(companyDays).innerJoin(leads, eq(companyDays.leadId, leads.id)).where(and(eq(companyDays.ownerId, ownerId), eq(companyDays.day, day))),
    loadTodayTasks(db, ownerId, day),
  ]);
  // Only CA firms (ca: true), only the other companies (ca: false), or everything.
  const keep = (segment: string) => opts.ca === undefined || isCaSegment(segment) === opts.ca;
  // Done counts only where someone was actually reached that day (also for days recorded before
  // skips and "No contact found" stopped counting).
  const { start, end } = istDayBounds(day);
  const outreach = await db
    .select({ leadId: tasks.leadId, dueDate: tasks.dueDate })
    .from(tasks)
    .where(and(eq(tasks.ownerId, ownerId), gte(tasks.doneAt, start), lt(tasks.doneAt, end), inArray(tasks.outcome, [...REAL_OUTREACH])));
  const reached = new Set(outreach.map((r) => r.leadId));
  // Backlog: a company whose step was due on an earlier day, done today. Counted apart from today's.
  const late = new Set(outreach.filter((r) => r.dueDate < day).map((r) => r.leadId));
  const doneHere = allFinished.filter((f) => keep(f.segment) && reached.has(f.leadId));
  const backlog = new Set(doneHere.filter((f) => late.has(f.leadId)).map((f) => f.leadId));
  const finished = doneHere.filter((f) => !backlog.has(f.leadId));
  const open = allOpen.filter((o) => keep(o.lead.segment));
  // A CA firm only waiting for its LinkedIn request to be accepted has nothing to do today: it counts
  // only if something was done for it today.
  // Nor does a call-back after a call that didn't connect today: the attempt was made.
  const still = new Set(open.filter((o) => o.task.step !== CA_WAITING_STEP && !isSameDayRetry(o.task)).map((o) => o.lead.id));
  const all = new Set([...finished.map((f) => f.leadId), ...still]);
  return { done: [...all].filter((id) => !still.has(id)).length, total: all.size, backlog: [...backlog].filter((id) => !still.has(id)).length };
}

/** The day is split at 2 pm IST: an unanswered call before it is tried again at 5 pm, one after it at 9 am the next working day. */
export const CALL_AGAIN_SPLIT_HOUR = 14;
export const EVENING_FROM_HOUR = 17;
export const MORNING_FROM_HOUR = 9;

/** The hour in India (0-23). */
export function istHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(d)) % 24;
}

/** When to call again after no answer at `now`: this evening (5 pm) or the next working morning (9 am). */
export function callAgainAt(now = new Date()): { day: string; slot: 'morning' | 'evening' } {
  const today = istDay(now);
  if (firstWorkingDay(today) === today && istHour(now) < CALL_AGAIN_SPLIT_HOUR) return { day: today, slot: 'evening' };
  return { day: nextWorkingDay(today), slot: 'morning' };
}

/** Not on today's list yet: an evening call before 5 pm, a morning call before 9 am (IST). */
function notYet(task: Pick<Task, 'dueDate' | 'slot'>, today: string, now: Date): boolean {
  if (task.dueDate !== today || today !== istDay(now)) return false;
  const hour = istHour(now);
  return (task.slot === 'evening' && hour < EVENING_FROM_HOUR) || (task.slot === 'morning' && hour < MORNING_FROM_HOUR);
}

/** Steps due later today (a 5 pm call again), for the "later today" note on Today. */
export async function laterToday(db: Db, ownerId: number, today = istDay(), now = new Date()): Promise<TodayTask[]> {
  const rows = await db
    .select({ task: tasks, lead: leads })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(eq(tasks.ownerId, ownerId), isNull(tasks.doneAt), eq(tasks.dueDate, today), inArray(tasks.slot, ['morning', 'evening']), SHOWN_ON_TODAY));
  return rows.filter((r) => notYet(r.task, today, now)).map((r) => ({ ...r, overdue: false }));
}

/** The next working day after an Indian date. */
export function nextWorkingDay(day = istDay()): string {
  return addWorkingDays(day, 1);
}
