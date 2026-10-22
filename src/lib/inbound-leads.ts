import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { activities, inboundDemoRows, leadMeetings, leads, users, type Lead, type LeadMeeting } from './db/schema';
import { logActivity } from './activity';

/**
 * The Inbound leads section (administrators): leads imported from the website demo sheet, kept apart from prospecting
 * leads. Everything here is read from what the sheet said, which is kept as it came (source and UTM columns included).
 */
export type InboundSource = 'website' | 'linkedin';
export const SOURCE_LABEL: Record<InboundSource, string> = { website: 'Website', linkedin: 'LinkedIn' };

/**
 * Website or LinkedIn, from the sheet's own source and UTM fields: LinkedIn when the UTM source or medium, the
 * campaign, the "source" answer or a LinkedIn click id says so; everything else came through the website. The original
 * values stay on the row (shown on the lead), so the call can be reviewed.
 */
export function sourceKind(raw: Record<string, string>): InboundSource {
  const says = [raw.utm_source, raw.utm_medium, raw.utm_campaign, raw.source, raw.referrer].some((v) => /linkedin|lnkd\.in/i.test(v ?? ''));
  return says || (raw.li_fat_id ?? '').trim() ? 'linkedin' : 'website';
}

const IST_MS = 330 * 60_000;
/** The calendar month (India) a date falls in: 2026-10. */
export const monthKey = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 7);
export const monthLabel = (key: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${key}-15T12:00:00Z`));
export const validMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export type InboundRow = {
  id: number; // the lead's id
  lead: Lead;
  raw: Record<string, string>;
  source: InboundSource;
  registeredAt: Date;
  month: string;
  bda: string;
  meeting: LeadMeeting | null;
  responses: number;
  lastResponseAt: Date | null;
};

/** Every inbound lead (one per person), newest registration first. Filters are applied by `filterRows`. */
export async function loadInbound(db: Db): Promise<InboundRow[]> {
  const ledger = await db
    .select({ row: inboundDemoRows, lead: leads })
    .from(inboundDemoRows)
    .innerJoin(leads, eq(inboundDemoRows.leadId, leads.id))
    .where(inArray(inboundDemoRows.state, ['imported', 'meeting']))
    .orderBy(desc(inboundDemoRows.id));
  if (!ledger.length) return [];
  const ids = ledger.map((r) => r.lead.id);
  const [people, meetings, responses] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users),
    db.select().from(leadMeetings).where(and(inArray(leadMeetings.leadId, ids), eq(leadMeetings.status, 'scheduled'))).orderBy(leadMeetings.startsAt),
    db
      .select({ leadId: activities.leadId, n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${activities.at})` })
      .from(activities)
      .where(and(inArray(activities.leadId, ids), eq(activities.kind, 'response')))
      .groupBy(activities.leadId),
  ]);
  const names = new Map(people.map((u) => [u.id, u.name]));
  const meetingOf = new Map<number, LeadMeeting>();
  for (const m of meetings) meetingOf.set(m.leadId, m);
  const respOf = new Map(responses.map((r) => [r.leadId, r]));
  const seen = new Set<number>();
  const out: InboundRow[] = [];
  for (const { row, lead } of ledger) {
    if (seen.has(lead.id)) continue;
    seen.add(lead.id);
    const registeredAt = row.submittedAt ?? row.createdAt;
    const resp = respOf.get(lead.id);
    out.push({
      id: lead.id,
      lead,
      raw: row.raw,
      source: sourceKind(row.raw),
      registeredAt,
      month: monthKey(registeredAt),
      bda: lead.ownerId ? (names.get(lead.ownerId) ?? '') : '',
      meeting: meetingOf.get(lead.id) ?? null,
      responses: resp ? Number(resp.n) : 0,
      lastResponseAt: resp?.last ? new Date(resp.last) : null,
    });
  }
  return out.sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime());
}

export type InboundFilters = { source?: InboundSource | ''; month?: string };
/** Both filters together: a source (All = none) and one calendar month of registration. */
export const filterRows = (rows: InboundRow[], f: InboundFilters) => rows.filter((r) => (!f.source || r.source === f.source) && (!f.month || r.month === f.month));

/** The overview cards, counted from the rows given (so they follow the filters). */
export function inboundCounts(rows: InboundRow[]) {
  return {
    total: rows.length,
    website: rows.filter((r) => r.source === 'website').length,
    linkedin: rows.filter((r) => r.source === 'linkedin').length,
    meetings: rows.filter((r) => !!r.meeting).length,
    responded: rows.filter((r) => r.responses > 0).length,
  };
}

/** The months with inbound leads, newest first (for the Month filter). */
export const monthsOf = (rows: InboundRow[]) => [...new Set(rows.map((r) => r.month))].sort().reverse();

/** What the section calls a lead's state: the meeting is what makes it scheduled. */
export function statusLabel(r: InboundRow): string {
  if (r.lead.status === 'Won') return 'Won';
  if (r.lead.status === 'Lost') return 'Lost';
  if (r.meeting) return 'Meeting scheduled';
  return r.lead.status === 'Contacted' ? 'Contacted' : 'Awaiting meeting';
}

export const RESPONSE_KINDS = ['response', 'follow_up_sent', 'note'] as const;
export const RESPONSE_LABEL: Record<(typeof RESPONSE_KINDS)[number], string> = { response: 'Response received', follow_up_sent: 'Follow-up sent', note: 'Note' };
export const INBOUND_STATUSES = ['Replied', 'Contacted', 'Won', 'Lost'] as const;

/** Logs a response, a follow-up or a note against an inbound lead (its history). */
export async function logInboundActivity(db: Db, leadId: number, kind: string, text: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(RESPONSE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'Choose what happened.' };
  const t = text.trim();
  if (!t) return { ok: false, error: 'Write what happened.' };
  if (t.length > 2000) return { ok: false, error: 'Keep it to 2,000 characters or fewer.' };
  const isInbound = (await db.select({ id: inboundDemoRows.id }).from(inboundDemoRows).where(eq(inboundDemoRows.leadId, leadId)).limit(1)).length > 0;
  if (!isInbound) return { ok: false, error: 'That is not an inbound lead.' };
  await logActivity(db, leadId, kind as 'response' | 'follow_up_sent' | 'note', `${t} (${by})`);
  return { ok: true };
}

/** Sets where an inbound lead stands after the meeting. Meeting Booked is only ever set by a real meeting. */
export async function setInboundStatus(db: Db, leadId: number, status: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(INBOUND_STATUSES as readonly string[]).includes(status)) return { ok: false, error: 'Choose one of the statuses.' };
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || (await db.select({ id: inboundDemoRows.id }).from(inboundDemoRows).where(eq(inboundDemoRows.leadId, leadId)).limit(1)).length === 0) return { ok: false, error: 'That is not an inbound lead.' };
  if (lead.status === status) return { ok: true };
  await db.update(leads).set({ status: status as (typeof INBOUND_STATUSES)[number], updatedAt: new Date() }).where(eq(leads.id, leadId));
  await logActivity(db, leadId, 'stage', `Status changed from ${lead.status} to ${status} by ${by}`, status);
  return { ok: true };
}
