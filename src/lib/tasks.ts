import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { activities, leads, tasks, type Lead, type Task, type TaskKind } from './db/schema';

export const DAILY_LINKEDIN_LIMIT = 50;
/** After this many unanswered calls to one person, stop the automatic call-again reminders: try the next person (P2). */
export const MAX_CALL_ATTEMPTS = 5;
/** Calls each person should attempt in a day. */
export const DAILY_CALL_TARGET = 25;
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
 * The P1 sequence from the sales SOP: on day 1 a WhatsApp introduction and the first call in the
 * morning; then call + WhatsApp + email on the evening of day 1, on day 2 and on day 3. Emails are
 * only planned when there is an address. LinkedIn is used to find the contact, not as a step.
 */
export function planSequence(startDay: string, hasEmail: boolean): PlannedTask[] {
  const d1 = firstWorkingDay(startDay);
  const d2 = addWorkingDays(d1, 1);
  const d3 = addWorkingDays(d1, 2);
  const plan: PlannedTask[] = [
    { kind: 'whatsapp', step: 'Day 1', title: 'Send the WhatsApp introduction', dueDate: d1, slot: 'morning' },
    { kind: 'call', step: 'Day 1 morning', title: 'Call 1', dueDate: d1, slot: 'morning' },
  ];
  const rounds: [string, string, PlannedTask['slot']][] = [
    ['Follow-up 1', d1, 'evening'],
    ['Follow-up 2', d2, 'day'],
    ['Follow-up 3', d3, 'day'],
  ];
  for (const [step, dueDate, slot] of rounds) {
    plan.push({ kind: 'call', step, title: `${step}: call`, dueDate, slot });
    plan.push({ kind: 'whatsapp', step, title: `${step}: WhatsApp`, dueDate, slot });
    if (hasEmail) plan.push({ kind: 'email', step, title: `${step}: email`, dueDate, slot });
  }
  return plan;
}

/** Statuses where the lead is being worked on, so outreach tasks make sense. */
export const WORKING_STATUSES = ['Awaiting Approval', 'Approved', 'Contacted'] as const;
/** Once a lead is here, open sequence tasks stop showing (promised callbacks still do). */
const STOPPED_STATUSES = ['Replied', 'Meeting Booked', 'Won', 'Lost', 'Disqualified', 'Rejected', 'Existing Client', 'Error', 'Needs Manual Contact'] as const;

/** Plans the P1 sequence for every owned lead with a decision-maker that has none yet. Safe to call repeatedly. */
export async function ensureSequences(db: Db, today = istDay()): Promise<number> {
  const waiting = await db
    .select({ id: leads.id, ownerId: leads.ownerId, contactEmail: leads.contactEmail })
    .from(leads)
    .where(
      and(
        isNotNull(leads.ownerId),
        inArray(leads.status, [...WORKING_STATUSES]),
        ne(leads.contactName, ''),
        notExists(db.select({ one: sql`1` }).from(tasks).where(eq(tasks.leadId, leads.id))),
      ),
    )
    .limit(500);
  const rows = waiting.flatMap((l) => planSequence(today, !!l.contactEmail).map((t) => ({ ...t, leadId: l.id, ownerId: l.ownerId! })));
  for (let i = 0; i < rows.length; i += 500) await db.insert(tasks).values(rows.slice(i, i + 500));
  return waiting.length;
}

export type TodayTask = { task: Task; lead: Lead; overdue: boolean };

const SLOT_ORDER = { morning: 0, day: 1, evening: 2 } as const;

/** Open tasks due today or earlier for one person, most urgent first: promised callbacks, then overdue, then by time of day. */
export async function loadTodayTasks(db: Db, ownerId: number, today = istDay()): Promise<TodayTask[]> {
  const rows = await db
    .select({ task: tasks, lead: leads })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(
      and(
        eq(tasks.ownerId, ownerId),
        isNull(tasks.doneAt),
        lte(tasks.dueDate, today),
        or(eq(tasks.priority, true), notInArray(leads.status, [...STOPPED_STATUSES])),
      ),
    );
  return rows
    .map((r) => ({ ...r, overdue: r.task.dueDate < today }))
    .sort(
      (a, b) =>
        Number(b.task.priority) - Number(a.task.priority) ||
        a.task.dueDate.localeCompare(b.task.dueDate) ||
        SLOT_ORDER[a.task.slot] - SLOT_ORDER[b.task.slot] ||
        a.task.id - b.task.id,
    );
}

export type DayCounts = { connectedCalls: number; caConnectedCalls: number; callAttempts: number; linkedinSent: number; whatsappSent: number; emailsDone: number };

const CA_SEGMENT = /\b(ca|chartered|audit|accountant)/i;

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
    if (r.kind === 'call' && r.outcome !== 'skipped') {
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
        notInArray(leads.status, [...STOPPED_STATUSES, 'Contacted']),
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

/** The next working day after an Indian date. */
export function nextWorkingDay(day = istDay()): string {
  return addWorkingDays(day, 1);
}
