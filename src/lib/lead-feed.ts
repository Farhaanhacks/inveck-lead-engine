import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { clients, icps, leadFeedRows, leads, settings, type Icp } from './db/schema';
import { KnownBranches, companyKeys } from './branches';
import { importContactSheet, type ContactRow } from './contact-import';
import { cleanEmail } from './contact-edit';
import { googleCredentials, readTab, writeTab } from './google-sheet';
import { resolveIcp } from './icp-match';
import { listKnownCompanies } from './known-companies';
import { defaultProduct, listIcps } from './config';
import { getSettings, saveSettings } from './settings';
import { cleanPhone } from './tracker';
import { drawSegments } from './draw';
import { domainOf } from './pipeline/text';

/**
 * The daily lead feed: companies found by Instinct (using the ICP) and enriched by Zintlr (phone and email), written by Instinct to a Google
 * Sheet and read here (read-only, with the same service account as the CA and inbound sheets). Each usable company becomes a lead that
 * waits, Approved and ready, for the morning draw, which deals it to an associate by the Allocation counts like any other lead.
 *
 * - one company is one lead: a company already a lead, a client or on the team's own list is never added again (the same company
 *   check as everywhere, by name and website), nor twice in the sheet;
 * - usable means an ICP the app has, a named contact, and BOTH a valid phone number and a valid email;
 * - the lead shows no source, is not researched (Instinct already judged the fit) and its contact is taken as checked.
 */
export const FEED_TAB_DEFAULT = 'Leads';
export const FEED_COLUMNS = ['ICP', 'Company', 'Website', 'Location', 'Contact Name', 'Designation', 'LinkedIn URL', 'Phone', 'Email'] as const;
const REPORT_KEY = 'leadFeedSync';
const LOCK_KEY = 'leadFeedLock';
const LOCK_MS = 90_000;
/** Rows handled in one sync; a longer sheet is taken in over the following syncs. */
export const FEED_BATCH = 300;

export type FeedRow = { sheetRow: number; icp: string; company: string; website: string; city: string; name: string; title: string; linkedin: string; phones: string[]; emails: string[]; raw: Record<string, string> };

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const ICP_H = /^(icp|icp name|segment|icp segment|target icp)$/;
const COMPANY_H = /^(company|company name|organi[sz]ation|organi[sz]ation name|account|account name|employer|current company)$/;
const WEBSITE_H = /^(website|web site|company website|website url|domain|company domain|company url)$/;
const CITY_H = /^(location|city|company location|company city|hq|headquarters|region)$/;
const NAME_H = /^(contact name|name|full name|person|person name|contact|lead name)$/;
const FIRST_H = /^(first name|first)$/;
const LAST_H = /^(last name|last|surname)$/;
const TITLE_H = /^(designation|title|job title|position|role|contact title|current title)$/;
const LINKEDIN_H = /^(linkedin|linkedin url|linkedin profile|linkedin profile url|person linkedin|contact linkedin|profile url)$/;
const PHONE_H = /(phone|mobile|cell|direct dial|contact number)/;
const EMAIL_H = /e ?mail/;

const split = (v: string) => v.split(/\s*(?:\n|;|,|\/|\|)\s*/).map((x) => x.trim()).filter(Boolean);

/** The feed sheet's rows by header (the first row), in any column order. A missing column is reported, never guessed. */
export function parseFeed(values: string[][]): { rows: FeedRow[]; error: string } {
  if (!values.length) return { rows: [], error: 'The sheet is empty.' };
  const head = values[0].map(norm);
  const at = (re: RegExp) => head.findIndex((h) => re.test(h));
  const many = (re: RegExp, not?: RegExp) => head.map((h, i) => (re.test(h) && !(not && not.test(h)) ? i : -1)).filter((i) => i >= 0);
  const [icp, company, website, city, name, first, last, title, linkedin] = [ICP_H, COMPANY_H, WEBSITE_H, CITY_H, NAME_H, FIRST_H, LAST_H, TITLE_H, LINKEDIN_H].map(at);
  const phones = many(PHONE_H, /company|office|hq|status|verif/);
  const emails = many(EMAIL_H, /status|verif|valid|confidence/);
  const missing = [icp < 0 && 'ICP', company < 0 && 'Company', name < 0 && first < 0 && 'Contact Name', !phones.length && 'Phone', !emails.length && 'Email'].filter((x): x is string => !!x);
  if (missing.length) return { rows: [], error: `The sheet has no ${missing.join(', ')} column. Expected headers: ${FEED_COLUMNS.join(', ')}.` };
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const rows: FeedRow[] = [];
  values.slice(1).forEach((r, n) => {
    if (!r.some((c) => c?.trim())) return;
    const person = cell(r, name) || [cell(r, first), cell(r, last)].filter(Boolean).join(' ');
    rows.push({
      sheetRow: n + 2,
      icp: cell(r, icp),
      company: cell(r, company),
      website: domainOf(cell(r, website)),
      city: cell(r, city),
      name: person,
      title: cell(r, title),
      linkedin: cell(r, linkedin),
      phones: phones.flatMap((i) => split(cell(r, i))),
      emails: emails.flatMap((i) => split(cell(r, i))),
      raw: Object.fromEntries(values[0].map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h]) => h)),
    });
  });
  return { rows, error: '' };
}

/** The ledger key: the company's normalised name (one company is one lead). */
export const feedKey = (company: string) => companyKeys(company)[0] ?? company.toLowerCase().replace(/[^a-z0-9]/g, '');

export type FeedProblem = { company: string; sheetRow: number; reason: string };
export type FeedReport = { at: string; read: number; imported: number; duplicates: number; skipped: FeedProblem[]; error: string; /** Companies written to the Known tab, and why that failed if it did. */ known: number; knownError: string };
const emptyReport = (): FeedReport => ({ at: new Date().toISOString(), read: 0, imported: 0, duplicates: 0, skipped: [], error: '', known: 0, knownError: '' });
export const lastFeedReport = async (db: Db) => ((await db.select().from(settings).where(eq(settings.key, REPORT_KEY)))[0]?.value ?? null) as FeedReport | null;

/** Why a row can't be a lead yet, or '' when it can (with the cleaned phone and email). */
export function feedProblem(r: FeedRow, activeIcps: Icp[]): { reason: string; segment?: string; phones?: string[]; emails?: string[] } {
  if (!r.company) return { reason: 'no company name' };
  const match = resolveIcp(r.icp, activeIcps);
  if (!match.icp) return { reason: `ICP "${r.icp || 'empty'}" is not one of the app's active ICPs` };
  if (!r.name) return { reason: 'no contact name' };
  const phones = r.phones.map((p) => cleanPhone(p)).filter((p): p is string => !!p);
  const emails = r.emails.map((e) => cleanEmail(e)).filter((e): e is string => !!e);
  if (!phones.length && !emails.length) return { reason: 'no phone number and no email' };
  if (!phones.length) return { reason: 'no valid phone number' };
  if (!emails.length) return { reason: 'no valid email' };
  return { reason: '', segment: match.icp.segment, phones: [...new Set(phones)], emails: [...new Set(emails)] };
}

/** The ICPs a company can be fed under: active ones that are drawn (an allocation count), so a lead never waits for a draw that doesn't exist. */
async function feedIcps(db: Db): Promise<Icp[]> {
  const product = await defaultProduct(db);
  const drawn = new Set(await drawSegments(db));
  const all = product ? await listIcps(db, product.id) : await db.select().from(icps);
  return all.filter((i) => i.active && [...drawn].some((s) => s.toLowerCase() === i.segment.toLowerCase()));
}

/**
 * Reads the feed sheet and makes a lead of every usable company that is not already known. Safe to run again and from two places at
 * once (a lock): rows already imported or found to be duplicates are not touched again; rows that were not usable are looked at again.
 * `opts.source` replaces the sheet read (tests).
 */
export async function syncLeadFeed(db: Db, opts: { source?: () => Promise<string[][]>; writeKnown?: (rows: string[][]) => Promise<void>; now?: Date } = {}): Promise<FeedReport> {
  const now = opts.now ?? new Date();
  const report = emptyReport();
  report.at = now.toISOString();
  const lock = (await db.select().from(settings).where(eq(settings.key, LOCK_KEY)))[0]?.value as { at?: number } | undefined;
  if (lock?.at && now.getTime() - lock.at < LOCK_MS) return { ...((await lastFeedReport(db)) ?? report), error: 'A sync is already running.' };
  await db.insert(settings).values({ key: LOCK_KEY, value: { at: now.getTime() } }).onConflictDoUpdate({ target: settings.key, set: { value: { at: now.getTime() } } });
  try {
    const sheetId = process.env.LEAD_FEED_SHEET_ID?.trim() ?? '';
    const tab = process.env.LEAD_FEED_SHEET_TAB?.trim() || FEED_TAB_DEFAULT;
    const creds = googleCredentials();
    if (!opts.source && !sheetId) {
      report.error = 'The lead sheet is not set: add LEAD_FEED_SHEET_ID (and LEAD_FEED_SHEET_TAB if the tab is not called Leads).';
      return report;
    }
    if (!opts.source && !creds) {
      report.error = 'The Google service account is not configured (GOOGLE_SERVICE_ACCOUNT_JSON).';
      return report;
    }
    // The Known tab does not depend on the Leads tab: it is brought up to date even when Leads can't be read yet (so Instinct can already
    // check against it), and a failure here never undoes an import.
    const writeKnown = async () => {
      if (!opts.writeKnown && opts.source) return;
      try {
        report.known = (await publishKnown(db, { write: opts.writeKnown })).count;
      } catch (e) {
        report.knownError = `The Known tab could not be updated: ${e instanceof Error ? e.message : String(e)}. Make the service account an Editor of the sheet.`.slice(0, 300);
      }
    };
    let values: string[][];
    try {
      values = await (opts.source ?? (() => readTab(sheetId, tab, creds!)))();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.error = (/unable to parse range/i.test(msg)
        ? `The sheet has no tab called "${tab}" (Google says: ${msg}). Rename the tab to exactly ${tab}, or set LEAD_FEED_SHEET_TAB to its name.`
        : `Could not read the sheet: ${msg}. Share it with the service account's email (Editor) and check the sheet ID and tab name.`).slice(0, 320);
      await writeKnown();
      return report;
    }
    const parsed = parseFeed(values);
    if (parsed.error) {
      report.error = parsed.error;
      await writeKnown();
      return report;
    }
    report.read = parsed.rows.length;

    const active = await feedIcps(db);
    const ledger = new Map<string, { state: string }>((await db.select().from(leadFeedRows)).map((r) => [r.rowKey, { state: r.state }]));
    const known = new KnownBranches(
      [...(await db.select({ company: leads.company, website: leads.website, city: leads.city }).from(leads)), ...(await listKnownCompanies(db))],
      await db.select({ company: clients.company, website: clients.website }).from(clients),
    );
    const note = async (key: string, r: FeedRow, state: string, reason: string, leadId?: number) =>
      db
        .insert(leadFeedRows)
        .values({ rowKey: key, company: r.company, state, reason, leadId: leadId ?? null, raw: r.raw })
        .onConflictDoUpdate({ target: leadFeedRows.rowKey, set: { company: r.company, state, reason, leadId: leadId ?? null, raw: r.raw, updatedAt: now } });

    let handled = 0;
    const doneNow = new Set<string>();
    for (const r of parsed.rows) {
      if (handled >= FEED_BATCH) break;
      const key = feedKey(r.company);
      // The same company listed again further down the sheet: one company, one lead.
      if (doneNow.has(key)) {
        report.duplicates++;
        continue;
      }
      const seen = ledger.get(key);
      // Already taken in (or known to be a duplicate): never again. The same company listed twice in the sheet is one company.
      if (seen && (seen.state === 'imported' || seen.state === 'duplicate')) continue;
      handled++;
      doneNow.add(key);
      try {
        const p = feedProblem(r, active);
        if (p.reason) {
          await note(key, r, 'skipped', p.reason);
          report.skipped.push({ company: r.company, sheetRow: r.sheetRow, reason: p.reason });
          continue;
        }
        // One company, one lead: against every lead, client and the team's own list, whatever the city.
        const hit = known.has(r.company, r.website, r.city);
        if (hit) {
          await note(key, r, 'duplicate', hit === 'client' ? 'already a client' : 'already a lead');
          ledger.set(key, { state: 'duplicate' });
          report.duplicates++;
          continue;
        }
        const row: ContactRow = { company: r.company, website: r.website, city: r.city, phones: p.phones!, emails: p.emails!, people: [{ name: r.name, title: r.title, linkedin: r.linkedin }] };
        const made = await importContactSheet(db, [row], { segment: p.segment!, ownerId: null, known, by: 'the lead feed', status: 'Approved', source: '', qualified: true, contactChecked: true });
        await note(key, r, 'imported', '', made.ids[0]);
        ledger.set(key, { state: 'imported' });
        report.imported++;
      } catch (e) {
        const reason = `could not be saved: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        await note(key, r, 'skipped', reason).catch(() => {});
        report.skipped.push({ company: r.company, sheetRow: r.sheetRow, reason });
      }
    }

    // The Known tab, brought up to date with what was just added, for Instinct's next run.
    await writeKnown();
    return report;
  } finally {
    await db.insert(settings).values({ key: REPORT_KEY, value: report }).onConflictDoUpdate({ target: settings.key, set: { value: report } });
    await db.delete(settings).where(eq(settings.key, LOCK_KEY));
  }
}

export const KNOWN_TAB_DEFAULT = 'Known';
export const KNOWN_HEADER = ['Company', 'Domain', 'Match key', 'In the CRM as'];

/**
 * Every company the CRM already has, for Instinct to check BEFORE it spends Zintlr credits: every lead (whatever its stage, deleted and
 * disqualified ones too), every client, the team's own list, and every company the feed has delivered before (even ones that were not
 * usable). Once per company; the domain and the app's own cleaned-up name are included so the match is exact.
 */
export async function knownRows(db: Db): Promise<string[][]> {
  const out = new Map<string, string[]>();
  const add = (company: string, website: string, as: string) => {
    const name = company.trim();
    if (!name) return;
    const domain = domainOf(website);
    const key = feedKey(name);
    const id = domain || key;
    if (out.has(id) || (domain && out.has(key))) return;
    out.set(id, [name, domain, key, as]);
  };
  for (const l of await db.select({ company: leads.company, website: leads.website }).from(leads)) add(l.company, l.website, 'CRM lead');
  for (const c of await db.select({ company: clients.company, website: clients.website }).from(clients)) add(c.company, c.website, 'Client');
  for (const k of await listKnownCompanies(db)) add(k.company, k.website, 'Own list');
  for (const f of await db.select({ company: leadFeedRows.company }).from(leadFeedRows)) add(f.company, '', 'Instinct feed');
  return [KNOWN_HEADER, ...[...out.values()].sort((a, b) => a[0].localeCompare(b[0]))];
}

/** Writes the Known tab of the feed sheet (replacing it). `opts.write` replaces the sheet write (tests). Returns how many companies. */
export async function publishKnown(db: Db, opts: { write?: (rows: string[][]) => Promise<void> } = {}): Promise<{ count: number }> {
  const rows = await knownRows(db);
  if (opts.write) await opts.write(rows);
  else {
    const sheetId = process.env.LEAD_FEED_SHEET_ID?.trim() ?? '';
    const creds = googleCredentials();
    if (!sheetId || !creds) throw new Error('The lead sheet is not set (LEAD_FEED_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON).');
    await writeTab(sheetId, process.env.LEAD_FEED_KNOWN_TAB?.trim() || KNOWN_TAB_DEFAULT, rows, creds);
  }
  return { count: rows.length - 1 };
}

/**
 * The text to give Instinct once: the active ICPs (what a company is, the titles to find) and the sheet to write to. It is read from the
 * app's own ICPs, so it stays in step with Configuration.
 */
export function instinctBrief(list: Pick<Icp, 'segment' | 'description' | 'industries' | 'companySize' | 'geography' | 'mustHaves' | 'dealBreakers' | 'targetTitles' | 'p2Titles' | 'p3Titles' | 'avoidTitles'>[]): string {
  const line = (label: string, v: string) => (v.trim() ? `${label}: ${v.trim().replace(/\n+/g, '; ')}` : '');
  const icpText = list
    .map((i) => [`ICP: ${i.segment}`, line('What it is', i.description), line('Industries', i.industries), line('Company size', i.companySize), line('Geography', i.geography), line('Must have', i.mustHaves), line('Deal breakers', i.dealBreakers), line('Priority 1 titles (find these first)', i.targetTitles), line('Priority 2 titles (if no P1)', i.p2Titles), line('Priority 3 titles (last resort)', i.p3Titles), line('Never target', i.avoidTitles)].filter(Boolean).join('\n'))
    .join('\n\n');
  return [
    'Every day, find new companies that fit the ICPs below, and for each company one contact with a priority title. Use Zintlr to get the contact\'s phone number and email.',
    '',
    icpText || '(no active ICP yet)',
    '',
    'Order of work (this saves Zintlr credits: never reveal a phone or email before step 3):',
    '1. Find a company and its best contact (P1 titles first, then P2, then P3) WITHOUT revealing contact details.',
    `2. Check the company in the sheet tabs "${KNOWN_TAB_DEFAULT}" and "${FEED_TAB_DEFAULT}": match by Domain first, then by company name (ignore Pvt, Ltd, Limited, India, brackets and case). If it is listed in either tab, skip it and spend nothing on it. The "${KNOWN_TAB_DEFAULT}" tab lists every company the CRM already has and is refreshed every morning before you start; never edit it.`,
    '3. Only then reveal the phone number and email, for that ONE contact. If either one cannot be found, stop and skip the company.',
    '',
    'Rules:',
    '- One row per company, one contact each: never a second person at the same company.',
    `- Write each company as a new row in the Google Sheet tab "${FEED_TAB_DEFAULT}" with exactly these columns: ${FEED_COLUMNS.join(' | ')}.`,
    `- The ICP column must be exactly one of: ${list.map((i) => i.segment).join(', ') || '(none)'}.`,
    '- Do not edit or delete earlier rows.',
  ].join('\n');
}

/** Whether the feed's own settings are present (names only: for the Settings page). */
export const feedConfigured = () => !!process.env.LEAD_FEED_SHEET_ID?.trim() && !!googleCredentials();
export const feedTab = () => process.env.LEAD_FEED_SHEET_TAB?.trim() || FEED_TAB_DEFAULT;
export { feedIcps };

/**
 * Once: the scheduled Serper prospect search (the 6 am Morning Sample and the evening one) is switched off for good, because the feed
 * now brings in the leads (it waits for LEAD_FEED_SHEET_ID: until the feed has a sheet, nothing replaces the search). It is the Settings checkbox "morningSearch" set to off, so an administrator can still turn it back on there;
 * this only runs once and never switches it off again. Contact checks on leads already in the CRM are separate and keep running.
 */
export async function switchOffSerperSearchOnce(db: Db): Promise<void> {
  // Only once the feed has a sheet: with nothing replacing it, switching the search off would leave the draw with no leads.
  if (!process.env.LEAD_FEED_SHEET_ID?.trim()) return;
  const key = 'serperSearchOffV1';
  if ((await db.select().from(settings).where(eq(settings.key, key))).length) return;
  const s = await getSettings(db);
  if (s.morningSearch) await saveSettings(db, { ...s, morningSearch: false });
  await db.insert(settings).values({ key, value: { at: new Date().toISOString(), was: s.morningSearch } }).onConflictDoNothing();
}
