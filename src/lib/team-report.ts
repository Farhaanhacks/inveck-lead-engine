import { and, eq, gte, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import type { Db } from './db';
import { activities, attendance, leads, tasks, users } from './db/schema';
import { istDay, istDayBounds } from './tasks';

export type Period = 'today' | 'yesterday' | 'week' | 'month';
export const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
];

/** The Indian dates a period covers, first and last. */
export function periodDays(p: Period, today = istDay()): { from: string; to: string } {
  const back = (n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  if (p === 'yesterday') return { from: back(1), to: back(1) };
  if (p === 'week') return { from: back(6), to: today };
  if (p === 'month') return { from: back(29), to: today };
  return { from: today, to: today };
}

export type PersonReport = {
  id: number;
  name: string;
  leadsOwned: number;
  callAttempts: number;
  connected: number;
  emails: number;
  whatsapp: number;
  meetings: number;
  won: number;
  /** Connected calls per attempt, 0-100. */
  connectRate: number | null;
  /** Meetings booked per connected call, 0-100. */
  meetingRate: number | null;
  daysPresent: number;
  /** Total clocked time in minutes (days with both a clock-in and a clock-out). */
  minutesClocked: number;
};

export type AttendanceRow = {
  name: string;
  day: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  clockInAt: Date | null;
  clockOutAt: Date | null;
};

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

/** Each team member's work, outcomes and attendance over a range of Indian dates. */
export async function teamReport(db: Db, from: string, to: string): Promise<{ people: PersonReport[]; attendance: AttendanceRow[] }> {
  const start = istDayBounds(from).start;
  const end = istDayBounds(to).end;
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id);
  const ids = team.map((t) => t.id);
  if (!ids.length) return { people: [], attendance: [] };

  const [done, owned, stages, att] = await Promise.all([
    db
      .select({ ownerId: tasks.ownerId, kind: tasks.kind, outcome: tasks.outcome })
      .from(tasks)
      .where(and(inArray(tasks.ownerId, ids), isNotNull(tasks.doneAt), gte(tasks.doneAt, start), lt(tasks.doneAt, end))),
    db.select({ ownerId: leads.ownerId }).from(leads).where(inArray(leads.ownerId, ids)),
    db
      .select({ ownerId: leads.ownerId, stage: activities.stage })
      .from(activities)
      .innerJoin(leads, eq(activities.leadId, leads.id))
      .where(and(inArray(leads.ownerId, ids), eq(activities.kind, 'stage'), inArray(activities.stage, ['Meeting Booked', 'Won']), gte(activities.at, start), lt(activities.at, end))),
    db.select().from(attendance).where(and(inArray(attendance.userId, ids), gte(attendance.day, from), lte(attendance.day, to))),
  ]);

  const people = team.map((t): PersonReport => {
    const mine = done.filter((d) => d.ownerId === t.id && d.outcome !== 'closed' && d.outcome !== 'skipped');
    const callAttempts = mine.filter((d) => d.kind === 'call').length;
    const connected = mine.filter((d) => d.kind === 'call' && d.outcome === 'connected').length;
    const meetings = stages.filter((s) => s.ownerId === t.id && s.stage === 'Meeting Booked').length;
    const days = att.filter((a) => a.userId === t.id);
    return {
      id: t.id,
      name: t.name,
      leadsOwned: owned.filter((o) => o.ownerId === t.id).length,
      callAttempts,
      connected,
      emails: mine.filter((d) => d.kind === 'email').length,
      whatsapp: mine.filter((d) => d.kind === 'whatsapp').length,
      meetings,
      won: stages.filter((s) => s.ownerId === t.id && s.stage === 'Won').length,
      connectRate: pct(connected, callAttempts),
      meetingRate: pct(meetings, connected),
      daysPresent: days.length,
      minutesClocked: days.reduce((m, a) => m + (a.clockInAt && a.clockOutAt ? Math.max(0, (a.clockOutAt.getTime() - a.clockInAt.getTime()) / 60000) : 0), 0),
    };
  });

  const names = new Map(team.map((t) => [t.id, t.name]));
  const rows = att
    .map((a) => ({ name: names.get(a.userId) ?? '', day: a.day, firstSeenAt: a.firstSeenAt, lastSeenAt: a.lastSeenAt, clockInAt: a.clockInAt, clockOutAt: a.clockOutAt }))
    .sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name));
  return { people, attendance: rows };
}
