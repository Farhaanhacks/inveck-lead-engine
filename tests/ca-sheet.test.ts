import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { clients, leads, sheetFirms, users } from '@/lib/db/schema';
import { CA_PER_ASSOCIATE, caAssociates, firmKey, getCaDraw, parseFirms, runCaDraw, toContactRow } from '@/lib/ca-sheet';

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

const HEADER = ['Firm', 'Phone', 'Email', 'Services', 'Website', '.', 'ICAI profile URL'];
const row = (n: number, extra: Partial<Record<'firm' | 'phone' | 'email' | 'website' | 'location' | 'url', string>> = {}) => [
  extra.firm ?? `FIRM ${n} & CO`,
  extra.phone ?? `98${String(10000000 + n)}`,
  extra.email ?? `firm${n}@example.com`,
  'Audit, Taxation',
  extra.website ?? (n % 2 ? `https://www.firm${n}.in/` : ''),
  extra.location ?? 'PUNE, MAHARASHTRA, INDIA',
  extra.url ?? `https://caconnect.icai.org/firmProfile/${1000 + n}/2`,
];
const sheet = (n: number, from = 1) => [HEADER, ...Array.from({ length: n }, (_, i) => row(from + i))];
const monday = new Date('2026-09-28T03:30:00Z'); // Monday 09:00 India time
const tuesday = new Date('2026-09-29T03:30:00Z');

describe('reading the sheet', () => {
  it('maps the columns by their headers, and a firm listed twice is one firm', () => {
    const rows = [...sheet(3), row(2, { firm: 'FIRM 2 AND COMPANY' })];
    const r = parseFirms(rows);
    expect(r.error).toBe('');
    expect(r.firms).toHaveLength(3);
    expect(r.duplicates).toBe(1);
    expect(r.firms[0]).toMatchObject({ firm: 'FIRM 1 & CO', phones: ['9810000001'], emails: ['firm1@example.com'], services: 'Audit, Taxation', website: 'https://www.firm1.in/', location: 'PUNE, MAHARASHTRA, INDIA', key: 'icai:1001', rowNumber: 2 });
  });

  it('the key is the ICAI firm number, else the profile URL, else the name and phone; a missing Firm column is reported, not guessed', () => {
    expect(firmKey({ profileUrl: 'https://caconnect.icai.org/firmProfile/4530/2', firm: 'X', phones: [] })).toBe('icai:4530');
    expect(firmKey({ profileUrl: 'https://example.org/p/9?x=1', firm: 'X', phones: [] })).toBe('url:example.org/p/9');
    expect(firmKey({ profileUrl: '', firm: 'A & B Co.', phones: ['98450 12345'] })).toBe('name:abco|9845012345');
    expect(parseFirms([['Name of CA', 'Phone'], ['X', '1']]).error).toMatch(/no "Firm" column/);
  });

  it('keeps everything useful for the lead: phone, email, website, city and the firm\'s services and profile', () => {
    const f = parseFirms(sheet(1)).firms[0];
    expect(toContactRow(f)).toMatchObject({ company: 'FIRM 1 & CO', website: 'firm1.in', city: 'Pune', phones: ['9810000001'], emails: ['firm1@example.com'], people: [] });
    expect(toContactRow(f).remark).toContain('Services: Audit, Taxation');
    expect(toContactRow(f).remark).toContain('ICAI profile: https://caconnect.icai.org/firmProfile/1001/2');
  });
});

describe('the daily CA allocation', () => {
  const draw = (n: number, when = monday, from = 1, extra: { force?: boolean } = {}) => runCaDraw(db, { now: when, source: async () => sheet(n, from), ...extra });
  const ownerOf = async (name: string) => (await caAssociates(db)).find((a) => a.name === name)!.id;

  it('gives Anchal and Puja 10 random firms each, creates leads only for those, and can be retried safely', async () => {
    const record = await draw(60);
    expect(record).toMatchObject({ wanted: 20, drawn: 20, short: false, remaining: 40, added: 20 });
    expect(record!.perAssociate.map((a) => [a.name, a.drawn])).toEqual([['Anchal', 10], ['Puja', 10]]);
    const made = await db.select().from(leads);
    expect(made).toHaveLength(20); // 20 leads, not the 60 rows
    expect(made.every((l) => l.segment === 'CA Firms' && l.status === 'New' && l.source.startsWith('Imported list'))).toBe(true);
    const [anchal, puja] = [await ownerOf('Anchal'), await ownerOf('Puja')];
    expect(made.filter((l) => l.ownerId === anchal)).toHaveLength(10);
    expect(made.filter((l) => l.ownerId === puja)).toHaveLength(10);
    // Company information kept.
    const one = made.find((l) => l.company === 'FIRM 1 & CO') ?? made[0];
    expect(one.contactPhone).toMatch(/^98\d+$/);
    expect(one.city).toBe('Pune');
    expect(one.remark).toContain('Services: Audit, Taxation');
    // Persisted: source id, assignment and day.
    const rows = await db.select().from(sheetFirms);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.assignedOn === '2026-09-28' && r.leadId !== null && r.sourceKey.startsWith('icai:'))).toBe(true);
    // Run again the same day, even forced: nothing more, no duplicates.
    const again = await draw(60, monday, 1, { force: true });
    expect(again).toMatchObject({ drawn: 20, added: 0 });
    expect(await db.select().from(leads)).toHaveLength(20);
    expect(await getCaDraw(db, '2026-09-28')).toMatchObject({ drawn: 20 });
  });

  it('the next working day gives 20 different firms; a firm is never given twice', async () => {
    await draw(60);
    const first = new Set((await db.select().from(sheetFirms)).map((r) => r.sourceKey));
    await draw(60, tuesday);
    const all = await db.select().from(sheetFirms);
    expect(all).toHaveLength(40);
    expect(new Set(all.map((r) => r.sourceKey)).size).toBe(40);
    expect(all.filter((r) => r.assignedOn === '2026-09-29' && first.has(r.sourceKey))).toHaveLength(0);
  });

  it('with too few firms the ones there are go out, the shortfall is shown per associate, and a later top-up fills the gaps', async () => {
    const record = await draw(12);
    expect(record).toMatchObject({ wanted: 20, drawn: 12, short: true, remaining: 0 });
    expect(record!.perAssociate.map((a) => a.drawn)).toEqual([6, 6]);
    // More firms appear in the sheet later the same day (checked again by an admin or after half an hour).
    const topped = await draw(40, monday, 1, { force: true });
    expect(topped).toMatchObject({ drawn: 20, short: false });
    expect(topped!.perAssociate.map((a) => a.drawn)).toEqual([10, 10]);
    expect(await db.select().from(leads)).toHaveLength(20);
  });

  it('a short draw is not re-read straight away, but is after half an hour', async () => {
    await draw(12);
    let reads = 0;
    const source = async () => (reads++, sheet(40));
    await runCaDraw(db, { now: new Date(monday.getTime() + 5 * 60_000), source });
    expect(reads).toBe(0);
    await runCaDraw(db, { now: new Date(monday.getTime() + 31 * 60_000), source });
    expect(reads).toBe(1);
  });

  it('skips firms that are already leads or clients, and weekends', async () => {
    await db.insert(leads).values({ company: 'FIRM 1 & CO', website: '', segment: 'Manufacturing' });
    await db.insert(clients).values({ company: 'FIRM 2 & CO' });
    const record = await draw(22);
    expect(record!.drawn).toBe(20);
    expect((await db.select().from(sheetFirms)).map((r) => r.company)).not.toContain('FIRM 1 & CO');
    expect((await db.select().from(sheetFirms)).map((r) => r.company)).not.toContain('FIRM 2 & CO');
    expect(await runCaDraw(db, { now: new Date('2026-09-26T05:00:00Z'), source: async () => sheet(5) })).toBeNull(); // Saturday
  });

  it('finds Anchal and Puja whatever the spelling or capitalisation, and assigns only to them', async () => {
    await db.update(users).set({ name: 'AANCHAL' }).where(eq(users.username, 'anchal@inveck'));
    await draw(30);
    const owners = new Set((await db.select().from(leads)).map((l) => l.ownerId));
    const ids = (await db.select().from(users)).filter((u) => ['anchal@inveck', 'puja@inveck'].includes(u.username)).map((u) => u.id);
    expect([...owners].sort()).toEqual(ids.sort());
    await db.update(users).set({ active: false }).where(eq(users.username, 'puja@inveck'));
    const record = await draw(30, tuesday);
    expect(record!.problem).toContain('Puja has no active user account');
    expect(record!.perAssociate.map((a) => a.name)).toEqual(['Anchal']);
  });

  it('a firm recorded as given whose lead was never made gets its lead on the next run, without being picked twice', async () => {
    const anchal = await ownerOf('Anchal');
    await db.insert(sheetFirms).values({ sourceKey: 'icai:1001', company: 'FIRM 1 & CO', ownerId: anchal, assignedOn: '2026-09-28' });
    await draw(30, monday, 1, { force: true });
    const rows = await db.select().from(sheetFirms);
    expect(rows.filter((r) => r.sourceKey === 'icai:1001')).toHaveLength(1);
    expect(rows.every((r) => r.leadId !== null)).toBe(true);
    expect((await db.select().from(leads)).filter((l) => l.company === 'FIRM 1 & CO')).toHaveLength(1);
  });

  it('reports an unreadable or wrong sheet instead of failing, and does nothing without the key', async () => {
    const bad = await runCaDraw(db, { now: monday, source: async () => [['Name', 'Phone'], ['X', '1']] });
    expect(bad!.problem).toMatch(/no "Firm" column/);
    const down = await runCaDraw(db, { now: monday, force: true, source: async () => { throw new Error('Google Sheets: 403'); } });
    expect(down!.problem).toContain('Google Sheets: 403');
    expect(await db.select().from(leads)).toHaveLength(0);
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    expect(await runCaDraw(db, { now: monday })).toBeNull();
    expect(CA_PER_ASSOCIATE).toBe(10);
  });
});
