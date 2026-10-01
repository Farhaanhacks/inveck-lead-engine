import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './db';
import { leads, settings, users, type LeadStatus } from './db/schema';
import { getSettings } from './settings';
import { istDay } from './tasks';

/** The draw happens from this hour, India time, so the lists are ready before the team starts. */
export const DRAW_HOUR_IST = 8;

/** Researched and still worth a call: these can be handed out. */
export const DRAWABLE: LeadStatus[] = ['Awaiting Approval', 'Approved', 'Needs Manual Contact', 'Low Score'];

export type DrawRecord = { day: string; at: string; wanted: number; drawn: number; perOwner: Record<string, number>; short: boolean };

const isWeekendDay = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const drawKey = (day: string) => `draw:${day}`;

/** Fisher–Yates; `random` is replaceable so tests can pin it. */
export function shuffle<T>(items: T[], random = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deals shuffled leads one at a time, starting from a random person, so a remainder doesn't always land on the same one. */
export function deal<T>(items: T[], people: number[], random = Math.random): Map<number, T[]> {
  const hands = new Map<number, T[]>(people.map((p) => [p, []]));
  const start = Math.floor(random() * people.length);
  items.forEach((item, i) => hands.get(people[(start + i) % people.length])!.push(item));
  return hands;
}

/** Researched leads nobody has been given yet: what tomorrow's draw can use. */
export async function drawPool(db: Db): Promise<{ total: number; withContact: number }> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int`, withContact: sql<number>`count(*) filter (where ${leads.contactName} <> '')::int` })
    .from(leads)
    .where(and(isNull(leads.ownerId), eq(leads.inbound, false), inArray(leads.status, DRAWABLE)));
  return { total: Number(row?.total ?? 0), withContact: Number(row?.withContact ?? 0) };
}

export async function getDraw(db: Db, day = istDay()): Promise<DrawRecord | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, drawKey(day)));
  return (row?.value as DrawRecord | undefined) ?? null;
}

/** Whether the morning draw is due now: a working day, past the draw hour, and not yet done. */
export function drawDue(now = new Date()): boolean {
  const day = istDay(now);
  const hourIst = new Date(now.getTime() + 5.5 * 3600 * 1000).getUTCHours();
  return !isWeekendDay(day) && hourIst >= DRAW_HOUR_IST;
}

/**
 * The morning draw: picks up to `leadsPerMorning` researched leads that have never been handed out,
 * at random (those with a named decision-maker first), shuffles them and splits them evenly across
 * the active team. Runs once per India day; a second call the same day does nothing (unless
 * the list was empty, so a list filled later in the day still goes out). A lead, once
 * given, has an owner and is never drawn again.
 */
export async function runDailyDraw(db: Db, opts: { now?: Date; force?: boolean; random?: () => number } = {}): Promise<DrawRecord | null> {
  const now = opts.now ?? new Date();
  const day = istDay(now);
  if (!opts.force && !drawDue(now)) return null;
  if (await getDraw(db, day)) return null;

  const { leadsPerMorning } = await getSettings(db);
  const team = await activeTeam(db);
  if (!team.length || leadsPerMorning <= 0) return null;

  // Claim the day first, so two calls at the same moment can't both draw.
  const placeholder: DrawRecord = { day, at: now.toISOString(), wanted: leadsPerMorning, drawn: 0, perOwner: {}, short: false };
  const claimed = await db.insert(settings).values({ key: drawKey(day), value: placeholder }).onConflictDoNothing().returning({ key: settings.key });
  if (!claimed.length) return null;

  const { drawn, perOwner } = await drawInto(db, team, day, leadsPerMorning, now, opts.random ?? Math.random);
  if (!drawn) {
    // Nothing to hand out yet: leave the day open so leads added later still go out today.
    await db.delete(settings).where(eq(settings.key, drawKey(day)));
    return { ...placeholder, short: true };
  }
  const record: DrawRecord = { ...placeholder, drawn, perOwner, short: drawn < leadsPerMorning };
  await db.update(settings).set({ value: record }).where(eq(settings.key, drawKey(day)));
  return record;
}

/** After a short draw, hands out more from the list (up to the day's number) once companies have been added. */
export async function topUpDraw(db: Db, opts: { now?: Date; random?: () => number } = {}): Promise<DrawRecord | null> {
  const now = opts.now ?? new Date();
  const day = istDay(now);
  const current = await getDraw(db, day);
  if (!current?.short) return null;
  const team = await activeTeam(db);
  if (!team.length) return null;
  const { drawn, perOwner } = await drawInto(db, team, day, current.wanted - current.drawn, now, opts.random ?? Math.random);
  if (!drawn) return current;
  const merged = { ...current.perOwner };
  for (const [owner, n] of Object.entries(perOwner)) merged[owner] = (merged[owner] ?? 0) + n;
  const record: DrawRecord = { ...current, drawn: current.drawn + drawn, perOwner: merged, short: current.drawn + drawn < current.wanted };
  await db.update(settings).set({ value: record }).where(eq(settings.key, drawKey(day)));
  return record;
}

async function activeTeam(db: Db): Promise<number[]> {
  return (await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id)).map((u) => u.id);
}

/** Picks `count` leads from the list (those with a named decision-maker first, at random), shuffles them and deals them out. */
async function drawInto(db: Db, team: number[], day: string, count: number, now: Date, random: () => number) {
  const picked = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(isNull(leads.ownerId), eq(leads.inbound, false), inArray(leads.status, DRAWABLE)))
    .orderBy(sql`(${leads.contactName} = '')`, sql`random()`)
    .limit(count);
  const hands = deal(shuffle(picked.map((p) => p.id), random), team, random);
  const perOwner: Record<string, number> = {};
  let drawn = 0;
  for (const [owner, ids] of hands) {
    if (!ids.length) continue;
    // Only leads still without an owner: a lead added by hand meanwhile keeps its person.
    const given = await db
      .update(leads)
      .set({ ownerId: owner, drawnOn: day, updatedAt: now })
      .where(and(inArray(leads.id, ids), isNull(leads.ownerId)))
      .returning({ id: leads.id });
    perOwner[owner] = given.length;
    drawn += given.length;
  }
  return { drawn, perOwner };
}
