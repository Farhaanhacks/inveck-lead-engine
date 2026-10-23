import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from './db';
import { inboundDemoRows, leadMeetings, leads, people, settings, users, type InboundDemoRow, type Lead } from './db/schema';
import { logActivity } from './activity';
import { googleCredentials, readTab } from './google-sheet';
import { defaultMeetingTitle, scheduleMeeting } from './meetings';
import { cleanPhone } from './tracker';
import { stampNewLead } from './config';

/**
 * Inbound demo requests from the website form's Google Sheet (read-only, with the same service account as the CA firms
 * sheet). These are people who asked for a demo, not cold prospects: nothing is researched, no cold-call steps are
 * planned. Each new row becomes a lead for the next BDA in a fixed rotation, and, when the sheet gives a confirmed meeting
 * time, a Teams meeting in that BDA's calendar. A row without one is never given an invented slot: it is reported.
 */
export const INBOUND_SHEET_ID = '1_QU1mQsOrgavxGU7Xmo8XsZdVr8Bhneo4Ojudsn-bD4';
export const INBOUND_SHEET_TAB = 'Leads';
/** The rotation, in order, repeating (matched to existing BDA users by first name). */
export const ROTATION = ['Puja', 'Anuradha', 'Parimal', 'Anchal'] as const;
/** First names a rotation name is found under in the CRM (a spelling variant of the same person, nothing else). */
const ALIASES: Record<(typeof ROTATION)[number], string[]> = { Puja: ['puja', 'pooja'], Anuradha: ['anuradha'], Parimal: ['parimal'], Anchal: ['anchal', 'aanchal'] };
import { INBOUND_SOURCE } from './inbound-source';
export { INBOUND_SOURCE };
const CURSOR_KEY = 'inboundDemoCursor';
const REPORT_KEY = 'inboundDemoSync';
const LOCK_KEY = 'inboundDemoLock';
// A sync takes seconds; if one is cut off (a timeout), the next may start after this long.
const LOCK_MS = 90_000;
const IST_MS = 330 * 60_000;

// ─── Reading the sheet ───

export type SheetRow = { sheetRow: number; cells: Record<string, string> };

/** The rows under the headers, each as header to value. Headers are read as they are; nothing is assumed about their order. */
export function parseSheet(values: string[][]): { headers: string[]; rows: SheetRow[]; error: string } {
  const [head, ...body] = values;
  const headers = (head ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (!headers.length || !headers.includes('email')) return { headers, rows: [], error: 'The sheet has no "email" column, so nothing was read. Check the tab name.' };
  const rows = body
    .map((r, i): SheetRow => ({ sheetRow: i + 2, cells: Object.fromEntries(headers.map((h, c) => [h, (r[c] ?? '').trim()]).filter(([h]) => h)) }))
    .filter((r) => Object.values(r.cells).some(Boolean));
  return { headers, rows, error: '' };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Text a spreadsheet would run as a formula, or a test row: never a lead. */
const formulaLike = (v: string) => /^[=+\-@]/.test(v.trim());

export function rowProblem(c: Record<string, string>): string {
  if ([c.name, c.company].some((v) => v && formulaLike(v))) return 'Looks like a spreadsheet formula, not a person or company';
  if (/\(ignore\)/i.test(`${c.name} ${c.company}`)) return 'Marked (ignore) in the sheet';
  if (!c.name?.trim()) return 'No contact name';
  if (!c.email || !EMAIL.test(c.email.trim())) return 'No valid email address';
  return '';
}

/**
 * The row's key: the booking id the form gives when there is one (a row for the same booking is never two), else who
 * submitted, when, and which form (rows from before booking ids). Identical re-submissions are one.
 */
export const rowKeyOf = (c: Record<string, string>) =>
  createHash('sha256')
    .update(c.booking_id?.trim() ? `booking|${c.booking_id.trim()}` : [c.submitted_at || c.received_at || '', (c.email ?? '').trim().toLowerCase(), (c.kind ?? '').trim().toLowerCase()].join('|'))
    .digest('hex')
    .slice(0, 32);

export const segmentOf = (persona: string) => {
  const p = persona.toLowerCase();
  if (/manufactur/.test(p)) return 'Manufacturing';
  if (/3pl|logistic|warehous/.test(p)) return '3PL & Logistics';
  if (/\bca\b|chartered|audit|account/.test(p)) return 'CA Firms';
  return '';
};

// ─── The meeting time ───

export type Slot = { kind: 'confirmed'; date: string; time: string } | { kind: 'preferred'; text: string } | { kind: 'unreadable'; text: string } | { kind: 'none' };

const CONFIRMED = /(^|_)(confirmed|booked|booking|meeting|demo|scheduled|slot|appointment)_?(date|time|at|start|datetime|slot)?$/;
const PREFERRED = /(preferred|requested|choice|option|availability|suggested)/;
const IGNORED = new Set(['submitted_at', 'received_at', 'kind', 'persona', 'page', 'landing', 'booking_id', 'status', 'timezone', 'preferred_start_utc', 'preferred_start_ist']);

const ist = (d: Date) => new Date(d.getTime() + IST_MS).toISOString();

/** A date and optional time as the sheet may write them (ISO with or without a zone, d/m/yyyy), as India's date and HH:MM. */
export function parseWhen(dateText: string, timeText = ''): { date: string; time: string } | null {
  const d = dateText.trim();
  const t = timeText.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(d))) {
    if (!m[3]) return { date: m[1], time: m[2] };
    const at = new Date(`${m[1]}T${m[2]}:00${m[3].toUpperCase() === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`);
    return Number.isNaN(at.getTime()) ? null : { date: ist(at).slice(0, 10), time: ist(at).slice(11, 16) };
  }
  let date = '';
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d))) date = d;
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(d))) date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else return null;
  const tm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t);
  if (!tm) return null;
  let h = Number(tm[1]);
  if (tm[3]) h = (h % 12) + (tm[3].toLowerCase() === 'pm' ? 12 : 0);
  if (h > 23) return null;
  return { date, time: `${String(h).padStart(2, '0')}:${tm[2] ?? '00'}` };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "Sat 24 Oct 2026, 10:00 IST" (the form's own words for the chosen slot) as India's date and time. */
function parseIstText(text: string): { date: string; time: string } | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  const mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || mon < 0) return null;
  let h = Number(m[4]);
  if (m[6]) h = (h % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
  return { date: `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`, time: `${String(h).padStart(2, '0')}:${m[5]}` };
}

/**
 * What the row says about the meeting: the slot the visitor booked on the form (booking_id, status slot_chosen, and
 * preferred_start_utc / preferred_start_ist: the form's name for the chosen slot), another confirmed time column, only
 * loose preferred text, nothing, or something unreadable.
 */
export function slotOf(c: Record<string, string>): Slot {
  if (c.booking_id?.trim() || c.preferred_start_utc?.trim() || c.preferred_start_ist?.trim()) {
    const status = (c.status ?? '').trim().toLowerCase();
    if (/cancel|declin|no_?show|withdrawn/.test(status)) return { kind: 'unreadable', text: `booking status "${c.status}"` };
    const chosen = c.preferred_start_utc?.trim() || c.preferred_start_ist?.trim();
    if (chosen) {
      const when = parseWhen(c.preferred_start_utc?.trim() ?? '') ?? parseIstText(c.preferred_start_ist ?? '');
      return when ? { kind: 'confirmed', ...when } : { kind: 'unreadable', text: chosen };
    }
  }
  const cols = Object.keys(c).filter((h) => !IGNORED.has(h) && h !== 'answers');
  const confirmed = cols.filter((h) => CONFIRMED.test(h) && !PREFERRED.test(h));
  const dateCol = confirmed.find((h) => /date$/.test(h) && c[h]) ?? confirmed.find((h) => c[h]);
  if (dateCol) {
    const timeCol = confirmed.find((h) => h !== dateCol && /(time|at|start)$/.test(h) && c[h]);
    const when = parseWhen(c[dateCol], timeCol ? c[timeCol] : '');
    return when ? { kind: 'confirmed', ...when } : { kind: 'unreadable', text: [c[dateCol], timeCol ? c[timeCol] : ''].filter(Boolean).join(' ') };
  }
  const preferred = cols.find((h) => PREFERRED.test(h) && c[h]);
  if (preferred) return { kind: 'preferred', text: c[preferred] };
  const fromAnswers = /(preferred|requested|suggested)[^:|]*(time|date|slot)[^:|]*:\s*([^|]+)/i.exec(c.answers ?? '');
  return fromAnswers ? { kind: 'preferred', text: fromAnswers[3].trim() } : { kind: 'none' };
}

// ─── Who gets the next one ───

export type Bda = { id: number; name: string };
export type Mismatch = { rotationName: string; problem: string };

/** The CRM users the rotation names stand for (a null where none matches: reported, never guessed or created). */
export async function resolveBdas(db: Db): Promise<{ by: Map<string, Bda | null>; mismatches: Mismatch[] }> {
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id);
  const first = (n: string) => n.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const by = new Map<string, Bda | null>();
  const mismatches: Mismatch[] = [];
  for (const name of ROTATION) {
    const hits = team.filter((t) => ALIASES[name].includes(first(t.name)));
    if (hits.length === 1) {
      by.set(name, hits[0]);
      if (first(hits[0].name) !== name.toLowerCase()) mismatches.push({ rotationName: name, problem: `Matched to the existing user "${hits[0].name}" (a different spelling): confirm this is the same person.` });
    } else {
      by.set(name, null);
      mismatches.push({ rotationName: name, problem: hits.length ? `More than one CRM user matches "${name}": nothing is assigned until it is one.` : `No CRM user named "${name}": their share waits until the user exists (nothing is created or guessed).` });
    }
  }
  return { by, mismatches };
}

type RawResult = { rows?: { next?: number }[] } | { next?: number }[];
/** The next place in the rotation, and the cursor moved on for good (so later batches continue, never restart). */
export async function takeSlot(db: Db): Promise<number> {
  await db.insert(settings).values({ key: CURSOR_KEY, value: { next: 0 } }).onConflictDoNothing();
  const res = (await db.execute(sql`UPDATE settings SET value = jsonb_set(value, '{next}', to_jsonb(((value->>'next')::int) + 1)) WHERE key = ${CURSOR_KEY} RETURNING ((value->>'next')::int) - 1 AS next`)) as unknown as RawResult;
  const row = Array.isArray(res) ? res[0] : res.rows?.[0];
  return Number(row?.next ?? 0);
}

/** For Settings: whose turn is next, and the latest rows with who they went to. */
export async function rotationView(db: Db): Promise<{ next: { name: string; user: string | null }; recent: { when: Date; who: string; company: string; bda: string; state: string; reason: string }[] }> {
  const next = ROTATION[(await cursorOf(db)) % ROTATION.length];
  const { by } = await resolveBdas(db);
  const rows = await db.select().from(inboundDemoRows).orderBy(sql`${inboundDemoRows.id} desc`).limit(15);
  const recent = rows
    .filter((r) => r.state !== 'skipped' && r.state !== 'merged')
    .map((r) => ({ when: r.submittedAt ?? r.createdAt, who: r.raw.name ?? r.email, company: r.raw.company ?? '', bda: r.allocName, state: r.state, reason: r.reason }));
  return { next: { name: next, user: by.get(next)?.name ?? null }, recent };
}

export const cursorOf = async (db: Db) => Number((((await db.select().from(settings).where(eq(settings.key, CURSOR_KEY)))[0]?.value ?? {}) as { next?: number }).next ?? 0);

// ─── Showing what the sheet said ───

const clean = (v: string | undefined) => (v ?? '').trim();
/** The useful source details of a row, one line: where they came from, what they asked, the campaign. */
export function sourceLine(raw: Record<string, string>): string {
  const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((k) => clean(raw[k])).filter(Boolean);
  return [clean(raw.source) && `Source: ${raw.source.trim()}`, clean(raw.persona) && `Persona: ${raw.persona.trim()}`, clean(raw.location) && raw.location.trim(), clean(raw.answers), utm.length && `UTM: ${utm.join(' / ')}`].filter(Boolean).join(' · ');
}

/** Every column of the row worth showing on the lead, labelled; empty ones left out. */
export function sourceDetails(raw: Record<string, string>): { label: string; value: string }[] {
  const LABEL: Record<string, string> = { submitted_at: 'Submitted', kind: 'Form type', persona: 'Persona', source: 'How they heard of Inveck', location: 'Location', answers: 'Their answers', page: 'Page', landing: 'Landing page', referrer: 'Referrer', utm_source: 'UTM source', utm_medium: 'UTM medium', utm_campaign: 'UTM campaign', utm_term: 'UTM term', utm_content: 'UTM content', li_fat_id: 'LinkedIn click id', gclid: 'Google click id', received_at: 'Received', booking_id: 'Booking ID', status: 'Booking status', preferred_start_ist: 'Chosen slot (IST)', preferred_start_utc: 'Chosen slot (UTC)', timezone: 'Time zone' };
  const skip = new Set(['name', 'email', 'phone', 'company']);
  const known = Object.keys(LABEL).filter((k) => clean(raw[k])).map((k) => ({ label: LABEL[k], value: raw[k].trim() }));
  // Any other column in the sheet is kept and shown under its own header.
  const more = Object.keys(raw).filter((k) => !LABEL[k] && !skip.has(k) && clean(raw[k])).map((k) => ({ label: k.replace(/_/g, ' '), value: raw[k].trim() }));
  return [...known, ...more];
}

export async function inboundDetailsFor(db: Db, leadIds: number[]): Promise<Map<number, InboundDemoRow>> {
  const out = new Map<number, InboundDemoRow>();
  if (!leadIds.length) return out;
  for (const r of await db.select().from(inboundDemoRows).where(inArray(inboundDemoRows.leadId, leadIds)).orderBy(inboundDemoRows.id)) if (!out.has(r.leadId!) || r.state !== 'merged') out.set(r.leadId!, r);
  return out;
}

/** A BDA's inbound demo leads that have no Teams meeting yet (the sheet gave no confirmed time, or it couldn't be booked). */
export async function awaitingMeeting(db: Db, ownerId: number): Promise<{ row: InboundDemoRow; lead: Lead }[]> {
  const rows = await db
    .select({ row: inboundDemoRows, lead: leads })
    .from(inboundDemoRows)
    .innerJoin(leads, eq(inboundDemoRows.leadId, leads.id))
    .where(and(eq(inboundDemoRows.ownerId, ownerId), eq(inboundDemoRows.state, 'imported'), ne(leads.status, 'Deleted')))
    .orderBy(inboundDemoRows.id);
  return rows;
}

// ─── The sync ───

export type SyncReport = {
  at: string;
  read: number;
  created: number;
  meetings: number;
  merged: number;
  skipped: { row: number; who: string; reason: string }[];
  /** Imported, but with no Teams meeting yet: what is missing. */
  noMeeting: { row: number; who: string; company: string; reason: string }[];
  /** Waiting on something before a lead can be made (no user for their place in the rotation). */
  blocked: { row: number; who: string; reason: string }[];
  mismatches: Mismatch[];
  error: string;
};

const emptyReport = (): SyncReport => ({ at: new Date().toISOString(), read: 0, created: 0, meetings: 0, merged: 0, skipped: [], noMeeting: [], blocked: [], mismatches: [], error: '' });
export const lastSyncReport = async (db: Db) => ((await db.select().from(settings).where(eq(settings.key, REPORT_KEY)))[0]?.value ?? null) as SyncReport | null;

const cap = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, (m) => m.toUpperCase());

async function makeLead(db: Db, c: Record<string, string>, owner: Bda, rowKey: string, slot: number, now: Date): Promise<Lead> {
  const phone = cleanPhone(c.phone) ?? '';
  const [lead] = await db
    .insert(leads)
    .values({
      company: (c.company || c.name).trim(),
      city: cap((c.location ?? '').split(',')[0]),
      segment: segmentOf(c.persona ?? ''),
      source: INBOUND_SOURCE,
      // A person who asked for a demo: in conversation already, not a cold lead (no outreach steps are planned for it).
      status: 'Replied',
      inbound: true,
      ownerId: owner.id,
      nameEvidence: 'set by the team',
      contactName: cap(c.name),
      contactEmail: c.email.trim().toLowerCase(),
      contactPhone: phone,
      // Given by the form, so never looked up or "verified" elsewhere.
      contactVerifiedAt: now,
      contactCheckedAt: now,
      remark: sourceLine(c).slice(0, 900),
    })
    .returning();
  await db.insert(people).values({ leadId: lead.id, name: lead.contactName, email: lead.contactEmail, phone, source: 'Website demo form', isPrimary: true, evidence: 'Filled in the demo form', checkedAt: now });
  await stampNewLead(db, lead.id);
  await logActivity(db, lead.id, 'added', `Inbound demo request from the website form (${sourceLine(c) || 'no source given'}). Given to ${owner.name}, place ${(slot % ROTATION.length) + 1} in the rotation (${rowKey.slice(0, 8)})`);
  return lead;
}

/** Creates the Teams meeting for a lead from the row's confirmed time. Returns what is missing/wrong, or '' when it worked. */
async function meetFor(db: Db, lead: Lead, ledger: InboundDemoRow, now: Date): Promise<string> {
  const slot = slotOf(ledger.raw);
  if (slot.kind === 'none') return 'The sheet has no meeting date or time for this row.';
  if (slot.kind === 'preferred') return `The sheet only has a preferred time (${slot.text}), not a confirmed one: nothing was booked.`;
  if (slot.kind === 'unreadable') return `The meeting time in the sheet can't be read ("${slot.text}").`;
  if (!lead.ownerId) return 'The lead has no BDA yet.';
  const r = await scheduleMeeting(db, { lead, taskId: null, userId: lead.ownerId, title: defaultMeetingTitle(lead.company), date: slot.date, time: slot.time, minutes: 30 }, now);
  if (!r.ok) return r.error;
  await db.update(leads).set({ status: 'Meeting Booked', callFeedback: 'Demo scheduled', updatedAt: now }).where(eq(leads.id, lead.id));
  await logActivity(db, lead.id, 'stage', 'Meeting scheduled: the Teams meeting was created from the inbound demo sheet', 'Meeting Booked');
  await db.update(inboundDemoRows).set({ state: 'meeting', meetingId: r.meeting.id, reason: '', updatedAt: now }).where(eq(inboundDemoRows.id, ledger.id));
  return '';
}

export type SyncOptions = { source?: () => Promise<string[][]>; now?: Date };

/**
 * Reads the sheet and brings the CRM up to date. Safe to run again: a row already taken in (by its key) is never made twice,
 * a lead or meeting is never duplicated, and a row waiting on something is tried again. Never writes to the sheet.
 */
export async function syncInboundDemos(db: Db, opts: SyncOptions = {}): Promise<SyncReport> {
  const now = opts.now ?? new Date();
  const report = emptyReport();
  report.at = now.toISOString();
  const lock = (await db.select().from(settings).where(eq(settings.key, LOCK_KEY)))[0]?.value as { at?: number } | undefined;
  if (lock?.at && now.getTime() - lock.at < LOCK_MS) return { ...((await lastSyncReport(db)) ?? report), error: 'A sync is already running.' };
  await db.insert(settings).values({ key: LOCK_KEY, value: { at: now.getTime() } }).onConflictDoUpdate({ target: settings.key, set: { value: { at: now.getTime() } } });
  try {
    const creds = googleCredentials();
    if (!opts.source && !creds) {
      report.error = 'The Google service account is not configured (GOOGLE_SERVICE_ACCOUNT_JSON).';
      return report;
    }
    const sheetId = process.env.INBOUND_DEMO_SHEET_ID?.trim() || INBOUND_SHEET_ID;
    const tab = process.env.INBOUND_DEMO_SHEET_TAB?.trim() || INBOUND_SHEET_TAB;
    let values: string[][];
    try {
      values = await (opts.source ?? (() => readTab(sheetId, tab, creds!)))();
    } catch (e) {
      report.error = `The sheet couldn't be read: ${e instanceof Error ? e.message : 'unknown error'}`;
      return report;
    }
    const parsed = parseSheet(values);
    if (parsed.error) {
      report.error = parsed.error;
      return report;
    }
    report.read = parsed.rows.length;
    const { by, mismatches } = await resolveBdas(db);
    report.mismatches = mismatches;
    const known = new Map((await db.select().from(inboundDemoRows)).map((r) => [r.rowKey, r]));
    const byEmail = new Map<string, InboundDemoRow>();
    for (const r of known.values()) if (r.leadId && r.state !== 'merged' && !byEmail.has(r.email)) byEmail.set(r.email, r);

    const seen = new Set<string>();
    for (const sr of parsed.rows) {
      const c = sr.cells;
      const who = c.name || c.email || `row ${sr.sheetRow}`;
      const key = rowKeyOf(c);
      // An identical re-submission (same person, time and form) is the row already handled above.
      if (seen.has(key)) continue;
      seen.add(key);
      let ledger = known.get(key);
      try {
        if (!ledger) {
          const problem = rowProblem(c);
          const email = (c.email ?? '').trim().toLowerCase();
          const submitted = c.submitted_at && !Number.isNaN(new Date(c.submitted_at).getTime()) ? new Date(c.submitted_at) : null;
          const base = { rowKey: key, sheetRow: sr.sheetRow, submittedAt: submitted, email, raw: c };
          if (problem) {
            await db.insert(inboundDemoRows).values({ ...base, state: 'skipped', reason: problem }).onConflictDoNothing();
            report.skipped.push({ row: sr.sheetRow, who, reason: problem });
            continue;
          }
          const same = byEmail.get(email);
          if (same?.leadId) {
            // The same person submitting again: one lead, never a second one (or a second meeting).
            const [row] = await db.insert(inboundDemoRows).values({ ...base, state: 'merged', leadId: same.leadId, ownerId: same.ownerId }).onConflictDoNothing().returning();
            if (row) {
              await logActivity(db, same.leadId, 'note', `Submitted the demo form again (${sourceLine(c) || 'no source given'})`);
              report.merged++;
              known.set(key, row);
              ledger = row;
            }
            // A repeat with a booked time carries on to the meeting step (if the lead has none); otherwise it is done.
            if (!ledger || slotOf(c).kind !== 'confirmed') continue;
          } else {
            const slot = await takeSlot(db);
            const name = ROTATION[slot % ROTATION.length];
            const [row] = await db.insert(inboundDemoRows).values({ ...base, allocSlot: slot, allocName: name, state: 'blocked' }).onConflictDoNothing().returning();
            if (!row) continue;
            ledger = row;
            known.set(key, row);
          }
        }
        if (ledger.state === 'skipped') continue;
        // A repeat submission has its lead already; it only matters again if it brings a time and the lead has no meeting.
        if (ledger.state === 'merged' && slotOf(c).kind !== 'confirmed') continue;

        // A row held for someone no longer in the rotation (Anshul was in it once) is given a new place in it.
        if (!ledger.leadId && !(ROTATION as readonly string[]).includes(ledger.allocName)) {
          const slot = await takeSlot(db);
          const [row] = await db.update(inboundDemoRows).set({ allocSlot: slot, allocName: ROTATION[slot % ROTATION.length], updatedAt: now }).where(eq(inboundDemoRows.id, ledger.id)).returning();
          ledger = row;
          known.set(key, row);
        }
        // A row waiting for its BDA to exist gets its lead now if the BDA does.
        if (!ledger.leadId) {
          const owner = by.get(ledger.allocName) ?? null;
          if (!owner) {
            const reason = `No CRM user for ${ledger.allocName}, whose turn this was: it is given to them as soon as the user exists.`;
            await db.update(inboundDemoRows).set({ reason, updatedAt: now }).where(eq(inboundDemoRows.id, ledger.id));
            report.blocked.push({ row: sr.sheetRow, who, reason });
            continue;
          }
          const lead = await makeLead(db, c, owner, ledger.rowKey, ledger.allocSlot ?? 0, now);
          const [row] = await db.update(inboundDemoRows).set({ leadId: lead.id, ownerId: owner.id, state: 'imported', reason: '', updatedAt: now }).where(eq(inboundDemoRows.id, ledger.id)).returning();
          ledger = row;
          known.set(key, row);
          byEmail.set(row.email, row);
          report.created++;
        }
        if (ledger.state === 'meeting') continue;
        // The Teams meeting, from the row's confirmed time only.
        const [lead] = await db.select().from(leads).where(eq(leads.id, ledger.leadId!));
        if (!lead) continue;
        if ((await db.select({ id: leadMeetings.id }).from(leadMeetings).where(and(eq(leadMeetings.leadId, lead.id), eq(leadMeetings.status, 'scheduled'))).limit(1)).length) {
          await db.update(inboundDemoRows).set({ state: 'meeting', reason: '', updatedAt: now }).where(eq(inboundDemoRows.id, ledger.id));
          continue;
        }
        const why = await meetFor(db, lead, ledger, now);
        if (why) {
          await db.update(inboundDemoRows).set({ reason: why, updatedAt: now }).where(eq(inboundDemoRows.id, ledger.id));
          report.noMeeting.push({ row: sr.sheetRow, who, company: lead.company, reason: why });
        } else report.meetings++;
      } catch (e) {
        // One bad row never stops the others; it is tried again next time.
        console.error(`[inbound-demo] row ${sr.sheetRow} failed:`, e instanceof Error ? e.message : e);
        report.skipped.push({ row: sr.sheetRow, who, reason: `Error: ${e instanceof Error ? e.message : 'unknown'}`.slice(0, 300) });
      }
    }
    return report;
  } finally {
    await db.insert(settings).values({ key: REPORT_KEY, value: report }).onConflictDoUpdate({ target: settings.key, set: { value: report } });
    await db.delete(settings).where(eq(settings.key, LOCK_KEY));
  }
}
