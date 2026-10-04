import { beforeEach, describe, expect, it } from 'vitest';
import { settingsSchema } from '@/lib/settings';
import type { EnrichmentCache, Services } from '@/lib/pipeline/services';
import { distanceKm, forgetPlaces, knowPlaces, placeKey, pointOf } from '@/lib/pipeline/places';
import { learnFirm, linkedinPageName, recallFirm } from '@/lib/pipeline/firm-identity';
import { firmAliasesOf, sameFirm, siteOf } from '@/lib/pipeline/employer';
import { atOtherSite, confirmedAtSite, linkedinQuery, personSite, searchLinkedIn } from '@/lib/pipeline/contacts';
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
    expect(linkedinQuery(company, 'Sanand', { ...DEFAULT_ICPS[0], id: 1 } as never)).toContain('"Micron Technology"');
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
    expect(tierOf('Director Operations Management', mfg)).toBe('P1');
    expect(contactPriority('MSTI Indirect Regional Supplier Manager', mfg)).toBe(20);
    for (const t of ['Associate - Manufacturing Operations', 'Test Engineering Manager (Process & Equipment)', 'Head of Talent Acquisition', 'Supply Demand Analyst', 'Senior Manager', 'Semiconductor Manufacturing Professional']) {
      expect(contactPriority(t, mfg)).toBe(99);
    }
    // The lists still come first: a plant head is ahead of anyone placed by function.
    expect(contactPriority('Plant Head', mfg)).toBeLessThan(contactPriority('Manufacturing Manager', mfg));
  });
});

describe('Mojj Engineering: the owner-director, and a search that failed', () => {
  it("ranks a bare Director or Owner as the company's top (last resort), never a functional director outside the lists", () => {
    const mfg = DEFAULT_ICPS[0];
    for (const t of ['Director', 'Owner', 'Founder & CEO', 'Executive Director']) expect(contactPriority(t, mfg)).toBe(50);
    for (const t of ['Director - Marketing', 'Director Projects', 'Technical Director', 'Board Member']) expect(contactPriority(t, mfg)).toBe(99);
    expect(contactPriority('Plant Head', mfg)).toBeLessThan(contactPriority('Director', mfg));
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
    expect(personSite({ title: 'Plant Head - Chennai', responsibility: 'Chennai', location: 'Coimbatore' }, 'Coimbatore')).toBe('elsewhere');
  });

  it('with only a Chennai profile location, she is kept (company-wide role) but not confirmed at the Coimbatore site', async () => {
    const svc = services(seen, () => [nandini]);
    await knowPlaces(svc, ['Coimbatore']);
    const found = (await searchLinkedIn(svc, 'q', company)).people[0];
    expect(found).toMatchObject({ name: 'Nandini Easwaran', jobLocation: '', responsibility: '' });
    expect(personSite(found, 'Coimbatore')).toBe('elsewhere');
    expect(atOtherSite(found, 'Coimbatore')).toBe(false);
    expect(confirmedAtSite(found, 'Coimbatore')).toBe(false);
    // A plant manager based in Chennai is still at another site.
    expect(atOtherSite({ ...found, title: 'Plant Manager' }, 'Coimbatore')).toBe(true);
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
  });
});
