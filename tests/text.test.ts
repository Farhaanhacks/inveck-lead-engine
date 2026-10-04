import { describe, expect, it } from 'vitest';
import { asBool, asText, asTextList, domainOf, normCompany, splitName } from '@/lib/pipeline/text';
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
    // The Bharat Forge reply: a missing colon after a property name.
    expect(parseJsonObject('{"fit_score" 8, "qualified": true}').data).toEqual({ fit_score: 8, qualified: true });
    expect(parseJsonObject('Here it is: {"a": "x",}').data).toEqual({ a: 'x' });
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
    ['ASHAMOL A P', 'ASHAMOL', '', ''],
  ])('splits %s', (name, first, last, middle) => {
    expect(splitName(name)).toEqual({ first, last, middle });
  });
  it('normalises domains and company names', () => {
    expect(domainOf('https://www.Haldex.com/en/')).toBe('haldex.com');
    expect(domainOf('tatamotors.com')).toBe('tatamotors.com');
    expect(normCompany('Haldex India Pvt Ltd')).toBe(normCompany('Haldex'));
    expect(normCompany('Tata Motors Limited')).toBe(normCompany('Tata Motors'));
  });
});

describe('scoring', () => {
  it('scores the ICP fit times ten, whatever the contact details, and drafts for an email or LinkedIn', () => {
    const withLinkedIn = { ...EMPTY_CONTACT, name: 'A B', linkedin: 'u', roleMatch: true };
    expect(scoreLead(8, withLinkedIn, 'no email found')).toMatchObject({ finalScore: 80, reachable: true, status: 'Awaiting Approval' });
    const withEmail = { ...EMPTY_CONTACT, name: 'A B', email: 'a@b.com', roleMatch: true };
    expect(scoreLead(8, withEmail, 'valid')).toMatchObject({ finalScore: 80, reachable: true, status: 'Awaiting Approval' });
    expect(scoreLead(8, { ...EMPTY_CONTACT }, 'no email found')).toMatchObject({ reachable: false, status: 'Needs Manual Contact' });
  });

  it('never holds back a reachable, qualified lead because of its score', () => {
    // Assam Petro-Chemicals: strong fit, Managing Director, a likely (unconfirmed) email.
    const md = { ...EMPTY_CONTACT, name: 'R G', title: 'Managing Director', email: 'r@a.co.in', roleMatch: false };
    expect(scoreLead(8, md, 'likely')).toMatchObject({ finalScore: 80, reachable: true, status: 'Awaiting Approval' });
    // Weaker fit, reachable only through LinkedIn: still gets a draft to review.
    const linkedinOnly = { ...EMPTY_CONTACT, name: 'A B', title: 'Store Manager', linkedin: 'u', roleMatch: false };
    expect(scoreLead(6, linkedinOnly, 'no email found')).toMatchObject({ finalScore: 60, reachable: true, status: 'Awaiting Approval' });
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

describe('readDraft', () => {
  it('reads drafts whatever the fields are called', async () => {
    const { readDraft } = await import('@/lib/pipeline/draft');
    expect(readDraft({ email_subject: 'S', email_body: 'B', linkedin_message: 'L' })).toEqual({ subject: 'S', body: 'B', linkedin: 'L' });
    expect(readDraft({ subject: 'S', body: 'B' })).toEqual({ subject: 'S', body: 'B', linkedin: '' });
    expect(readDraft({ email: { subject: 'S', body: 'B' }, linkedin: { message: 'L' } })).toEqual({ subject: 'S', body: 'B', linkedin: 'L' });
    expect(readDraft({ emailSubject: 'S', emailContent: 'B', linkedinMessage: 'L' })).toEqual({ subject: 'S', body: 'B', linkedin: 'L' });
    expect(readDraft({ email_subject: 'S' }).body).toBe('');
  });
});

describe('matching domains to companies', () => {
  it('scores real company domains and rejects look-alikes', async () => {
    const { domainScore } = await import('@/lib/pipeline/website');
    const { rootDomain } = await import('@/lib/pipeline/text');
    expect(rootDomain('https://buildings.honeywell.com/in/en')).toBe('honeywell.com');
    expect(rootDomain('www.cwls.co.in')).toBe('cwls.co.in');
    expect(domainScore('Cummins', 'cumminscollege.org')).toBe(0);
    expect(domainScore('Cummins', 'cumminsindia.com')).toBeGreaterThanOrEqual(3);
    expect(domainScore('John Deere', 'johndeere.com')).toBeGreaterThanOrEqual(3);
    expect(domainScore('Crystal Logistic Cool Chain', 'crystal.com')).toBeLessThan(3);
    expect(domainScore('Tata AutoComp Systems', 'tatautocomp.com')).toBeGreaterThan(domainScore('Tata AutoComp Systems', 'tatamotors.com'));
    expect(domainScore('Yazaki India Private Limited', 'yazaki-group.com')).toBeGreaterThanOrEqual(3);
    // A shared first word is another company: Madras Fertilizers is not Madras Engineering Industries.
    expect(domainScore('Madras Engineering Industries Private Limited', 'madrasfert.com')).toBe(0);
    expect(domainScore('Madras Engineering Industries Private Limited', 'madrasengineering.com')).toBeGreaterThan(0);
    expect(domainScore('Ultra Drugs Pvt Ltd', 'ultracorpotech.com')).toBe(0);
  });
});
