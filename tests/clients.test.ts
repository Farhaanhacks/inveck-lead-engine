import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { clients, leads } from '@/lib/db/schema';
import { detectDelimiter, parseCsv, toCsv } from '@/lib/csv';
import { describeImport, importClients, rowsToClients } from '@/lib/clients';

describe('CSV', () => {
  it('reads what Excel writes: BOM, quoted commas, quotes and line breaks in cells', () => {
    const text = '﻿Company,Website,Industry,Why they bought\r\n"Haldex, India",haldex.com,Brakes,"Multi-plant ""stock"" audit\nand year-end"\r\n\r\nTata Motors,tatamotors.com,,\r\n';
    expect(parseCsv(text)).toEqual([
      ['Company', 'Website', 'Industry', 'Why they bought'],
      ['Haldex, India', 'haldex.com', 'Brakes', 'Multi-plant "stock" audit\nand year-end'],
      ['Tata Motors', 'tatamotors.com', '', ''],
    ]);
  });

  it('detects semicolon and tab separated files', () => {
    expect(detectDelimiter('Company;Website;Industry\nA;a.com;x')).toBe(';');
    expect(detectDelimiter('Company\tWebsite\nA\ta.com')).toBe('\t');
    expect(parseCsv('Haldex\thaldex.com\tBrakes\nMaxion\tmaxion.com\tWheels')).toEqual([
      ['Haldex', 'haldex.com', 'Brakes'],
      ['Maxion', 'maxion.com', 'Wheels'],
    ]);
  });

  it('writes CSV that round-trips and never runs formulas in Excel', () => {
    const rows = [['Company', 'Why'], ['A, B', 'said "hi"'], ['=HYPERLINK("x")', '+91 20 1234']];
    const csv = toCsv(rows);
    expect(csv).toContain('"A, B","said ""hi"""');
    expect(parseCsv(csv)).toEqual([['Company', 'Why'], ['A, B', 'said "hi"'], ["'=HYPERLINK(\"x\")", "'+91 20 1234"]]);
  });
});

describe('reading client rows', () => {
  it('recognises column names in any order', () => {
    expect(
      rowsToClients([
        ['Sector', 'Company Name', 'Notes', 'Domain', 'Owner'],
        ['Brakes', 'Haldex India', 'Stock audit', 'https://www.haldex.com/in', 'Ravi'],
      ]),
    ).toEqual([{ company: 'Haldex India', website: 'haldex.com', industry: 'Brakes', whyBought: 'Stock audit' }]);
  });

  it('reads columns in order when there is no header row', () => {
    expect(rowsToClients([['Haldex', 'haldex.com', 'Brakes', 'Multi-plant stock audit', 'annual']])).toEqual([
      { company: 'Haldex', website: 'haldex.com', industry: 'Brakes', whyBought: 'Multi-plant stock audit, annual' },
    ]);
  });

  it('skips rows without a company', () => {
    expect(rowsToClients([['Company', 'Website'], ['', 'x.com'], ['Maxion', '']])).toEqual([
      { company: 'Maxion', website: '', industry: '', whyBought: '' },
    ]);
  });
});

describe('importing clients', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  it('adds new clients, fills blanks on existing ones without overwriting, and skips duplicates', async () => {
    await db.insert(clients).values([
      { company: 'Tata Motors', website: '', industry: 'Automotive', whyBought: '' },
    ]);
    const result = await importClients(db, [
      { company: 'Tata Motors Ltd', website: 'tatamotors.com', industry: 'Cars', whyBought: 'Plant stock checks' },
      { company: 'Haldex', website: 'haldex.com', industry: 'Brakes', whyBought: '' },
      { company: 'HALDEX INDIA PVT LTD', website: '', industry: '', whyBought: '' },
    ]);
    expect(result).toEqual({ added: 1, updated: 1, skipped: 1, leadsMarked: 0 });
    const rows = await db.select().from(clients);
    const tata = rows.find((r) => r.company === 'Tata Motors')!;
    expect(tata).toMatchObject({ website: 'tatamotors.com', industry: 'Automotive', whyBought: 'Plant stock checks' });
    expect(rows.map((r) => r.company).sort()).toEqual(['Haldex', 'Tata Motors']);
    expect(describeImport(result)).toBe('Added 1 client, filled in details for 1, skipped 1 already on the list.');
  });

  it('marks matching leads as Existing Client, by name or website, but not contacted ones', async () => {
    await db.insert(leads).values([
      { company: 'Haldex India Pvt Ltd', website: 'haldexindia.in', status: 'Awaiting Approval' },
      { company: 'HX Brakes', website: 'https://in.haldex.com/', status: 'New' },
      { company: 'Haldex', website: '', status: 'Contacted' },
      { company: 'Bharat Forge', website: 'bharatforge.com', status: 'New' },
    ]);
    const result = await importClients(db, [{ company: 'Haldex', website: 'haldex.com', industry: '', whyBought: '' }]);
    expect(result.leadsMarked).toBe(2);
    const byName = Object.fromEntries((await db.select().from(leads)).map((l) => [l.company, l.status]));
    expect(byName).toEqual({
      'Haldex India Pvt Ltd': 'Existing Client',
      'HX Brakes': 'Existing Client',
      Haldex: 'Contacted',
      'Bharat Forge': 'New',
    });
  });
});
