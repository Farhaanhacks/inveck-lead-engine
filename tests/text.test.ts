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
  it('fills email patterns', () => {
    expect(fillPattern('{first}.{last}', 'Ravi', 'Shah')).toBe('ravi.shah');
    expect(fillPattern('{f}{last}', 'Neha', 'Kapoor')).toBe('nkapoor');
    expect(fillPattern('{first}.{middle}', 'A', 'B')).toBe('');
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

describe('company email formats', () => {
  const r = (title: string, snippet: string) => ({ title, snippet, link: 'https://example.org' });

  it('reads the formats data providers publish', async () => {
    const { parseEmailFormat } = await import('@/lib/pipeline/email-format');
    // RocketReach
    expect(
      parseEmailFormat('Honeywell', 'honeywell.com', [
        r('Honeywell Email Format', 'The most common Honeywell email format is [first].[last] (ex. jane.doe@honeywell.com) being used 88.4% of the time. Other common Honeywell email patterns are [first_initial][last] (ex. jdoe@honeywell.com) 5.2%.'),
      ]),
    ).toEqual({ pattern: '{first}.{last}', share: 88.4, domain: 'honeywell.com', strong: true });
    // ZoomInfo-style list
    expect(
      parseEmailFormat('Honeywell', '', [r('Honeywell Email Format', 'Honeywell uses 3 email formats: 1. first_last@honeywell.com (4.1%). 2. first.last@honeywell.com (86.2%). 3. flast@honeywell.com (2.3%).')]),
    ).toMatchObject({ pattern: '{first}.{last}', share: 86.2, domain: 'honeywell.com' });
    // LeadIQ-style sentence, no percentage
    expect(
      parseEmailFormat('Honeywell International', 'honeywell.com', [r('Honeywell email format', "Honeywell's email format typically follows the pattern of FirstName.LastName@honeywell.com.")]),
    ).toMatchObject({ pattern: '{first}.{last}', domain: 'honeywell.com', strong: true });
    // A different email domain from the website's
    expect(
      parseEmailFormat('John Deere', 'deere.co.in', [r('John Deere Email Format', 'The most common John Deere email format is [last][first] (ex. doejane@johndeere.com) being used 67% of the time.')]),
    ).toMatchObject({ pattern: '{last}{first}', share: 67, domain: 'johndeere.com' });
    // Written out in words
    expect(
      parseEmailFormat('Metalman Auto', 'metalmanauto.com', [r('Metalman Auto email format', 'Metalman Auto (metalmanauto.com) uses first initial + last name, e.g. jdoe@metalmanauto.com, 71% of the time.')]),
    ).toMatchObject({ pattern: '{f}{last}', domain: 'metalmanauto.com' });
  });

  it("never uses another company's format", async () => {
    const { parseEmailFormat } = await import('@/lib/pipeline/email-format');
    expect(parseEmailFormat('Honeywell', 'honeywell.com', [r('Honda Email Format', 'first.last@honda.com (90%)')])).toBeNull();
    // Same first word, different company and domain.
    expect(parseEmailFormat('Crystal Logistic Cool Chain', 'crystalgroup.in', [r('Crystal email format', 'Crystal uses first.last@crystal.com (91%)')])).toBeNull();
    expect(parseEmailFormat('Kusshal Loggistics', 'kusshal.in', [r('Top logistics firms in Mumbai', 'A list of warehousing companies')])).toBeNull();
  });

  it('reads masked addresses on people-search pages', async () => {
    const { maskedPattern } = await import('@/lib/pipeline/email-format');
    expect(maskedPattern('m****.s****', 'Mayank', 'Singh')).toBe('{first}.{last}');
    expect(maskedPattern('m.s****', 'Mayank', 'Singh')).toBe('{f}.{last}');
    expect(maskedPattern('s****m****', 'Mayank', 'Singh')).toBe('{last}{first}');
    expect(maskedPattern('m***', 'Mayank', 'Singh')).toBe(''); // could be anything
    expect(maskedPattern('s****.s****', 'Sunil', 'Shah')).toBe(''); // same initials: unclear
  });

  it('builds addresses only when the needed name parts exist', async () => {
    const { fillPattern } = await import('@/lib/pipeline/email-format');
    expect(fillPattern('{first}.{last}', 'Ashamol', '')).toBe('');
    expect(fillPattern('{first}', 'Ashamol', '')).toBe('ashamol');
    expect(fillPattern('{last}{first}', 'Sanjay', 'Soni')).toBe('sonisanjay');
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
  });
});
