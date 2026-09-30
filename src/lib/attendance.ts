import { and, between, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { attendance } from './db/schema';
import { istDay } from './tasks';

/** Notes that the person is here today: first time seen, and last time seen (refreshed at most every 5 minutes). */
export async function recordPresence(db: Db, userId: number, now = new Date()) {
  if (!userId) return;
  const day = istDay(now);
  await db
    .insert(attendance)
    .values({ userId, day, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [attendance.userId, attendance.day],
      set: { lastSeenAt: now },
      setWhere: sql`${attendance.lastSeenAt} < ${now.toISOString()}::timestamptz - interval '5 minutes'`,
    });
}

export async function clockIn(db: Db, userId: number, now = new Date()) {
  const day = istDay(now);
  await recordPresence(db, userId, now);
  await db.update(attendance).set({ clockInAt: now, clockOutAt: null }).where(and(eq(attendance.userId, userId), eq(attendance.day, day), sql`${attendance.clockInAt} is null`));
}

export async function clockOut(db: Db, userId: number, now = new Date()) {
  const day = istDay(now);
  await db.update(attendance).set({ clockOutAt: now, lastSeenAt: now }).where(and(eq(attendance.userId, userId), eq(attendance.day, day), sql`${attendance.clockInAt} is not null`));
}

export async function getAttendance(db: Db, userId: number, day: string) {
  const [row] = await db.select().from(attendance).where(and(eq(attendance.userId, userId), eq(attendance.day, day)));
  return row ?? null;
}

/** Everyone's rows between two Indian dates, for the admin dashboard. */
export async function attendanceBetween(db: Db, from: string, to: string) {
  return db.select().from(attendance).where(between(attendance.day, from, to)).orderBy(attendance.day, attendance.userId);
}
