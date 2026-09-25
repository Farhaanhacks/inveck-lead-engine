import { describe, expect, it } from 'vitest';
import { asBool, asText, asTextList, domainOf, normCompany, splitName } from '@/lib/pipeline/text';
import { fillPattern } from '@/lib/pipeline/emails';
import { scoreLead } from '@/lib/pipeline/scoring';
import { EMPTY_CONTACT } from '@/lib/pipeline/contacts';
import { parseJsonObject } from '@/lib/pipeline/ai';

describe('reading AI answers', () => {
  it('turns any list shape into strings', () => {
    expect(asTextList(['Plant Head', 'COO'])).toEqual(['Plant Head', 'COO']);
    expect(asTextList('Plant Head, COO')).toEqual(['Plant Head', 'COO']);
    expect(asTextList([{ role: 'Plant Head', priority: 1 }, { title: 'COO' }])).toEqual(['Plant Head', 'COO']);
    expect(asTextList({ role: 'CFO' })).toEqual(['CFO']);
    expect(asTextList(null)).toEqual([]);
    expect(asTextList(['A', null, 5])).toEqual(['A', '5']);
  });
  it('reads text and booleans of any type', () => {
    expect(asText({ reason: 'fits' })).toBe('fits');
    expect(asText(['a', 'b'])).toBe('a, b');
    expect(asText(7)).toBe('7');
    expect(asBool('true')).toBe(true);
    expect(asBool('Yes')).toBe(true);
    expect(asBool(1)).toBe(true);
    expect(asBool('false')).toBe(false);
    expect(asBool(undefined)).toBe(false);
  });
  it('parses fenced JSON and rejects non-objects', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```').data).toEqual({ a: 1 });
    expect(parseJsonObject('[1,2]').error).toBeTruthy();
    expect(parseJsonObject('Sorry').error).toContain('Could not read');
    expect(parseJsonObject('').error).toBeTruthy();
  });
});

describe('names, domains and companies', () => {
  it.each([
    ['Sangamnath S Digge', 'Sangamnath', 'Digge'],
    ['R P Sharma', 'R', 'Sharma'],
    ['Dr. Anil Kumar', 'Anil', 'Kumar'],
    ['Sandeep Welling, CA', 'Sandeep', 'Welling'],
    ['Vijay Agrawal (He/Him)', 'Vijay', 'Agrawal'],
    ['CA Manish Shah', 'Manish', 'Shah'],
    ['Madonna', '', 'Madonna'],
  ])('splits %s', (name, first, last) => {
    expect(splitName(name)).toEqual({ first, last });
  });
  it('normalises domains and company names', () => {
    expect(domainOf('https://www.Haldex.com/en/')).toBe('haldex.com');
    expect(domainOf('tatamotors.com')).toBe('tatamotors.com');
    expect(normCompany('Haldex India Pvt Ltd')).toBe(normCompany('Haldex'));
    expect(normCompany('Tata Motors Limited')).toBe(normCompany('Tata Motors'));
  });
  it('fills email patterns', () => {
    expect(fillPattern('{first}.{last}', 'Ravi', 'Shah')).toBe('ravi.shah');
    expect(fillPattern('{f}{last}', 'Neha', 'Kapoor')).toBe('nkapoor');
    expect(fillPattern('{first}.{middle}', 'A', 'B')).toBe('');
  });
});

describe('scoring', () => {
  it('drafts for a verified email or a LinkedIn profile', () => {
    const withLinkedIn = { ...EMPTY_CONTACT, name: 'A B', linkedin: 'u', roleMatch: true };
    expect(scoreLead(8, withLinkedIn, 'no email found', 55)).toMatchObject({ finalScore: 65, readyForDraft: true });
    const withEmail = { ...EMPTY_CONTACT, name: 'A B', email: 'a@b.com', roleMatch: true };
    expect(scoreLead(8, withEmail, 'valid', 55)).toMatchObject({ finalScore: 80, readyForDraft: true });
    expect(scoreLead(8, { ...EMPTY_CONTACT }, 'no email found', 55)).toMatchObject({ readyForDraft: false, statusWithoutDraft: 'Needs Manual Contact' });
    expect(scoreLead(4, withLinkedIn, 'no email found', 55)).toMatchObject({ readyForDraft: false, statusWithoutDraft: 'Low Score' });
  });
});
