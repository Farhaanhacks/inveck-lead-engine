import { beforeEach, describe, expect, it } from 'vitest';
import { settingsSchema } from '@/lib/settings';
import type { EnrichmentCache, Services } from '@/lib/pipeline/services';
import { distanceKm, forgetPlaces, knowPlaces, placeKey, pointOf } from '@/lib/pipeline/places';
import { learnFirm, linkedinPageName, recallFirm } from '@/lib/pipeline/firm-identity';
import { firmAliasesOf, sameFirm, siteOf } from '@/lib/pipeline/employer';
import { atOtherSite, confirmedAtSite, contactSearchPlan, personSite, searchLinkedIn } from '@/lib/pipeline/contacts';
import { cleanTitle, companyWide, contactPriority, noDepartment, tierOf } from '@/lib/tiers';
import { DEFAULT_ICPS } from '@/lib/db/seed';

/** Where Google Maps puts these places (a town comes back with no business type). */
const MAP: Record<string, { latitude: number; longitude: number; type?: string }> = {
  sanand: { latitude: 22.992, longitude: 72.377 },
  ahmedabad: { latitude: 23.02, longitude: 72.58 },
  hyderabad: { latitude: 17.41, longitude: 78.41 },
  dolvi: { latitude: 18.702, longitude: 73.05 },
  panvel: { latitude: 18.99, longitude: 73.12 },
  raigad: { latitude: 18.236, longitude: 73.443, type: 'Tourist attraction' },
  coimbatore: { latitude: 11.017, longitude: 76.956 },
  chennai: { latitude: 13.083, longitude: 80.271 },
};

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

function memoryCache(): EnrichmentCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return { store, get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))) };
}

type Seen = { maps: string[]; searches: string[] };

function services(seen: Seen, organic: (q: string) => unknown[] = () => [], cache?: EnrichmentCache): Services {
  const fetchFn = (async (u: RequestInfo | URL, init: RequestInit = {}) => {
    const q = String(JSON.parse(String(init.body)).q);
    if (String(u).endsWith('/maps')) {
      seen.maps.push(q);
      const hit = Object.entries(MAP).find(([k]) => q.toLowerCase().startsWith(k))?.[1];
      return json({ places: hit ? [{ title: 'x', ...hit }] : [] });
    }
    seen.searches.push(q);
    return json({ organic: organic(q) });
  }) as typeof fetch;
  return { fetch: fetchFn, keys: { serper: 'k' } as never, settings: settingsSchema.parse({}), cache };
}

let seen: Seen;
beforeEach(() => {
  seen = { maps: [], searches: [] };
  forgetPlaces();
});

describe('the same site is a matter of distance', () => {
  it('counts people in the metro area, not those in another city, and looks each place up once', async () => {
    const cache = memoryCache();
    const svc = services(seen, () => [], cache);
    await knowPlaces(svc, ['Sanand', 'Ahmedabad, Gujarat, India', 'Greater Ahmedabad Area', 'Hyderabad, Telangana, India', 'Gujarat, India']);
    expect(Math.round(distanceKm(pointOf('Sanand')!, pointOf('Ahmedabad, Gujarat, India')!))).toBeLessThan(30);
    expect(siteOf('Ahmedabad, Gujarat, India', 'Sanand')).toBe('here');
    expect(siteOf('Greater Ahmedabad Area', 'Sanand')).toBe('here');
    expect(siteOf('Hyderabad, Telangana, India', 'Sanand')).toBe('elsewhere');
    // A state alone says nothing about the site, and isn't looked up.
    expect(siteOf('Gujarat, India', 'Sanand')).toBe('unknown');
    expect(seen.maps.some((q) => q.startsWith('gujarat'))).toBe(false);
    // Kept in the database: another run asks nothing.
    const asked = seen.maps.length;
    forgetPlaces();
    await knowPlaces(services(seen, () => [], cache), ['Sanand', 'Hyderabad, Telangana, India']);
    expect(seen.maps.length).toBe(asked);
    expect(siteOf('Hyderabad, Telangana, India', 'Sanand')).toBe('elsewhere');
  });

  it('a place the map does not know, or knows only as a landmark, is "not known", never "elsewhere"', async () => {
    const svc = services(seen);
    await knowPlaces(svc, ['Dolvi', 'Raigad, Maharashtra, India', 'Kharsundi, Maharashtra', 'Panvel, Maharashtra, India']);
    expect(pointOf('Raigad, Maharashtra, India')).toBeNull();
    expect(siteOf('Raigad, Maharashtra, India', 'Dolvi')).toBe('unknown');
    expect(siteOf('Kharsundi, Maharashtra', 'Dolvi')).toBe('unknown');
    expect(siteOf('Panvel, Maharashtra, India', 'Dolvi')).toBe('here');
    expect(placeKey('Greater Ahmedabad Area')).toBe('ahmedabad');
  });
});

describe("the company's LinkedIn page name", () => {
  const page = { title: 'Micron Technology | LinkedIn', link: 'https://www.linkedin.com/company/micron-technology', snippet: 'Website: http://www.micron.com. External link for Micron Technology ; Industry: Semiconductor Manufacturing' };
  const other = { title: 'Micron Instruments | LinkedIn', link: 'https://in.linkedin.com/company/micron-instruments', snippet: 'Website: http://www.microninstruments.in' };

  it('is taken only from a page listing the company website, then used to match and search its people', async () => {
    expect(linkedinPageName(page, 'micron.com')).toBe('Micron Technology');
    expect(linkedinPageName(other, 'micron.com')).toBe('');
    const cache = memoryCache();
    const company = 'Micron Semiconductor Technology India';
    await learnFirm(services(seen, () => [other, page], cache), company, 'https://www.micron.com');
    expect(firmAliasesOf(company)).toEqual(['Micron Technology']);
    expect(sameFirm('Micron Technology', company)).toBe(true);
    expect(sameFirm('Micron Instruments', company)).toBe(false);
    // Searched as a name of its own: the legal name first, then the LinkedIn page's name.
    expect(contactSearchPlan(company, 'Sanand', { ...DEFAULT_ICPS[0], id: 1 } as never)[0].queries).toContain('site:linkedin.com/in "Micron Technology" "Plant Head" Sanand');
    // Looked up once: the clean-up jobs read it from the database with no search.
    const searches = seen.searches.length;
    expect(await recallFirm(cache, company, 'micron.com')).toBe(true);
    await learnFirm(services(seen, () => [], cache), company, 'micron.com');
    expect(seen.searches.length).toBe(searches);
  });

  it('end to end: Micron Sanand staff are found under the LinkedIn name and kept by distance', async () => {
    const company = 'Micron Semiconductor Technology India';
    const organic = [
      { title: 'Sumanth G - Manufacturing Manager', subtitle: 'Ahmedabad, Gujarat, India · Manufacturing Manager · Micron Technology', link: 'https://in.linkedin.com/in/sumanth-g', snippet: '' },
      { title: 'Chaithanya M. - Global Category Supplier Manager', subtitle: 'Hyderabad, Telangana, India · Global Category Supplier Manager, Indirect Procurement · Micron Technology', link: 'https://in.linkedin.com/in/chaithanya-m', snippet: '' },
      { title: 'Ravi Shah - Plant Head - Micron Instruments', subtitle: 'Ahmedabad, Gujarat, India · Plant Head · Micron Instruments', link: 'https://in.linkedin.com/in/ravi-shah', snippet: '' },
    ];
    const svc = services(seen, (q) => (q.startsWith('site:linkedin.com/company') ? [page] : organic));
    await learnFirm(svc, company, 'micron.com');
    await knowPlaces(svc, ['Sanand']);
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "Micron Technology"', company);
    expect(people.map((p) => p.name)).toEqual(['Sumanth G', 'Chaithanya M.']);
    expect(siteOf(people[0].location, 'Sanand')).toBe('here');
    expect(siteOf(people[1].location, 'Sanand')).toBe('elsewhere');
  });
});

describe('roles read by function and seniority', () => {
  const mfg = DEFAULT_ICPS[0];
  it('places titles no list names word for word, and still leaves out engineers, associates and HR', () => {
    expect(tierOf('Senior Manager, ATSM Site Operations', mfg)).toBe('P2');
    expect(tierOf('Manufacturing Manager', mfg)).toBe('P2');
    expect(tierOf('Planning & Operations Lead', mfg)).toBe('P3');
    // Directors (other than the Managing Director) are never contacted, whatever they direct.
    expect(tierOf('Director Operations Management', mfg)).toBe('Avoid');
    expect(contactPriority('MSTI Indirect Regional Supplier Manager', mfg)).toBe(20);
    for (const t of ['Associate - Manufacturing Operations', 'Test Engineering Manager (Process & Equipment)', 'Head of Talent Acquisition', 'Supply Demand Analyst', 'Senior Manager', 'Semiconductor Manufacturing Professional']) {
      expect(contactPriority(t, mfg)).toBe(99);
    }
    // The lists still come first: a plant head is ahead of anyone placed by function.
    expect(contactPriority('Plant Head', mfg)).toBeLessThan(contactPriority('Manufacturing Manager', mfg));
  });
});

describe('Mojj Engineering: the owner-director, and a search that failed', () => {
  it("ranks the MD, an Owner or founder as the company's top (last resort); other directors are never contacted", () => {
    const mfg = DEFAULT_ICPS[0];
    for (const t of ['Owner', 'Founder & CEO', 'Managing Director', 'MD', 'CMD', 'Joint Managing Director']) expect(contactPriority(t, mfg)).toBe(50);
    for (const t of ['Director', 'Executive Director', 'Whole-time Director', 'Director - Supply Chain', 'Associate Director-Plant Head', 'Director - Marketing', 'Director Projects', 'Technical Director', 'Board Member']) {
      expect(contactPriority(t, mfg)).toBe(99);
    }
    expect(contactPriority('Plant Head', mfg)).toBeLessThan(contactPriority('Managing Director', mfg));
  });

  it('reads "Ltd" and "Limited" as the same company', () => {
    expect(sameFirm('Mojj Engineering Systems Ltd', 'Mojj Engineering Systems Limited')).toBe(true);
    expect(sameFirm('MOJJ Engineering Systems Ltd.', 'Mojj Engineering Systems Limited')).toBe(true);
  });

  it('shows a failed search as failed, not as "nobody found"', async () => {
    const { contactAvailability } = await import('@/lib/fit-view');
    const base = { contactName: '', contactTitle: '', contactEmail: '', emailStatus: '', contactLinkedin: '', contactVerifiedAt: null, city: 'Pune', status: 'Needs Manual Contact' as const, qualified: true };
    expect(contactAvailability({ ...base, refetchPending: true, lastError: 'Contacts not searched: the LinkedIn search failed (Not enough credits). Searched again automatically on a later run.' })).toMatchObject({ label: 'Search failed' });
    expect(contactAvailability(base).detail).toContain('Nobody on the ICP lists');
    // People listed but none the main contact (NBC Bearings): named, with the reason for each.
    const listed = [
      { name: 'Govind Gopalia', isPrimary: true, passedAt: new Date(), passedReason: '', location: 'Jaipur, Rajasthan, India' },
      { name: 'Rohan Katara', isPrimary: false, passedAt: new Date(), passedReason: 'tried', location: 'India' },
    ];
    const nbc = contactAvailability({ ...base, city: 'Jaipur', status: 'Awaiting Approval' }, listed);
    expect(nbc.label).toBe('Company contacts found; no Jaipur contact confirmed');
    expect(nbc.detail).toContain('Govind Gopalia (not confirmed on LinkedIn at this site yet');
    expect(nbc.detail).toContain('Rohan Katara (tried, no luck)');
  });
});

describe('Eurocast: someone who has left is never confirmed from an old copy of their profile', () => {
  const company = 'Eurocast Engineering';
  const arunStale = { title: 'Gnanaprakasam Arun - Operation head die casting - Euro Cast Engineering', subtitle: 'Coimbatore, Tamil Nadu, India · Operation head die casting · Euro Cast Engineering', link: 'https://in.linkedin.com/in/gnanaprakasam-arun', snippet: 'Experience: Euro Cast Engineering' };
  const arunEnded = { ...arunStale, snippet: 'Operation head die casting. Euro Cast Engineering. Mar 2013 - Sep 2024' };
  const arunMoved = { ...arunStale, snippet: 'Plant Manager. Hi Tech Arai. Oct 2024 - Present · Operation head die casting. Euro Cast Engineering. Mar 2013 - Sep 2024' };
  const sujeesh = { title: 'Sujeesh K - Production Manager - Eurocast Engineering', subtitle: 'Coimbatore, Tamil Nadu, India · Production Manager · Eurocast Engineering', link: 'https://in.linkedin.com/in/sujeesh-k', snippet: '' };

  it('an explicit end date overrides the undated line; a current job elsewhere means elsewhere', async () => {
    for (const arun of [arunEnded, arunMoved]) {
      const { people } = await searchLinkedIn(services(seen, () => [arun, sujeesh]), 'site:linkedin.com/in "Eurocast"', company);
      // The former operations head is left out, so the current production manager comes first.
      expect(people.map((p) => p.name)).toEqual(['Sujeesh K']);
      expect(people[0].evidence).toContain('undated');
    }
    expect(sameFirm('Euro Cast Engineering', company)).toBe(true);
  });

  it('with no dates at all, the undated line is shown as undated evidence', async () => {
    const { people } = await searchLinkedIn(services(seen, () => [arunStale]), 'site:linkedin.com/in "Eurocast"', company);
    expect(people[0]?.evidence).toContain('LinkedIn (via Google, undated)');
  });
});

describe('Auto Diecasting Company (ADC): the CEO with a comma-style title and an About-section snippet', () => {
  const company = 'Auto Diecasting Company (ADC)';
  const hari = { title: 'Hari Viswanathan - CEO, Auto Diecasting Company | LinkedIn', link: 'https://in.linkedin.com/in/hari-viswanathan', snippet: 'Experience: 18 years of experience in high pressure diecasting, with a focus on incorporating cutting-edge technologies for improved production processes.' };

  it('matches the name without its bracketed abbreviation', () => {
    expect(sameFirm('Auto Diecasting Company', company)).toBe(true);
    expect(sameFirm('Auto Diecasting', company)).toBe(true);
    expect(sameFirm('Auto Die Cast (India)', company)).toBe(false);
  });

  it('is found at the company, as CEO (the eligible top-of-company fallback)', async () => {
    const { people } = await searchLinkedIn(services(seen, () => [hari]), 'site:linkedin.com/in "Auto Diecasting Company"', company);
    expect(people.map((p) => [p.name, p.title])).toEqual([['Hari Viswanathan', 'CEO']]);
    expect(contactPriority('CEO', DEFAULT_ICPS[0])).toBe(50);
    // Searched without the bracket.
    expect(seen.searches.every((q) => !q.includes('(ADC)'))).toBe(true);
  });

  it('an "Experience:" sentence is not read as an employer; a name still is', async () => {
    const { currentEmployer } = await import('@/lib/pipeline/employer');
    expect(currentEmployer({ name: 'X', title: '', snippet: hari.snippet }, company)).toBe('unknown');
    expect(currentEmployer({ name: 'X', title: '', snippet: 'Experience: Hi Tech Arai' }, company)).toBe('elsewhere');
    expect(currentEmployer({ name: 'X', title: '', snippet: 'Experience: Auto Diecasting Company' }, company)).toBe('here');
  });

  it('leaves a one-piece role with a comma alone', async () => {
    const r = { title: 'Ravi K - Head, Operations | LinkedIn', subtitle: 'Coimbatore, Tamil Nadu, India · Head, Operations · Auto Diecasting Company', link: 'https://in.linkedin.com/in/ravi-k', snippet: '' };
    const { people } = await searchLinkedIn(services(seen, () => [r]), 'q', company);
    expect(people.map((p) => p.title)).toEqual(['Head, Operations']);
  });
});

describe('Alumina India Casting: the managing partner, and where her job is', () => {
  const company = 'Alumina India Casting';
  const mfg = DEFAULT_ICPS[0];
  const nandini = { title: 'Nandini Easwaran - Managing Partner - Alumina India Casting Company | LinkedIn', subtitle: 'Chennai, Tamil Nadu, India · Managing Partner · Alumina India Casting Company', link: 'https://in.linkedin.com/in/nandini-easwaran', snippet: '' };

  it('ranks Managing Partner like Partner and Owner (the top-of-company fallback); CA firms keep their own lists', () => {
    expect(contactPriority('Managing Partner', mfg)).toBe(50);
    expect(contactPriority('Partner', mfg)).toBe(50);
    expect(contactPriority('Owner', mfg)).toBe(50);
    const ca = DEFAULT_ICPS.find((i) => /^CA/.test(i.segment))!;
    expect(contactPriority('Managing Partner', ca)).toBeLessThan(50);
    expect(contactPriority('Channel Partner Manager', mfg)).toBe(99);
  });

  it('the location of the current job wins over the profile location', async () => {
    const svc = services(seen);
    await knowPlaces(svc, ['Coimbatore']);
    const withJob = { ...nandini, snippet: 'Managing Partner. Alumina India Casting Company. Jan 2010 - Present · 14 yrs 9 mos. Coimbatore, Tamil Nadu, India' };
    const found = (await searchLinkedIn(services(seen, () => [withJob]), 'q', company)).people[0];
    expect(found).toMatchObject({ name: 'Nandini Easwaran', title: 'Managing Partner', location: 'Chennai, Tamil Nadu, India', jobLocation: 'Coimbatore, Tamil Nadu, India' });
    expect(personSite(found, 'Coimbatore')).toBe('here');
    expect(confirmedAtSite(found, 'Coimbatore')).toBe(true);
  });

  it('when nobody at the company turns up, its owners and partners are searched for once', async () => {
    const { people } = await searchLinkedIn(services(seen, (q) => (q.includes('"managing partner"') ? [nandini] : [])), 'site:linkedin.com/in "Alumina India Casting" "Plant Head"', company);
    expect(people.map((p) => p.name)).toEqual(['Nandini Easwaran']);
    expect(seen.searches.filter((q) => q.includes('"managing partner"'))).toHaveLength(1);
  });

  it('the site a title names wins over both', async () => {
    const svc = services(seen);
    await knowPlaces(svc, ['Coimbatore', 'Chennai, Tamil Nadu, India']);
    expect(personSite({ title: 'Plant Head - Coimbatore', responsibility: 'Coimbatore', location: 'Chennai, Tamil Nadu, India' }, 'Coimbatore')).toBe('here');
    expect(personSite({ title: 'Plant Head - Chennai', responsibility: 'Chennai', location: 'Coimbatore' }, 'Coimbatore')).toBe('here');
  });

  it('with only a Chennai profile location, she is kept as a contact: anyone based in India counts, wherever the site is', async () => {
    const svc = services(seen, () => [nandini]);
    await knowPlaces(svc, ['Coimbatore']);
    const found = (await searchLinkedIn(svc, 'q', company)).people[0];
    expect(found).toMatchObject({ name: 'Nandini Easwaran', jobLocation: '', responsibility: '' });
    expect(personSite(found, 'Coimbatore')).toBe('here');
    expect(atOtherSite(found, 'Coimbatore')).toBe(false);
    expect(confirmedAtSite(found, 'Coimbatore')).toBe(true);
    // A plant manager based in Chennai is still at another site.
    expect(atOtherSite({ ...found, title: 'Plant Manager' }, 'Coimbatore')).toBe(false);
  });
});

describe('equivalent titles are read the same way', () => {
  const mfg = DEFAULT_ICPS[0];
  it('Chief Executive Officer is the CEO; formatting left by Google is ignored; combined top titles are the top', () => {
    expect(contactPriority('Chief Executive Officer', mfg)).toBe(contactPriority('CEO', mfg));
    expect(contactPriority('CEO', mfg)).toBe(50);
    expect(cleanTitle('EXECUTIVE DIRECTORSINCE 1999.')).toBe('EXECUTIVE DIRECTOR');
    expect(contactPriority('EXECUTIVE DIRECTORSINCE 1999.', mfg)).toBe(contactPriority('Executive Director', mfg));
    expect(contactPriority('President & Chief Technical Officer', mfg)).toBe(50);
    expect(contactPriority('Chief Operating Officer', mfg)).toBe(contactPriority('COO', mfg));
    // CMD is the Chairman and Managing Director (Viscon Rubber).
    expect(contactPriority('CMD', mfg)).toBe(50);
    expect(companyWide('CMD')).toBe(true);
    for (const t of ['Chief Executive Officer', 'EXECUTIVE DIRECTOR', 'President & Chief Technical Officer', 'Managing Partner']) expect(companyWide(t)).toBe(true);
    for (const t of ['Deputy Manager', 'Plant Head', 'Vice President Operations']) expect(companyWide(t)).toBe(false);
  });

  it('a level with no department is named as such, not as a wrong role', () => {
    expect(noDepartment('Deputy Manager')).toBe(true);
    expect(contactPriority('Deputy Manager', mfg)).toBe(99);
    expect(noDepartment('Deputy Manager - Production')).toBe(false);
    expect(noDepartment('HR Manager')).toBe(false);
    // A title that says what they do has a department, whatever it is (EL Forge).
    for (const t of ['Manager Indirect Taxation', 'AGM - NPD', 'Manager - Metallurgy', 'DY GEN MANAGER MARKETING']) expect(noDepartment(t)).toBe(false);
    expect(noDepartment('Vice President')).toBe(true);
  });
});

describe('search evidence is read in full before deciding (contact pipeline review)', () => {
  const company = 'Hosur Gears';
  const mfg = DEFAULT_ICPS[0];

  it('merges the results for one profile: a specific city from one result fills in "India" from another', async () => {
    const vague = { title: 'Ravi Kumar - Plant Head - Hosur Gears', subtitle: 'India · Plant Head · Hosur Gears', link: 'https://in.linkedin.com/in/ravi-kumar', snippet: '' };
    const placed = { ...vague, subtitle: 'Hosur, Tamil Nadu, India · Plant Head · Hosur Gears', link: 'https://www.linkedin.com/in/ravi-kumar/' };
    const first = 'site:linkedin.com/in "Hosur Gears" "Plant Head" Hosur';
    const svc = services(seen, (q) => (q === first ? [vague] : [placed]));
    await knowPlaces(svc, ['Hosur']);
    const { people } = await searchLinkedIn(svc, '', company, 'Hosur', mfg);
    expect(seen.searches[0]).toBe(first);
    expect(people).toHaveLength(1);
    expect(people[0].location).toBe('Hosur, Tamil Nadu, India');
  });

  it('a "Present" job here contradicted by another current job is kept for verification, never taken as fact', async () => {
    const r = { title: 'Meena S - Plant Head', subtitle: 'Hosur, Tamil Nadu, India · Consultant · Lean Partners', link: 'https://in.linkedin.com/in/meena-s', snippet: 'Plant Head. Hosur Gears Pvt Ltd. Jan 2023 - Present 1 year 9 months. Hosur, Tamil Nadu, India' };
    const { people } = await searchLinkedIn(services(seen, () => [r]), 'q', company);
    expect(people.map((p) => [p.name, p.title])).toEqual([['Meena S', 'Plant Head']]);
    expect(people[0].conflict).toContain('LinkedIn shows two current jobs: Plant Head at Hosur Gears Pvt Ltd, and Consultant at Lean Partners; needs verification');
    // Two dated current jobs contradict each other the same way.
    const two = { ...r, subtitle: '', snippet: 'Plant Head. Hosur Gears Pvt Ltd. Jan 2023 - Present · Director. Lean Partners. Mar 2024 - Present' };
    expect((await searchLinkedIn(services(seen, () => [two]), 'q', company)).people[0].conflict).toContain('needs verification');
    // Looked up by name, the contradiction is not a confirmation.
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const found = await findLinkedinProfile(services(seen, () => [r]), 'Meena S', company, { city: 'Hosur' });
    expect(found).toMatchObject({ employer: 'unknown' });
    expect(found?.evidence).toContain('needs verification');
    // With nothing contradicting it, a dated current job here is the job.
    const plain = { ...r, subtitle: 'Hosur, Tamil Nadu, India · Plant Head · Hosur Gears' };
    expect((await searchLinkedIn(services(seen, () => [plain]), 'q', company)).people[0].conflict).toBeUndefined();
    // Without the dated job here, the other company's line means elsewhere.
    expect((await searchLinkedIn(services(seen, () => [{ ...r, snippet: '' }]), 'q', company)).people).toEqual([]);
  });

  it('results are combined by LinkedIn address, never by name; and a former job\'s city is never taken as where the job is', async () => {
    const a = { title: 'Ravi Kumar - Plant Head - Hosur Gears', subtitle: 'India · Plant Head · Hosur Gears', link: 'https://in.linkedin.com/in/ravi-kumar', snippet: '' };
    const namesake = { title: 'Ravi Kumar - Stores Manager - Hosur Gears', subtitle: 'Hosur, Tamil Nadu, India · Stores Manager · Hosur Gears', link: 'https://in.linkedin.com/in/ravi-kumar-2', snippet: '' };
    const { people } = await searchLinkedIn(services(seen, () => [a, namesake]), 'q', company);
    expect(people.map((p) => [p.linkedin, p.location])).toEqual([
      ['https://in.linkedin.com/in/ravi-kumar', 'India'],
      ['https://in.linkedin.com/in/ravi-kumar-2', 'Hosur, Tamil Nadu, India'],
    ]);
    // A job here that ended, in Hosur; the current one elsewhere: no Hosur job location, not at the site.
    const moved = { title: 'Divya N - Plant Head', subtitle: '', link: 'https://in.linkedin.com/in/divya-n', snippet: 'Plant Head. Hosur Gears. Jan 2015 - Dec 2022 8 years. Hosur, Tamil Nadu, India · Plant Head. Other Gears. Jan 2023 - Present. Pune, Maharashtra, India' };
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const found = await findLinkedinProfile(services(seen, () => [moved]), 'Divya N', company, { city: 'Hosur' });
    expect(found).toMatchObject({ employer: 'elsewhere', jobLocation: '' });
  });

  it('keeps searching past people who fail the checks (HR), designation by designation, into P2', async () => {
    const hr = { title: 'Asha R - HR Manager - Hosur Gears', subtitle: 'Hosur, Tamil Nadu, India · HR Manager · Hosur Gears', link: 'https://in.linkedin.com/in/asha-r', snippet: '' };
    const manager = { title: 'Vikram P - Supply Chain Manager - Hosur Gears', subtitle: 'Hosur, Tamil Nadu, India · Supply Chain Manager · Hosur Gears', link: 'https://in.linkedin.com/in/vikram-p', snippet: '' };
    const svc = services(seen, (q) => (q.includes('"Supply Chain Manager"') ? [manager] : [hr]));
    await knowPlaces(svc, ['Hosur']);
    const { people } = await searchLinkedIn(svc, '', company, 'Hosur', mfg);
    expect(people.map((p) => p.name)).toEqual(['Vikram P', 'Asha R']);
    // Every P1 designation was searched before the first P2 one; one acceptable contact is not four,
    // so the rest of P2 and P3 were searched too.
    const searched = seen.searches.filter((q) => q.startsWith('site:linkedin.com/in'));
    expect(searched.findIndex((q) => q.includes('"Supply Chain Manager"'))).toBe(9);
    expect(searched.at(-1)).toBe('site:linkedin.com/in "Hosur Gears" "Logistics Manager" Hosur');
  });

  it('a candidate with two current jobs does not stop the search; their own profile is looked up and settles it', async () => {
    const meena = { title: 'Meena S - Plant Head', subtitle: 'Hosur, Tamil Nadu, India · Consultant · Lean Partners', link: 'https://in.linkedin.com/in/meena-s', snippet: 'Plant Head. Hosur Gears Pvt Ltd. Jan 2023 - Present. Hosur, Tamil Nadu, India' };
    const settled = { ...meena, subtitle: 'Hosur, Tamil Nadu, India · Plant Head · Hosur Gears', snippet: 'Plant Head. Hosur Gears Pvt Ltd. Jan 2023 - Present. Hosur, Tamil Nadu, India' };
    const svc = services(seen, (q) => (q.includes('"Meena S"') ? [settled] : [meena]));
    await knowPlaces(svc, ['Hosur']);
    const { people } = await searchLinkedIn(svc, 'site:linkedin.com/in "Hosur Gears" "Plant Head" Hosur', company, 'Hosur', mfg);
    // Every role search ran (nobody passed), then her own profile settled it.
    expect(seen.searches.some((q) => q.includes('"Meena S"'))).toBe(true);
    expect(people.map((p) => [p.name, p.conflict])).toEqual([['Meena S', undefined]]);
  });

  it('a same-name profile at another company does not end the lookup: the one at this company is found', async () => {
    const { findLinkedinProfile } = await import('@/lib/pipeline/contacts');
    const namesake = { title: 'Suresh Babu - Plant Head - Other Forge', subtitle: 'Chennai, Tamil Nadu, India · Plant Head · Other Forge', link: 'https://in.linkedin.com/in/suresh-babu-1', snippet: '' };
    const him = { title: 'Suresh Babu - Plant Head - Hosur Gears', subtitle: 'Hosur, Tamil Nadu, India · Plant Head · Hosur Gears', link: 'https://in.linkedin.com/in/suresh-babu-2', snippet: '' };
    let n = 0;
    const svc = services(seen, () => (n++ === 0 ? [namesake] : [him]));
    const found = await findLinkedinProfile(svc, 'Suresh Babu', company, { title: 'Plant Head', city: 'Hosur' });
    expect(found).toMatchObject({ employer: 'here', url: 'https://in.linkedin.com/in/suresh-babu-2' });
    // Only a namesake anywhere: they work elsewhere (after at most two more searches).
    seen.searches.length = 0;
    const gone = await findLinkedinProfile(services(seen, () => [namesake]), 'Suresh Babu', company, { title: 'Plant Head', city: 'Hosur' });
    expect(gone?.employer).toBe('elsewhere');
    expect(seen.searches.length).toBeLessThanOrEqual(3);
  });
});

describe('only people based in India are contacts (Windwalker Logistics)', () => {
  it('a US metro area on a non-India profile is abroad; an unlisted Indian town on an in.linkedin.com profile is kept', async () => {
    const { basedAbroad } = await import('@/lib/pipeline/employer');
    expect(basedAbroad('Greater Sioux Falls Area', '', 'https://www.linkedin.com/in/morgan-grumley')).toBe(true);
    expect(basedAbroad('Greater Tiruchirappalli Area', '', 'https://in.linkedin.com/in/someone')).toBe(false);
    expect(basedAbroad('Pune, Maharashtra, India', '', 'https://www.linkedin.com/in/someone')).toBe(false);
    const morgan = { title: 'Morgan Grumley - Logistics Manager - Windwalker Logistics Inc', subtitle: 'Greater Sioux Falls Area · Logistics Manager · Windwalker Logistics Inc', link: 'https://www.linkedin.com/in/morgan-grumley', snippet: '' };
    expect((await searchLinkedIn(services(seen, () => [morgan]), 'q', 'Windwalker Logistics')).people).toEqual([]);
  });
});

describe('contact search, one designation at a time (Hosur Gears, manufacturing)', () => {
  const company = 'Hosur Gears';
  const mfg = DEFAULT_ICPS[0];
  const KEY = 'test-serper-key-0042';
  /** A Google result for someone at a company: "Name - Title - Company", with the line under it. */
  const person = (name: string, title: string, opts: { place?: string; firm?: string; link?: string; snippet?: string } = {}) => ({
    title: `${name} - ${title} - ${opts.firm ?? company}`,
    subtitle: `${opts.place ?? 'Hosur, Tamil Nadu, India'} · ${title} · ${opts.firm ?? company}`,
    link: opts.link ?? `https://in.linkedin.com/in/${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    snippet: opts.snippet ?? '',
  });
  const q = (designation: string, town = 'Hosur') => `site:linkedin.com/in "${company}" "${designation}"${town ? ` ${town}` : ''}`;
  const search = async (organic: (query: string) => unknown[]) => {
    const svc = { ...services(seen, organic), keys: { serper: KEY } as never };
    await knowPlaces(svc, ['Hosur']);
    const logs: string[] = [];
    const result = await searchLinkedIn(svc, '', company, 'Hosur', mfg, (m) => void logs.push(m));
    return { ...result, logs, searched: seen.searches.filter((s) => s.startsWith('site:linkedin.com/in')) };
  };

  it('builds one query per designation from the ICP: P1 (plant heads first), then P2, then P3, never an OR of roles', () => {
    const plan = contactSearchPlan(company, 'Hosur, Tamil Nadu', mfg);
    expect(plan.slice(0, 2).map((s) => s.designation)).toEqual(['Plant Head', 'Plant Manager']);
    const tiers = plan.map((s) => s.tier);
    expect(tiers.lastIndexOf('P1')).toBeLessThan(tiers.indexOf('P2'));
    expect(tiers.lastIndexOf('P2')).toBeLessThan(tiers.indexOf('P3'));
    // Every designation the ICP lists (and only those), once each: "Logistics Manager" is on no list twice here.
    const listed = [mfg.targetTitles, mfg.p2Titles, mfg.p3Titles].join(',').split(',').map((t) => t.trim());
    for (const s of plan) expect(['Plant Manager', ...listed]).toContain(s.designation);
    expect(new Set(plan.map((s) => s.designation)).size).toBe(plan.length);
    // The query shape: company, designation, LinkedIn profiles, the town; then the same without the town.
    expect(plan[0].queries).toEqual([q('Plant Head'), q('Plant Head', '')]);
    for (const s of plan) for (const query of s.queries) expect(query).not.toMatch(/ OR /);
  });

  it('moves from P1 to P2 to P3 while fewer than four are acceptable, and ranks what it found by INVECK\'s priority', async () => {
    const { people, searched, logs } = await search((query) =>
      query === q('Plant Head')
        ? [person('Ravi Kumar', 'Plant Head')]
        : query === q('Inventory Manager')
          ? [person('Vikram P', 'Inventory Manager')]
          : query === q('Store Manager')
            ? [person('Lata M', 'Store Manager')]
            : [],
    );
    expect(people.map((p) => [p.name, tierOf(p.title, mfg)])).toEqual([
      ['Ravi Kumar', 'P1'],
      ['Vikram P', 'P2'],
      ['Lata M', 'P3'],
    ]);
    // Someone at the company turned up for "Plant Head" in Hosur: no search without the town for it.
    expect(searched[0]).toBe(q('Plant Head'));
    expect(searched).not.toContain(q('Plant Head', ''));
    // Nobody for "Plant Manager" in Hosur: the same designation without the town, then the next one.
    expect(searched.slice(1, 4)).toEqual([q('Plant Manager'), q('Plant Manager', ''), q('Head of Supply Chain')]);
    const firstP2 = searched.findIndex((s) => s.includes('"Supply Chain Manager"'));
    expect(searched.slice(0, firstP2).every((s) => /"(Plant Head|Plant Manager|Head of Supply Chain|Supply Chain Head|Operations Head|Manufacturing Head|VP Supply Chain|VP Operations|AVP Operations)"/.test(s))).toBe(true);
    expect(searched).toContain(q('Store Manager'));
    // Someone passed, so the leadership search never ran.
    expect(searched.some((s) => /\(owner OR founder/.test(s))).toBe(false);
    // What was searched, what came back and why each person was taken; never the search key.
    expect(logs).toContain(`P1 1/20 "Plant Head": ${q('Plant Head')} → 1 LinkedIn profile`);
    expect(logs.some((l) => l.startsWith('  accepted: Ravi Kumar (Plant Head): P1'))).toBe(true);
    expect(logs.at(-1)).toBe('contact search done: 3 acceptable contacts (Ravi Kumar, Plant Head; Vikram P, Inventory Manager; Lata M, Store Manager)');
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('stops once four distinct people are acceptable', async () => {
    const byDesignation: Record<string, ReturnType<typeof person>> = {
      [q('Plant Head')]: person('Anil A', 'Plant Head'),
      [q('Plant Manager')]: person('Bina B', 'Plant Manager'),
      [q('Head of Supply Chain')]: person('Chetan C', 'Head of Supply Chain'),
      [q('Supply Chain Head')]: person('Deepa D', 'Supply Chain Head'),
      [q('Operations Head')]: person('Esha E', 'Operations Head'),
    };
    const { people, searched, logs } = await search((query) => (byDesignation[query] ? [byDesignation[query]] : []));
    expect(searched).toEqual([q('Plant Head'), q('Plant Manager'), q('Head of Supply Chain'), q('Supply Chain Head')]);
    expect(people.map((p) => p.name)).toEqual(['Anil A', 'Bina B', 'Chetan C', 'Deepa D']);
    expect(logs.at(-1)).toMatch(/^contact search done: 4 acceptable contacts/);
  });

  it('counts a person found by several searches once, keeping the best evidence from each', async () => {
    const undated = person('Ravi Kumar', 'Plant Head', { place: 'India' });
    const dated = { ...person('Ravi Kumar', 'Plant Head', { link: 'https://www.linkedin.com/in/ravi-kumar/' }), snippet: 'Plant Head. Hosur Gears. Jan 2021 - Present. Hosur, Tamil Nadu, India' };
    const { people, searched, logs } = await search((query) =>
      query === q('Plant Head') ? [undated] : query === q('Plant Manager') ? [dated] : query === q('Inventory Manager') ? [person('Vikram P', 'Inventory Manager')] : [],
    );
    expect(people.map((p) => p.name)).toEqual(['Ravi Kumar', 'Vikram P']);
    expect(people[0]).toMatchObject({ location: 'Hosur, Tamil Nadu, India' });
    expect(people[0].evidence).toContain('current');
    // Two people is fewer than four: the duplicate never cut the search short.
    expect(searched.at(-1)).toBe(q('Logistics Manager', ''));
    expect(logs.filter((l) => l.startsWith('  accepted: Ravi Kumar')).length).toBeLessThanOrEqual(2);
  });

  it('a search result is only a candidate: HR, a former employee, someone abroad and a conflicting profile are rejected, with the reason', async () => {
    const hr = person('Asha R', 'HR Manager');
    const left = person('Gopal N', 'Plant Head', { firm: 'Other Forge' });
    const abroad = person('Morgan G', 'Plant Head', { place: 'Greater Sioux Falls Area', link: 'https://www.linkedin.com/in/morgan-g' });
    const twoJobs = { ...person('Meena S', 'Plant Head', { firm: 'Lean Partners' }), title: 'Meena S - Plant Head', subtitle: 'Hosur, Tamil Nadu, India · Consultant · Lean Partners', snippet: 'Plant Head. Hosur Gears Pvt Ltd. Jan 2023 - Present. Hosur, Tamil Nadu, India' };
    const { people, searched, logs } = await search((query) => (query === q('Plant Head') ? [hr, left, abroad, twoJobs] : []));
    const line = (who: string) => logs.find((l) => l.includes(`: ${who} (`)) ?? '';
    expect(line('Asha R')).toBe('  rejected: Asha R (HR Manager): HR Manager: not a role on the ICP lists');
    expect(line('Gopal N')).toMatch(/^ {2}rejected: Gopal N \(Plant Head\): .*Other Forge/);
    expect(line('Morgan G')).toMatch(/^ {2}rejected: Morgan G .*based outside India/);
    expect(line('Meena S')).toMatch(/^ {2}rejected: Meena S .*two current jobs/);
    // None of them is acceptable: the search went on, settled the unclear profile by name, and ended
    // with the leadership search.
    expect(searched).toContain(q('Plant Manager'));
    expect(searched.some((s) => s.includes('"Meena S"'))).toBe(true);
    expect(searched.at(-1)).toMatch(/\(owner OR founder/);
    expect(people.map((p) => p.name)).not.toContain('Gopal N');
    expect(people.map((p) => p.name)).not.toContain('Morgan G');
    expect(logs.at(-1)).toBe('contact search done: no acceptable contact found');
  });

  it('nobody acceptable: every designation is searched (with and without the town), then the leadership search; the lead waits for a manual contact', async () => {
    const { people, searched, logs } = await search(() => []);
    const plan = contactSearchPlan(company, 'Hosur', mfg);
    expect(searched).toEqual([...plan.flatMap((s) => s.queries), expect.stringMatching(/^site:linkedin\.com\/in "Hosur Gears" \(owner OR founder/)]);
    expect(people).toEqual([]);
    expect(logs).toContain(`P3 20/20 "Logistics Manager": ${q('Logistics Manager', '')} → no LinkedIn profiles`);
    expect(logs.at(-1)).toBe('contact search done: no acceptable contact found');
    // The status stays the existing one: no contact waits for the team; a found contact waits for approval.
    const { scoreLead } = await import('@/lib/pipeline/scoring');
    const { EMPTY_CONTACT } = await import('@/lib/pipeline/contacts');
    expect(scoreLead(8, { ...EMPTY_CONTACT }, 'no email found').status).toBe('Needs Manual Contact');
    expect(scoreLead(8, { ...EMPTY_CONTACT, name: 'Ravi Kumar', linkedin: 'https://in.linkedin.com/in/ravi-kumar' }, 'no email found').status).toBe('Awaiting Approval');
  });

  it("tries the company's verified LinkedIn name when its own name finds nobody there", async () => {
    const micron = 'Micron Semiconductor Technology India';
    const page = { title: 'Micron Technology | LinkedIn', link: 'https://www.linkedin.com/company/micron-technology', snippet: 'Website: http://www.micron.com. External link for Micron Technology' };
    const sumanth = { title: 'Sumanth G - Plant Head', subtitle: 'Ahmedabad, Gujarat, India · Plant Head · Micron Technology', link: 'https://in.linkedin.com/in/sumanth-g', snippet: '' };
    const svc = services(seen, (query) => (query.startsWith('site:linkedin.com/company') ? [page] : query.includes('"Micron Technology" "Plant Head"') ? [sumanth] : []));
    await learnFirm(svc, micron, 'micron.com');
    await knowPlaces(svc, ['Sanand']);
    seen.searches.length = 0;
    const { people } = await searchLinkedIn(svc, '', micron, 'Sanand', mfg);
    expect(seen.searches.slice(0, 3)).toEqual([
      'site:linkedin.com/in "Micron Semiconductor Technology" "Plant Head" Sanand',
      'site:linkedin.com/in "Micron Technology" "Plant Head" Sanand',
      'site:linkedin.com/in "Micron Semiconductor Technology" "Plant Manager" Sanand',
    ]);
    expect(people.map((p) => p.name)).toEqual(['Sumanth G']);
  });

  it('skips one failed search, and stops when two fail in a row (the search is down) without calling it "nobody found"', async () => {
    let n = 0;
    const flaky = { ...services(seen, (query) => (query === q('Plant Manager') ? [person('Bina B', 'Plant Manager')] : [])), keys: { serper: KEY } as never };
    const fetchOk = flaky.fetch;
    flaky.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => (String(u).endsWith('/search') && n++ === 0 ? new Response('busy', { status: 503 }) : fetchOk(u, init))) as typeof fetch;
    const logs: string[] = [];
    const { people } = await searchLinkedIn(flaky, '', company, 'Hosur', mfg, (m) => void logs.push(m));
    expect(logs[1]).toMatch(/"Plant Head": .* → search failed: 503/);
    expect(people.map((p) => p.name)).toEqual(['Bina B']);
    // Down from the start: two failures, then nothing more is searched, and the error is reported.
    seen.searches.length = 0;
    const down = { ...services(seen), fetch: (async () => new Response('no credits', { status: 403 })) as unknown as typeof fetch };
    const result = await searchLinkedIn(down, '', company, 'Hosur', mfg);
    expect(result.people).toEqual([]);
    expect(result.error).toContain('403');
  });
});
