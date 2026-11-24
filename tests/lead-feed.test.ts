import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { clients, icps, leadFeedRows, leads, people, settings } from '@/lib/db/schema';
import { feedIcps, feedProblem, instinctBrief, knownRows, lastFeedReport, parseFeed, publishKnown, syncLeadFeed, FEED_COLUMNS, KNOWN_HEADER } from '@/lib/lead-feed';
import { knownCompanies } from '@/lib/db/schema';
import { writeTab } from '@/lib/google-sheet';
import { drawPool, runDailyDraw } from '@/lib/draw';
import { getSettings, saveSettings } from '@/lib/settings';

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  delete process.env.LEAD_FEED_SHEET_ID;
  resetDbForTests();
  db = await getDb();
});

const HEAD = ['ICP', 'Company', 'Website', 'Location', 'Contact Name', 'Designation', 'LinkedIn URL', 'Phone', 'Email'];
const row = (icp: string, company: string, extra: Partial<Record<(typeof HEAD)[number], string>> = {}) => {
  const v: Record<string, string> = { ICP: icp, Company: company, Website: '', Location: 'Pune', 'Contact Name': 'Asha Rao', Designation: 'Head - Operations', 'LinkedIn URL': 'https://in.linkedin.com/in/asha', Phone: '+91 98765 43210', Email: 'asha@example.com', ...extra };
  return HEAD.map((h) => v[h]);
};
const sync = (...rows: string[][]) => syncLeadFeed(db, { source: async () => [HEAD, ...rows] });

describe('reading the sheet', () => {
  it('finds the columns by header in any order and reports a missing one', () => {
    const swapped = parseFeed([['E-mail', 'Mobile', 'Organisation', 'First Name', 'Last Name', 'Title', 'Segment'], ['a@b.in', '9876543210', 'Acme Forge', 'Asha', 'Rao', 'Plant Head', 'Manufacturing']]);
    expect(swapped.error).toBe('');
    expect(swapped.rows[0]).toMatchObject({ company: 'Acme Forge', name: 'Asha Rao', title: 'Plant Head', icp: 'Manufacturing', phones: ['9876543210'], emails: ['a@b.in'] });
    expect(parseFeed([['Company', 'Phone']]).error).toMatch(/no ICP, Contact Name, Email column/);
    expect(parseFeed([]).error).toBe('The sheet is empty.');
    expect(FEED_COLUMNS).toHaveLength(9);
  });

  it('a usable row needs an ICP the app has, a contact, and BOTH a valid phone and a valid email', async () => {
    const active = await feedIcps(db);
    const p = (r: string[]) => feedProblem(parseFeed([HEAD, r]).rows[0], active);
    expect(p(row('Manufacturing', 'Acme')).reason).toBe('');
    expect(p(row('3PL & Logistics', 'Swift')).segment).toBe('3PL & Logistics');
    expect(p(row('Retail', 'Acme')).reason).toMatch(/ICP "Retail"/);
    expect(p(row('CA Firms', 'Acme')).reason).toMatch(/not one of the app's active ICPs/);
    expect(p(row('Manufacturing', 'Acme', { Email: '' })).reason).toBe('no valid email');
    expect(p(row('Manufacturing', 'Acme', { Email: 'not-an-email' })).reason).toBe('no valid email');
    expect(p(row('Manufacturing', 'Acme', { Phone: '' })).reason).toBe('no valid phone number');
    expect(p(row('Manufacturing', 'Acme', { Phone: '123', Email: '' })).reason).toBe('no phone number and no email');
    expect(p(row('Manufacturing', 'Acme', { 'Contact Name': '' })).reason).toBe('no contact name');
  });
});

describe('the sync', () => {
  it('makes an Approved lead with no source, its contact and ICP stamp, ready for the draw; nothing else is touched', async () => {
    const r = await sync(row('Manufacturing', 'Acme Forge Pvt Ltd', { Website: 'https://www.acmeforge.com/about' }));
    expect(r).toMatchObject({ read: 1, imported: 1, duplicates: 0, error: '' });
    const [l] = await db.select().from(leads).where(eq(leads.company, 'Acme Forge Pvt Ltd'));
    expect(l).toMatchObject({ status: 'Approved', qualified: true, source: '', segment: 'Manufacturing', ownerId: null, contactName: 'Asha Rao', contactTitle: 'Head - Operations', contactPhone: '+91 98765 43210', contactEmail: 'asha@example.com', website: 'acmeforge.com', city: 'Pune', inbound: false });
    expect(l.contactVerifiedAt).not.toBeNull();
    expect(l.contactCheckedAt).not.toBeNull();
    expect(l.productId).not.toBeNull();
    expect(l.icpId).not.toBeNull();
    const [person] = await db.select().from(people).where(eq(people.leadId, l.id));
    expect(person).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', isPrimary: true });
    const [ledger] = await db.select().from(leadFeedRows);
    expect(ledger).toMatchObject({ state: 'imported', leadId: l.id });
    expect(ledger.raw.Company).toBe('Acme Forge Pvt Ltd');
  });

  it('never repeats a company: against leads, clients and itself, whatever the spelling or city', async () => {
    await db.insert(leads).values({ company: 'Hosur Gears Private Limited', segment: 'Manufacturing', status: 'Contacted', website: 'hosurgears.in' });
    await db.insert(clients).values({ company: 'Swift Cargo', website: 'swiftcargo.in' });
    const r = await sync(
      row('Manufacturing', 'Hosur Gears Pvt. Ltd.', { Location: 'Chennai' }),
      row('3PL & Logistics', 'Swift Cargo India', { Website: 'swiftcargo.in' }),
      row('Manufacturing', 'Brand New Works'),
      row('Manufacturing', 'Brand New Works Ltd', { 'Contact Name': 'Someone Else', Email: 'else@example.com' }),
    );
    expect(r).toMatchObject({ imported: 1, duplicates: 3 });
    expect((await db.select().from(leads)).map((l) => l.company).sort()).toEqual(['Brand New Works', 'Hosur Gears Private Limited']);
    const states = Object.fromEntries((await db.select().from(leadFeedRows)).map((x) => [x.company, x.state]));
    expect(states['Hosur Gears Pvt. Ltd.']).toBe('duplicate');
    expect(states['Brand New Works']).toBe('imported');
  });

  it('is safe to run again: imported companies are not touched, unusable rows are read again and imported once fixed', async () => {
    const bad = row('Manufacturing', 'Needs Email', { Email: '' });
    const first = await sync(row('Manufacturing', 'Good Co'), bad);
    expect(first).toMatchObject({ imported: 1 });
    expect(first.skipped).toEqual([{ company: 'Needs Email', sheetRow: 3, reason: 'no valid email' }]);
    const again = await sync(row('Manufacturing', 'Good Co'), bad);
    expect(again).toMatchObject({ read: 2, imported: 0, duplicates: 0 });
    expect(again.skipped).toHaveLength(1);
    const fixed = await sync(row('Manufacturing', 'Good Co'), row('Manufacturing', 'Needs Email', { Email: 'now@example.com' }));
    expect(fixed).toMatchObject({ imported: 1, skipped: [] });
    expect(await db.select().from(leads).where(eq(leads.source, ''))).toHaveLength(2);
    expect((await lastFeedReport(db))?.imported).toBe(1);
  });

  it('turns the Serper morning search off once, when the feed first brings in leads; turning it back on is respected', async () => {
    await saveSettings(db, { ...(await getSettings(db)), morningSearch: true });
    const none = await sync(row('Manufacturing', 'No Email Co', { Email: '' }));
    expect(none.searchSwitchedOff).toBe(false);
    expect((await getSettings(db)).morningSearch).toBe(true);
    const first = await sync(row('Manufacturing', 'First Co'));
    expect(first.searchSwitchedOff).toBe(true);
    expect((await getSettings(db)).morningSearch).toBe(false);
    await saveSettings(db, { ...(await getSettings(db)), morningSearch: true });
    const second = await sync(row('Manufacturing', 'Second Co'));
    expect(second.searchSwitchedOff).toBe(false);
    expect((await getSettings(db)).morningSearch).toBe(true);
  });

  it('says what is missing when the sheet is not set up or cannot be read, and changes nothing', async () => {
    expect((await syncLeadFeed(db)).error).toMatch(/LEAD_FEED_SHEET_ID/);
    const unreadable = await syncLeadFeed(db, { source: async () => { throw new Error('Google Sheets: The caller does not have permission'); } });
    expect(unreadable.error).toMatch(/Share it with the service account/);
    expect(await db.select().from(leads)).toHaveLength(0);
    expect((await syncLeadFeed(db, { source: async () => [['Company', 'Phone']] })).error).toMatch(/no ICP/);
  });
});

describe('after the sync, the normal draw takes over', () => {
  it('a fed lead is in the draw pool and the morning draw deals it to an associate', async () => {
    await sync(row('Manufacturing', 'Fresh Fed Works'));
    expect((await drawPool(db)).bySegment.Manufacturing).toBeGreaterThanOrEqual(1);
    // A working morning after the draw hour (a fresh database already holds today's draw record).
    const day = new Date();
    do day.setUTCDate(day.getUTCDate() + 1);
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6 || day.getTime() - Date.now() < 2 * 86_400_000);
    day.setUTCHours(4, 30, 0, 0);
    const rec = await runDailyDraw(db, { now: day });
    expect(rec?.drawn).toBeGreaterThanOrEqual(1);
    const [l] = await db.select().from(leads).where(eq(leads.company, 'Fresh Fed Works'));
    expect(l.ownerId).not.toBeNull();
    expect(l.drawnOn).not.toBe('');
  });
});

describe('the brief for Instinct', () => {
  it('is built from the active drawn ICPs (their priority titles) and the sheet columns; CA firms are not in it', async () => {
    const brief = instinctBrief(await feedIcps(db));
    expect(brief).toContain('ICP: Manufacturing');
    expect(brief).toContain('Priority 1 titles');
    expect(brief).toContain(FEED_COLUMNS.join(' | '));
    // Credits are only spent after the duplicate check, and only on one contact per company.
    expect(brief).toContain('never reveal a phone or email before step 3');
    expect(brief).toMatch(/Check the company in the sheet tabs "Known" and "Leads"/);
    expect(brief).toContain('If either one cannot be found, stop and skip the company');
    expect(brief).not.toContain('ICP: CA Firms');
    const [m] = await db.select().from(icps).where(eq(icps.segment, 'Manufacturing'));
    expect(brief).toContain(m.targetTitles.split('\n')[0].trim().slice(0, 20));
    void settings;
  });
});

describe('the Known tab: what Instinct checks before it spends credits', () => {
  it('lists every company the CRM has, once: leads of any stage, clients, the own list and earlier feed rows, with domain and match key', async () => {
    await db.insert(leads).values([
      { company: 'Hosur Gears Pvt Ltd', website: 'hosurgears.in', segment: 'Manufacturing', status: 'Contacted' },
      { company: 'Old Forge', website: '', segment: 'Manufacturing', status: 'Deleted' },
      { company: 'Hosur Gears Private Limited', website: 'www.hosurgears.in', segment: 'Manufacturing', status: 'Approved' },
    ]);
    await db.insert(clients).values({ company: 'Swift Cargo', website: 'swiftcargo.in' });
    await db.insert(knownCompanies).values({ company: 'Our Own List Co', website: 'ownlist.com', location: 'Pune' });
    await sync(row('Manufacturing', 'Feed Delivered Co', { Email: '' }));
    const rows = await knownRows(db);
    expect(rows[0]).toEqual([...KNOWN_HEADER]);
    const byName = Object.fromEntries(rows.slice(1).map((r) => [r[0], r]));
    expect(Object.keys(byName).sort()).toEqual(['Feed Delivered Co', 'Hosur Gears Pvt Ltd', 'Old Forge', 'Our Own List Co', 'Swift Cargo']);
    expect(byName['Hosur Gears Pvt Ltd']).toEqual(['Hosur Gears Pvt Ltd', 'hosurgears.in', 'hosurgear', 'CRM lead']);
    expect(byName['Old Forge'][3]).toBe('CRM lead');
    expect(byName['Swift Cargo'][3]).toBe('Client');
    expect(byName['Our Own List Co'][3]).toBe('Own list');
    expect(byName['Feed Delivered Co'][3]).toBe('Instinct feed');
  });

  it('is written after a sync, with its count in the report; a failed write is reported and never undoes the import', async () => {
    let written: string[][] = [];
    const ok = await syncLeadFeed(db, { source: async () => [HEAD, row('Manufacturing', 'Acme Works')], writeKnown: async (r) => { written = r; } });
    expect(ok).toMatchObject({ imported: 1, known: 1, knownError: '' });
    expect(written.map((r) => r[0])).toEqual(['Company', 'Acme Works']);
    const bad = await syncLeadFeed(db, { source: async () => [HEAD, row('Manufacturing', 'Other Works')], writeKnown: async () => { throw new Error('Google Sheets: The caller does not have permission'); } });
    expect(bad.imported).toBe(1);
    expect(bad.knownError).toMatch(/Known tab could not be updated.*Editor/);
    expect(await db.select().from(leads).where(eq(leads.company, 'Other Works'))).toHaveLength(1);
    expect((await publishKnown(db, { write: async () => {} })).count).toBe(2);
    await expect(publishKnown(db)).rejects.toThrow(/lead sheet is not set/);
  });

  it('the sheet writer makes the tab when it is missing, clears it, then writes the rows, with the read-write scope', async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const pem = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    const fake = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '' });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      if (url.includes('fields=sheets')) return new Response(JSON.stringify({ sheets: [{ properties: { title: 'Leads' } }] }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await writeTab('SHEET1', 'Known', [['Company'], ['Acme']], { client_email: 'svc@x.iam.gserviceaccount.com', private_key: pem }, fake);
    const steps = calls.filter((c) => !c.url.includes('oauth2')).map((c) => `${c.method} ${decodeURIComponent(c.url.split('/spreadsheets/')[1])}`);
    expect(steps).toEqual(["GET SHEET1?fields=sheets.properties.title", 'POST SHEET1:batchUpdate', "POST SHEET1/values/'Known':clear", "PUT SHEET1/values/'Known'!A1?valueInputOption=RAW"]);
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('batchUpdate'))!.body).toContain('"title":"Known"');
    expect(calls.at(-1)!.body).toContain('"Acme"');
    // The sign-in asked for the read-write scope (the assertion is in the signed claim, which is base64url JSON).
    const jwt = new URLSearchParams(calls[0].body).get('assertion')!.split('.')[1];
    expect(JSON.parse(Buffer.from(jwt, 'base64url').toString()).scope).toBe('https://www.googleapis.com/auth/spreadsheets');
  });
});
