import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from './db';
import { allocationRules, clients, icps, leads, settings, sheetFirms, users } from './db/schema';
import { logActivity } from './activity';
import { KnownBranches } from './branches';
import { importContactSheet, type ContactRow } from './contact-import';
import { dealToDeficits, drawDue, shuffle } from './draw';
import { googleCredentials, readTab } from './google-sheet';
import { domainOf } from './pipeline/text';
import { isCaSegment, istDay } from './tasks';
import { cleanPhone } from './tracker';

/**
 * CA firms come from one master Google Sheet (tab "Firms": Firm, Phone, Email, Services, Website, a
 * location column headed ".", and the firm's ICAI profile URL). Every working day Anchal and Puja are each
 * given 10 firms picked at random from it, 20 in all. Only the picked firms become leads: the sheet is
 * read, never copied in. These firms don't go through the company-discovery search; the sheet is the source.
 */
export const CA_SHEET_ID = '1Kv0w7HJK6PQ0Gvc62fyvQP6ReBqSabH2x-nym2q02QA';
export const CA_SHEET_TAB = 'Firms';
export const CA_PER_ASSOCIATE = 10;
/** When a draw came up short, the sheet isn't read again for this long (unless an admin asks). */
const RECHECK_MS = 30 * 60 * 1000;

export type CaFirm = {
  /** Stable identity: the ICAI profile (firmProfile/<id>), else the profile URL, else the name and first phone. */
  key: string;
  rowNumber: number;
  firm: string;
  phones: string[];
  emails: string[];
  services: string;
  website: string;
  location: string;
  profileUrl: string;
};

/** The sheet's headers, as written in row one (lower case); the location column is headed ".". */
const COLUMNS = {
  firm: /^(firm|firm name|name of (the )?firm|company)$/,
  phone: /^(phone|mobile|contact (no|number)|telephone)/,
  email: /^e-?mail/,
  services: /^services?$/,
  website: /^(website|web site|url|site)$/,
  location: /^(\.|city|location|address|place|town)$/,
  profile: /icai.*url|profile url|profile link/,
};

/** One firm's key. The ICAI firm number is the stable part: rows move when the sheet is sorted, so the row number isn't used. */
export function firmKey(f: { profileUrl: string; firm: string; phones: string[] }): string {
  const id = /firmProfile\/(\d+)/i.exec(f.profileUrl)?.[1];
  if (id) return `icai:${id}`;
  if (f.profileUrl) return `url:${f.profileUrl.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')}`;
  return `name:${f.firm.toLowerCase().replace(/[^a-z0-9]/g, '')}|${(f.phones[0] ?? '').replace(/\D/g, '')}`;
}

const split = (v: string) => v.split(/\s*(?:\n|;|,|\/|\|)\s*/).map((x) => x.trim()).filter(Boolean);

/** The firms in the sheet's rows, once each (a firm listed twice is taken from its first row). A missing column is reported, never guessed. */
export function parseFirms(rows: string[][]): { firms: CaFirm[]; error: string; duplicates: number } {
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const at = (re: RegExp) => header.findIndex((h) => re.test(h));
  const col = { firm: at(COLUMNS.firm), phone: at(COLUMNS.phone), email: at(COLUMNS.email), services: at(COLUMNS.services), website: at(COLUMNS.website), location: at(COLUMNS.location), profile: at(COLUMNS.profile) };
  if (col.firm < 0) return { firms: [], error: 'The sheet has no "Firm" column in its first row.', duplicates: 0 };
  const firms: CaFirm[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  rows.slice(1).forEach((r, i) => {
    const cell = (c: number) => (c >= 0 ? String(r[c] ?? '').trim() : '');
    const firm = cell(col.firm);
    if (!firm) return;
    const f = {
      firm,
      phones: [...new Set(split(cell(col.phone)).map((p) => cleanPhone(p)).filter((p): p is string => !!p))],
      emails: [...new Set(split(cell(col.email)).map((e) => e.toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))],
      services: cell(col.services),
      website: cell(col.website),
      location: cell(col.location),
      profileUrl: cell(col.profile),
    };
    const key = firmKey(f);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    firms.push({ ...f, key, rowNumber: i + 2 });
  });
  return { firms, error: '', duplicates };
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** A sheet firm in the shape the contact-sheet import takes: everything useful kept (phone, email, website, city, services, ICAI profile). */
export function toContactRow(f: CaFirm): ContactRow {
  const city = titleCase(f.location.split(',')[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim());
  return {
    company: f.firm,
    website: domainOf(f.website),
    city,
    phones: f.phones,
    emails: f.emails,
    // The sheet names no partners: the person stays blank (nothing is researched); the firm's own phone is what is called.
    people: [],
    remark: [f.services && `Services: ${f.services}`, f.profileUrl && `ICAI profile: ${f.profileUrl}`, f.location && `Location: ${f.location}`].filter(Boolean).join(' · ').slice(0, 900),
  };
}

/**
 * Who is given CA firms each day and how many: the CA Firms ICP's counts in Configuration → Allocation (any BDA with a count).
 * With none configured, the original arrangement: Anchal and Puja, 10 each. The source (the Google Sheet), the one-firm-once rule
 * and the "already sent a request" handling are the same either way.
 */
export async function caTargets(db: Db): Promise<{ id: number; name: string; count: number; legacy: boolean }[]> {
  const [ca] = await db.select({ id: icps.id }).from(icps).where(sql`btrim(regexp_replace(replace(lower(${icps.segment}), '&', ' and '), '[^a-z0-9]+', ' ', 'g')) = 'ca firms'`).limit(1);
  const rules = ca ? await db.select().from(allocationRules).where(eq(allocationRules.icpId, ca.id)) : [];
  if (!rules.length) return (await caAssociates(db)).map((t) => ({ ...t, count: CA_PER_ASSOCIATE, legacy: true }));
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id);
  const canonical = (name: string) => {
    const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return ['anchal', 'aanchal'].includes(first) ? 'Anchal' : first === 'puja' ? 'Puja' : name;
  };
  return team.flatMap((t) => {
    const count = rules.find((r) => r.userId === t.id)?.dailyCount ?? 0;
    return count > 0 ? [{ id: t.id, name: canonical(t.name), count, legacy: false }] : [];
  });
}

/** BDAs with a CA firms count whose account is off or missing. */
async function caMissing(db: Db, active: { id: number }[]): Promise<string[]> {
  const [ca] = await db.select({ id: icps.id }).from(icps).where(sql`btrim(regexp_replace(replace(lower(${icps.segment}), '&', ' and '), '[^a-z0-9]+', ' ', 'g')) = 'ca firms'`).limit(1);
  if (!ca) return [];
  const rules = (await db.select().from(allocationRules).where(eq(allocationRules.icpId, ca.id))).filter((r) => r.dailyCount > 0 && !active.some((a) => a.id === r.userId));
  if (!rules.length) return [];
  const names = await db.select({ id: users.id, name: users.name }).from(users);
  return rules.map((r) => names.find((n) => n.id === r.userId)?.name ?? '').filter(Boolean);
}

/** Anchal and Puja's user accounts, found by first name whatever the capitalisation or spelling ("Aanchal"). */
export async function caAssociates(db: Db): Promise<{ name: string; id: number }[]> {
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id);
  const first = (n: string) => n.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return [
    { name: 'Anchal', match: ['anchal', 'aanchal'] },
    { name: 'Puja', match: ['puja'] },
  ].flatMap((w) => {
    const u = team.find((t) => w.match.includes(first(t.name)));
    return u ? [{ name: w.name, id: u.id }] : [];
  });
}

export type CaDrawRecord = {
  day: string;
  at: string;
  /** When the sheet was last read for this day (a short draw is only rechecked every half hour). */
  checkedAt: string;
  wanted: number;
  drawn: number;
  short: boolean;
  perAssociate: { id: number; name: string; wanted: number; drawn: number }[];
  /** Firms left in the sheet that nobody has been given and that aren't yet leads or clients. */
  remaining: number | null;
  /** Leads created by the run that made this record. */
  added: number;
  /** Anything that kept the draw from running fully (an associate not found, the sheet unreadable). */
  problem: string;
};

const drawKey = (day: string) => `ca-draw:${day}`;
export async function getCaDraw(db: Db, day = istDay()): Promise<CaDrawRecord | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, drawKey(day)));
  return (row?.value as CaDrawRecord | undefined) ?? null;
}

/** What each associate has been given from the sheet on a day. */
async function givenOn(db: Db, day: string): Promise<Map<number, number>> {
  const rows = await db.select({ owner: sheetFirms.ownerId, n: sql<number>`count(*)::int` }).from(sheetFirms).where(and(eq(sheetFirms.assignedOn, day), isNotNull(sheetFirms.ownerId))).groupBy(sheetFirms.ownerId);
  return new Map(rows.map((r) => [r.owner!, Number(r.n)]));
}

type Source = () => Promise<string[][]>;

/**
 * The daily CA allocation: each of Anchal and Puja is given up to 10 firms, picked at random from the
 * sheet among firms never given before and not already a lead or a client. Safe to run again: what was
 * already given today is counted, only the missing firms are drawn, and a firm is recorded before its lead
 * is made, so it can never be picked twice (a lead that failed to be made is made on the next run). With
 * too few firms, the ones there are go out and the shortfall is recorded per associate.
 */
export async function runCaDraw(
  db: Db,
  opts: { now?: Date; force?: boolean; random?: () => number; source?: Source } = {},
): Promise<CaDrawRecord | null> {
  const now = opts.now ?? new Date();
  const day = istDay(now);
  if (!opts.force && !drawDue(now)) return null;
  const creds = googleCredentials();
  if (!opts.source && !creds) return null;
  const previous = await getCaDraw(db, day);
  if (previous && !opts.force && (!previous.short || now.getTime() - new Date(previous.checkedAt).getTime() < RECHECK_MS)) return previous;

  const spreadsheetId = process.env.CA_SHEET_ID?.trim() || CA_SHEET_ID;
  const tab = process.env.CA_SHEET_TAB?.trim() || CA_SHEET_TAB;
  const team = await caTargets(db);
  const problems: string[] = [];
  // With no CA allocation configured, the original two (Anchal and Puja) are expected.
  if (team.every((t) => t.legacy)) for (const name of ['Anchal', 'Puja']) if (!team.some((t) => t.name === name)) problems.push(`${name} has no active user account`);
  // A BDA with a CA count who can't be given firms (turned off, or gone) is said so.
  for (const name of await caMissing(db, team)) problems.push(`${name} has no active user account`);

  let parsed: ReturnType<typeof parseFirms>;
  try {
    parsed = parseFirms(await (opts.source ?? (() => readTab(spreadsheetId, tab, creds!)))());
  } catch (e) {
    return save(db, day, { ...(previous ?? empty(day, now, team)), checkedAt: now.toISOString(), added: 0, problem: `The Google Sheet couldn't be read: ${e instanceof Error ? e.message : 'unknown error'}` });
  }
  if (parsed.error) return save(db, day, { ...(previous ?? empty(day, now, team)), checkedAt: now.toISOString(), added: 0, problem: parsed.error });

  const segment = (await db.select({ segment: icps.segment, active: icps.active }).from(icps)).find((i) => isCaSegment(i.segment))?.segment ?? 'CA Firms';
  const byKey = new Map(parsed.firms.map((f) => [f.key, f]));
  const taken = await db.select().from(sheetFirms);
  const takenKeys = new Set(taken.map((t) => t.sourceKey));
  const known = new KnownBranches(await db.select({ company: leads.company, website: leads.website, city: leads.city }).from(leads), await db.select({ company: clients.company, website: clients.website }).from(clients));
  let added = 0;

  // A firm recorded as given whose lead was never made (a run that stopped halfway): made now.
  for (const t of taken.filter((x) => x.ownerId && !x.leadId)) {
    const firm = byKey.get(t.sourceKey);
    if (!firm) {
      await db.delete(sheetFirms).where(and(eq(sheetFirms.sourceKey, t.sourceKey), isNull(sheetFirms.leadId)));
      continue;
    }
    if ((await makeLead(db, firm, t.ownerId!, segment, known)) !== null) added++;
  }

  const eligible = shuffle(
    parsed.firms.filter((f) => !takenKeys.has(f.key) && !known.has(f.firm, domainOf(f.website), toContactRow(f).city)),
    opts.random,
  );
  const given = await givenOn(db, day);
  const share = new Map(team.map((t) => [t.id, t.count]));
  const deficits = new Map(team.map((t) => [t.id, Math.max(0, t.count - (given.get(t.id) ?? 0))] as const).filter(([, n]) => n > 0));
  const need = [...deficits.values()].reduce((a, b) => a + b, 0);
  let used = 0;
  for (const [owner, picks] of dealToDeficits(eligible.slice(0, need), deficits, opts.random)) {
    for (const firm of picks) {
      // Recorded first: a unique key means a second run can't pick this firm, whatever happens next.
      const claimed = await db
        .insert(sheetFirms)
        .values({ sourceKey: firm.key, spreadsheetId, tab, company: firm.firm, rowNumber: firm.rowNumber, ownerId: owner, assignedOn: day })
        .onConflictDoNothing()
        .returning({ key: sheetFirms.sourceKey });
      if (!claimed.length) continue;
      // Two runs at once can't hand an associate more than their share: the later claim is withdrawn.
      if (((await givenOn(db, day)).get(owner) ?? 0) > (share.get(owner) ?? CA_PER_ASSOCIATE)) {
        await db.delete(sheetFirms).where(eq(sheetFirms.sourceKey, firm.key));
        continue;
      }
      used++;
      if ((await makeLead(db, firm, owner, segment, known)) !== null) added++;
    }
  }

  const now2 = await givenOn(db, day);
  const perAssociate = team.map((t) => ({ id: t.id, name: t.name, wanted: t.count, drawn: now2.get(t.id) ?? 0 }));
  const drawn = perAssociate.reduce((n, a) => n + a.drawn, 0);
  const wanted = team.every((t) => t.legacy) ? Math.max(team.length, 2) * CA_PER_ASSOCIATE : team.reduce((a, t) => a + t.count, 0);
  return save(db, day, {
    day,
    at: previous?.at ?? now.toISOString(),
    checkedAt: now.toISOString(),
    wanted,
    drawn,
    short: drawn < wanted,
    perAssociate,
    remaining: Math.max(0, eligible.length - used),
    added,
    problem: problems.join('; '),
  });
}

const empty = (day: string, now: Date, team: { name: string; id: number; count: number; legacy: boolean }[]): CaDrawRecord => ({
  day,
  at: now.toISOString(),
  checkedAt: now.toISOString(),
  wanted: team.every((t) => t.legacy) ? Math.max(team.length, 2) * CA_PER_ASSOCIATE : team.reduce((a, t) => a + t.count, 0),
  drawn: 0,
  short: true,
  perAssociate: team.map((t) => ({ id: t.id, name: t.name, wanted: t.count, drawn: 0 })),
  remaining: null,
  added: 0,
  problem: '',
});

async function save(db: Db, day: string, record: CaDrawRecord): Promise<CaDrawRecord> {
  await db.insert(settings).values({ key: drawKey(day), value: record }).onConflictDoUpdate({ target: settings.key, set: { value: record } });
  return record;
}

/** Makes the lead for a firm already recorded as given, and records its id. Null when it couldn't be made (it is retried). */
async function makeLead(db: Db, firm: CaFirm, owner: number, segment: string, known: KnownBranches): Promise<number | null> {
  try {
    // Database only: Approved at once (never researched); nothing is searched to fill a blank.
    const r = await importContactSheet(db, [toContactRow(firm)], { segment, ownerId: owner, known, by: 'the Google Sheet', status: 'Approved' });
    const id = r.ids[0] ?? null;
    if (id === null) return null;
    await db.update(sheetFirms).set({ leadId: id }).where(eq(sheetFirms.sourceKey, firm.key));
    await logActivity(db, id, 'note', `Taken from the CA firms Google Sheet (${firm.key}) and given to its owner by the daily allocation. Approved straight away: its details are the sheet's only, with no research`);
    return id;
  } catch (e) {
    console.error('[ca-sheet] could not make the lead for a firm:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * CA firms already taken from the sheet before this rule (still New) are approved once, so they
 * show as fresh leads and are not researched. Runs once per database; what it did is kept under settings.caApprovedV1.
 */
export async function approveSheetLeadsOnce(db: Db): Promise<void> {
  const key = 'caApprovedV1';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  const rows = await db.select({ id: leads.id, status: leads.status }).from(leads).innerJoin(sheetFirms, eq(sheetFirms.leadId, leads.id)).where(inArray(leads.status, ['New']));
  for (const r of rows) {
    await db.update(leads).set({ status: 'Approved', updatedAt: new Date() }).where(eq(leads.id, r.id));
    await logActivity(db, r.id, 'stage', `Approved: CA firms from the Google Sheet are database-only and need no research or approval (was ${r.status})`, 'Approved');
  }
  await db.insert(settings).values({ key, value: { at: new Date().toISOString(), approved: rows.map((r) => r.id) } }).onConflictDoNothing();
}
