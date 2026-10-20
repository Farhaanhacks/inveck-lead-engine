import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { leads, settings, users, type Lead, type LeadStatus } from './db/schema';
import { LOGISTICS, MANUFACTURING } from './db/seed';
import { normSegment } from './icp-match';
import { getSettings, type Settings } from './settings';
import { getHolidays } from './holidays';
import { istDay } from './tasks';

/** The draw happens from this hour, India time, so the lists are ready before the team starts. */
export const DRAW_HOUR_IST = 8;

/** Researched and still worth a call: these can be handed out. */
export const DRAWABLE: LeadStatus[] = ['Approved', 'Low Score'];

/**
 * The segments the morning draw hands out, each with its own quota per associate: their own numbers (Team
 * page: Anchal and Puja 40 Manufacturing, Parimal and Anuradha 24 Manufacturing + 16 3PL), else the
 * Settings numbers. Every other segment, CA firms included, is left out of the draw, and never fills a
 * shortfall in these two.
 */
export const DRAW_SEGMENTS = [MANUFACTURING, LOGISTICS] as const;
export type DrawSegment = (typeof DRAW_SEGMENTS)[number];
export type Quota = Record<DrawSegment, number>;

/** The daily quota per segment from Settings: for an associate without their own numbers. */
export const quotaOf = (s: Pick<Settings, 'manufacturingPerAssociate' | 'logisticsPerAssociate'>): Quota => ({
  [MANUFACTURING]: s.manufacturingPerAssociate,
  [LOGISTICS]: s.logisticsPerAssociate,
});
export const quotaTotal = (q: Quota) => q[MANUFACTURING] + q[LOGISTICS];

/** Every active associate's daily quota, by id: their own numbers (Team page), else the Settings ones. */
export type Quotas = Map<number, Quota>;

export async function teamQuotas(db: Db, s?: Pick<Settings, 'manufacturingPerAssociate' | 'logisticsPerAssociate'>): Promise<Quotas> {
  const fallback = quotaOf(s ?? (await getSettings(db)));
  const rows = await db
    .select({ id: users.id, m: users.drawManufacturing, l: users.drawLogistics })
    .from(users)
    .where(and(eq(users.role, 'bda'), eq(users.active, true)))
    .orderBy(users.id);
  return new Map(rows.map((r) => [r.id, { [MANUFACTURING]: r.m ?? fallback[MANUFACTURING], [LOGISTICS]: r.l ?? fallback[LOGISTICS] }]));
}

/** The whole team's quota, per segment. */
export function teamTotal(quotas: Quotas): Quota {
  const out = emptyHand();
  for (const q of quotas.values()) for (const s of DRAW_SEGMENTS) out[s] += q[s];
  return out;
}

const asRecord = (q: Quotas): Record<string, Quota> => Object.fromEntries([...q].map(([id, v]) => [String(id), v]));
const fromRecord = (r: Record<string, Quota>): Quotas => new Map(Object.entries(r).map(([id, v]) => [Number(id), v]));

/** A lead's segment as the draw compares it: same as normSegment, in SQL ("3PL & Logistics" is "3pl and logistics"). */
const segmentKey = sql`btrim(regexp_replace(replace(lower(${leads.segment}), '&', ' and '), '[^a-z0-9]+', ' ', 'g'))`;

/**
 * The release gate: only a researched company that qualified, with a main contact who is confirmed (a
 * LinkedIn profile at this company, or entered by the team). Never a company with nobody to contact; a lead
 * whose contact isn't confirmed waits until it is.
 */
const RELEASABLE = and(eq(leads.qualified, true), ne(leads.contactName, ''), isNotNull(leads.contactVerifiedAt));
const inPool = (segment?: DrawSegment) =>
  and(
    isNull(leads.ownerId),
    eq(leads.inbound, false),
    eq(leads.refetchPending, false),
    inArray(leads.status, DRAWABLE),
    RELEASABLE,
    segment ? sql`${segmentKey} = ${normSegment(segment)}` : or(...DRAW_SEGMENTS.map((s) => sql`${segmentKey} = ${normSegment(s)}`)),
  );

/** Handed out per associate (by id) and segment on one day. */
export type Hands = Record<string, Record<DrawSegment, number>>;

export type DrawRecord = {
  day: string;
  at: string;
  /** Team-wide: every active associate's quota added up. */
  wanted: number;
  drawn: number;
  perOwner: Record<string, number>;
  short: boolean;
  /** The quota per segment when the draw ran (the Settings one; each associate's own is in quotas), and what each got. Absent on draws from before segments. */
  quota?: Quota;
  /** Each associate's own quota when the draw ran, by id. Absent on draws from before per-person quotas. */
  quotas?: Record<string, Quota>;
  perOwnerSegment?: Hands;
};

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

/**
 * Deals leads one at a time round the associates who are still short, from a random start, never giving
 * anyone more than they are short by. With too few leads, the associates end up within one lead of each other.
 */
export function dealToDeficits<T>(items: T[], deficits: Map<number, number>, random = Math.random): Map<number, T[]> {
  const owners = [...deficits.keys()];
  const hands = new Map<number, T[]>(owners.map((o) => [o, []]));
  if (!owners.length) return hands;
  let at = Math.floor(random() * owners.length);
  let next = 0;
  for (let idle = 0; next < items.length && idle < owners.length; at++) {
    const o = owners[at % owners.length];
    if (hands.get(o)!.length < (deficits.get(o) ?? 0)) {
      hands.get(o)!.push(items[next++]);
      idle = 0;
    } else idle++;
  }
  return hands;
}

const emptyHand = (): Record<DrawSegment, number> => ({ [MANUFACTURING]: 0, [LOGISTICS]: 0 });

/** What each associate has been handed on a day, by segment (counted from the leads themselves). */
export async function handedOut(db: Db, day: string): Promise<Hands> {
  const rows = await db
    .select({ owner: leads.ownerId, key: segmentKey, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.drawnOn, day), isNotNull(leads.ownerId)))
    .groupBy(leads.ownerId, segmentKey);
  const out: Hands = {};
  for (const r of rows) {
    const seg = DRAW_SEGMENTS.find((s) => normSegment(s) === r.key);
    if (!seg) continue;
    (out[String(r.owner)] ??= emptyHand())[seg] += Number(r.n);
  }
  return out;
}

/** One associate's day: leads handed out in the draw, in total and by segment, for the Today counter. */
export async function allocationFor(db: Db, ownerId: number, day = istDay()): Promise<{ total: number; bySegment: Record<DrawSegment, number> }> {
  const hand = (await handedOut(db, day))[String(ownerId)] ?? emptyHand();
  return { total: hand[MANUFACTURING] + hand[LOGISTICS], bySegment: hand };
}

/** Researched leads nobody has been given yet that the draw can use, in total and by segment. */
export async function drawPool(db: Db): Promise<{ total: number; withContact: number; bySegment: Record<DrawSegment, number> }> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int`, withContact: sql<number>`count(*) filter (where ${leads.contactName} <> '')::int` })
    .from(leads)
    .where(inPool());
  const bySegment = emptyHand();
  for (const s of DRAW_SEGMENTS) {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(inPool(s));
    bySegment[s] = Number(r?.n ?? 0);
  }
  return { total: Number(row?.total ?? 0), withContact: Number(row?.withContact ?? 0), bySegment };
}

/** Leads the draw would pick from in a segment, as it picks them: those with a named contact first, at random. */
export async function poolLeads(db: Db, segment: DrawSegment, limit: number): Promise<Lead[]> {
  if (limit <= 0) return [];
  return db.select().from(leads).where(inPool(segment)).orderBy(sql`(${leads.contactName} = '')`, sql`random()`).limit(limit);
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

/** What each associate is still short by, per segment, and in all. */
export function shortfalls(quotas: Quotas, hands: Hands): { owner: number; segment: DrawSegment; short: number }[] {
  return [...quotas]
    .flatMap(([owner, quota]) => DRAW_SEGMENTS.map((segment) => ({ owner, segment, short: Math.max(0, quota[segment] - (hands[String(owner)]?.[segment] ?? 0)) })))
    .filter((s) => s.short > 0);
}

async function record(db: Db, quotas: Quotas, quota: Quota, base: Pick<DrawRecord, 'day' | 'at'>): Promise<DrawRecord> {
  const hands = await handedOut(db, base.day);
  const perOwner: Record<string, number> = {};
  const perOwnerSegment: Hands = {};
  for (const o of quotas.keys()) {
    const h = hands[String(o)] ?? emptyHand();
    perOwnerSegment[String(o)] = h;
    perOwner[String(o)] = h[MANUFACTURING] + h[LOGISTICS];
  }
  const drawn = Object.values(perOwner).reduce((a, b) => a + b, 0);
  return { ...base, wanted: quotaTotal(teamTotal(quotas)), drawn, perOwner, short: shortfalls(quotas, hands).length > 0, quota, quotas: asRecord(quotas), perOwnerSegment };
}

/**
 * The morning draw. Every active associate is given their quota in each segment (their own numbers, else
 * the Settings ones: 12 Manufacturing and 8 3PL & Logistics), drawn per segment from the researched,
 * releasable leads nobody has been given yet, so nobody gets the wrong mix and a shortage in one segment
 * is never filled from another (or from CA firms). Leads are picked at random, shuffled and dealt round
 * the team. Runs once per India day; a second call the same day does nothing (unless the list was empty,
 * so a list filled later in the day still goes out). A lead, once given, has an owner and is never drawn again.
 */
export async function runDailyDraw(db: Db, opts: { now?: Date; force?: boolean; random?: () => number } = {}): Promise<DrawRecord | null> {
  const now = opts.now ?? new Date();
  const day = istDay(now);
  if (!opts.force && !drawDue(now)) return null;
  // No draw on a holiday marked in Settings: nobody is working.
  if (!opts.force && (await getHolidays(db)).has(day)) return null;
  if (await getDraw(db, day)) return null;

  const settingsNow = await getSettings(db);
  const quota = quotaOf(settingsNow);
  const quotas = await teamQuotas(db, settingsNow);
  const wanted = quotaTotal(teamTotal(quotas));
  if (!quotas.size || wanted <= 0) return null;

  // Claim the day first, so two calls at the same moment can't both draw.
  const placeholder: DrawRecord = { day, at: now.toISOString(), wanted, drawn: 0, perOwner: {}, short: false };
  const claimed = await db.insert(settings).values({ key: drawKey(day), value: placeholder }).onConflictDoNothing().returning({ key: settings.key });
  if (!claimed.length) return null;

  const drawn = await drawInto(db, quotas, day, now, opts.random ?? Math.random);
  if (!drawn) {
    // Nothing to hand out yet: leave the day open so leads added later still go out today.
    await db.delete(settings).where(eq(settings.key, drawKey(day)));
    return { ...placeholder, short: true, quota, quotas: asRecord(quotas) };
  }
  const full = await record(db, quotas, quota, { day, at: now.toISOString() });
  await db.update(settings).set({ value: full }).where(eq(settings.key, drawKey(day)));
  return full;
}

/** After a short draw, hands out more once leads are available, filling each associate's missing segment quotas. */
export async function topUpDraw(db: Db, opts: { now?: Date; random?: () => number } = {}): Promise<DrawRecord | null> {
  const now = opts.now ?? new Date();
  const day = istDay(now);
  const current = await getDraw(db, day);
  if (!current?.short) return null;
  // The quotas the day's draw ran with (a draw from before per-person quotas: each associate's now).
  const quotas = current.quotas ? fromRecord(current.quotas) : await teamQuotas(db);
  if (!quotas.size) return null;
  const quota = current.quota ?? quotaOf(await getSettings(db));
  if (!(await drawInto(db, quotas, day, now, opts.random ?? Math.random))) return current;
  const full = await record(db, quotas, quota, { day: current.day, at: current.at });
  await db.update(settings).set({ value: full }).where(eq(settings.key, drawKey(day)));
  return full;
}

export async function activeTeam(db: Db): Promise<number[]> {
  return (await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id)).map((u) => u.id);
}

/**
 * For each segment: works out what each associate is still short by (quota minus what they already got
 * today), picks that many leads at random (those with a named decision-maker first), and deals them to
 * the associates who are short. Returns how many leads were handed out.
 */
async function drawInto(db: Db, quotas: Quotas, day: string, now: Date, random: () => number): Promise<number> {
  const hands = await handedOut(db, day);
  let drawn = 0;
  for (const segment of DRAW_SEGMENTS) {
    const deficits = new Map([...quotas].map(([o, quota]) => [o, Math.max(0, quota[segment] - (hands[String(o)]?.[segment] ?? 0))] as const).filter(([, n]) => n > 0));
    const need = [...deficits.values()].reduce((a, b) => a + b, 0);
    if (!need) continue;
    const picked = await db
      .select({ id: leads.id })
      .from(leads)
      .where(inPool(segment))
      .orderBy(sql`(${leads.contactName} = '')`, sql`random()`)
      .limit(need);
    for (const [owner, ids] of dealToDeficits(shuffle(picked.map((p) => p.id), random), deficits, random)) {
      if (!ids.length) continue;
      // Only leads still without an owner: a lead added by hand meanwhile keeps its person.
      const given = await db.update(leads).set({ ownerId: owner, drawnOn: day, updatedAt: now }).where(and(inArray(leads.id, ids), isNull(leads.ownerId))).returning({ id: leads.id });
      drawn += given.length;
    }
  }
  return drawn;
}
