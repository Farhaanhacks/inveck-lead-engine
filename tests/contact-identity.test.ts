import { beforeEach, describe, expect, it } from 'vitest';
import { settingsSchema } from '@/lib/settings';
import type { EnrichmentCache, Services } from '@/lib/pipeline/services';
import { distanceKm, forgetPlaces, knowPlaces, placeKey, pointOf } from '@/lib/pipeline/places';
import { learnFirm, linkedinPageName, recallFirm } from '@/lib/pipeline/firm-identity';
import { firmAliasesOf, sameFirm, siteOf } from '@/lib/pipeline/employer';
import { linkedinQuery, searchLinkedIn } from '@/lib/pipeline/contacts';
import { contactPriority, tierOf } from '@/lib/tiers';
import { DEFAULT_ICPS } from '@/lib/db/seed';

/** Where Google Maps puts these places (a town comes back with no business type). */
const MAP: Record<string, { latitude: number; longitude: number; type?: string }> = {
  sanand: { latitude: 22.992, longitude: 72.377 },
  ahmedabad: { latitude: 23.02, longitude: 72.58 },
  hyderabad: { latitude: 17.41, longitude: 78.41 },
  dolvi: { latitude: 18.702, longitude: 73.05 },
  panvel: { latitude: 18.99, longitude: 73.12 },
  raigad: { latitude: 18.236, longitude: 73.443, type: 'Tourist attraction' },
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
