import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/csv';
import { rowsToKnown } from '@/lib/known-companies';
import { KnownBranches } from '@/lib/branches';

// The shape of INVECK's exported lead sheet (made-up companies): two Company Name columns, either may
// hold the name, sometimes two different companies on one row, emails in a name cell, states as locations.
const SHEET = [
  'Company Name ,Company Name ,Company Location ',
  'Alpha Pipes Limited,Alpha Pipes Limited,New Delhi ',
  'Bravo Motors Ltd,,',
  ',Charlie Boilers Limited,',
  'Delta Foods Pvt Ltd,Echo Machines Limited,Pune',
  ',Foxtrot Batteries Ltd,Dhanbad',
  ',Foxtrot Batteries Ltd,Lucknow',
  'sales@golfauto.com,Golf Auto Industries,India',
  'Hotel Drinks Pvt Ltd,Hotel Drinks International,Gujrat',
].join('\n');

describe("INVECK's own lead sheet with two company columns", () => {
  const rows = rowsToKnown(parseCsv(SHEET, undefined, { keepBlank: true }));

  it('reads a company from either column, and both when a row names two', () => {
    const names = [...new Set(rows.map((r) => r.company))];
    expect(names).toEqual(['Alpha Pipes Limited', 'Bravo Motors Ltd', 'Charlie Boilers Limited', 'Delta Foods Pvt Ltd', 'Echo Machines Limited', 'Foxtrot Batteries Ltd', 'Golf Auto Industries', 'Hotel Drinks Pvt Ltd', 'Hotel Drinks International']);
    // The same name in both columns is one entry; two companies on a row share its location.
    expect(rows.filter((r) => r.company === 'Alpha Pipes Limited')).toHaveLength(1);
    expect(rows.filter((r) => r.location === 'Pune').map((r) => r.company)).toEqual(['Delta Foods Pvt Ltd', 'Echo Machines Limited']);
  });

  it('takes an email in a name cell as the website, and every location of a company', () => {
    expect(rows.find((r) => r.company === 'Golf Auto Industries')).toMatchObject({ website: 'golfauto.com', location: 'India' });
    expect(rows.filter((r) => r.company === 'Foxtrot Batteries Ltd').map((r) => r.location)).toEqual(['Dhanbad', 'Lucknow']);
  });

  it('a company on the sheet is skipped wherever it is: one company, one lead', () => {
    const known = new KnownBranches(rows.map((r) => ({ company: r.company, website: r.website, city: r.location })), []);
    expect(known.has('Hotel Drinks International', '', 'Ahmedabad')).toBe('lead');
    expect(known.has('Golf Auto Industries Ltd', '', 'Gurgaon')).toBe('lead');
    expect(known.has('Foxtrot Batteries', '', 'Lucknow')).toBe('lead');
    expect(known.has('Foxtrot Batteries', '', 'Pune')).toBe('lead');
    expect(known.has('Charlie Boilers', '', 'Chennai')).toBe('lead');
  });
});
