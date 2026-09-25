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
    ['Sangamnath S Digge', 'Sangamnath', 'Digge', 's'],
    ['R P Sharma', 'R', 'Sharma', 'p'],
    ['RABINDRA PRATAP SINGH', 'RABINDRA', 'SINGH', 'p'],
    ['Dr. Anil Kumar', 'Anil', 'Kumar', ''],
    ['Sandeep Welling, CA', 'Sandeep', 'Welling', ''],
    ['Vijay Agrawal (He/Him)', 'Vijay', 'Agrawal', ''],
    ['CA Manish Shah', 'Manish', 'Shah', ''],
    ['Madonna', '', 'Madonna', ''],
  ])('splits %s', (name, first, last, middle) => {
    expect(splitName(name)).toEqual({ first, last, middle });
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

describe('apiKeys', () => {
  it('cleans up pasted keys', async () => {
    const { apiKeys } = await import('@/lib/settings');
    process.env.DEEPSEEK_API_KEY = '  Bearer sk-abc123\n';
    process.env.SERPER_API_KEY = '"serper1"';
    expect(apiKeys().deepseek).toBe('sk-abc123');
    expect(apiKeys().serper).toBe('serper1');
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SERPER_API_KEY;
  });
});

describe('pickOfficialDomain', () => {
  it('finds the company site among search results', async () => {
    const { pickOfficialDomain } = await import('@/lib/pipeline/website');
    const r = (link: string) => ({ link, title: '' });
    expect(pickOfficialDomain('Bodal Chemicals Ltd.', [r('https://www.indiamart.com/bodal'), r('https://www.bodal.com/')])).toBe('bodal.com');
    expect(pickOfficialDomain('West Coast Pharmaceuticals Works Ltd.', [r('https://in.linkedin.com/company/wc'), r('https://westcoastin.com/')])).toBe('westcoastin.com');
    expect(pickOfficialDomain('Tata AutoComp Systems', [r('https://www.tatamotors.com'), r('https://www.tatautocomp.com')])).toBe('tatautocomp.com');
    expect(pickOfficialDomain('20 Microns Ltd', [r('https://www.20microns.com')])).toBe('20microns.com');
    expect(pickOfficialDomain('Bajaj Finance', [r('https://www.bharatforge.com'), r('https://www.justdial.com/bajaj')])).toBe('');
  });
});

describe('email formats and phones', () => {
  it('uses middle initials and learns a company format from the web', async () => {
    const { fillPattern, inferPattern, personalEmails } = await import('@/lib/pipeline/emails');
    expect(fillPattern('{f}{m}.{last}', 'Rabindra', 'Singh', 'p')).toBe('rp.singh');
    expect(fillPattern('{f}{m}.{last}', 'Anil', 'Kumar')).toBe('');
    const found = personalEmails(['info@tataautocomp.com', 'A.Kumar@tataautocomp.com', 'sm.patil@tataautocomp.com', 'x@gmail.com', 'r.shah@tataautocomp.com.'], 'tataautocomp.com');
    expect(found).toEqual(['a.kumar@tataautocomp.com', 'sm.patil@tataautocomp.com', 'r.shah@tataautocomp.com']);
    expect(inferPattern(found)).toBe('{f}.{last}');
    expect(inferPattern(['ravi.shah@x.com', 'neha.kapoor@x.com'])).toBe('{first}.{last}');
  });
  it('reads the office phone off a website', async () => {
    const { websitePhone } = await import('@/lib/pipeline/research');
    expect(websitePhone('Corporate office, Pune. Tel: +91 20 6608 5000. Founded 1995.')).toBe('+91 20 6608 5000');
    expect(websitePhone('Call us 020-66085000 today')).toBe('020-66085000');
    expect(websitePhone('Annual report 2019-2020 and 2020-2021')).toBe('');
  });
});
