import { vagueLocation } from './pipeline/employer';
import { domainOf } from './pipeline/text';

/** Old and new names of the same city. */
const ALIASES: Record<string, string> = {
  gurgaon: 'gurugram', bangalore: 'bengaluru', bombay: 'mumbai', madras: 'chennai', calcutta: 'kolkata', baroda: 'vadodara',
  mysore: 'mysuru', poona: 'pune', trivandrum: 'thiruvananthapuram', cochin: 'kochi', pondicherry: 'puducherry',
  vizag: 'visakhapatnam', mangalore: 'mangaluru', belgaum: 'belagavi', hubli: 'hubballi', allahabad: 'prayagraj',
};
const place = (s: string) => {
  const p = s.toLowerCase().replace(/[^a-z]/g, '');
  return ALIASES[p] ?? p;
};

/**
 * The same place: "Pune" and "Pune, Maharashtra", and old and new names ("Gurgaon" and "Gurugram",
 * "Bangalore" and "Bengaluru"). Another town in the same metro ("Pune" and "Chakan") is another plant.
 */
export function sameCity(a: string, b: string): boolean {
  const [x, y] = [place(a.split(',')[0] ?? ''), place(b.split(',')[0] ?? '')];
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

const LEGAL = /\b(pvt|private|ltd|limited|llp|inc|india|the|and|of|co|company|companies|group|corporation|corp)\b/g;
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(LEGAL, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    // "Swastik Pipes" is "Swastik Pipe".
    .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join('');

/**
 * The names a company goes by, for matching: without what's in brackets ("Deepak Fertilisers …
 * Limited (DFPCL)"), and its former name ("OPG Mobility (Formerly known as Okaya EV)" is also Okaya EV).
 */
export function companyKeys(company: string): string[] {
  const keys = new Set<string>();
  const base = company.replace(/\([^)]*\)/g, ' ');
  keys.add(key(base));
  for (const m of company.matchAll(/\(\s*(?:formerly|earlier|previously)(?:\s+known)?(?:\s+as)?\s*:?\s*([^)]+)\)/gi)) keys.add(key(m[1]));
  return [...keys].filter((k) => k.length > 1);
}

type Known = { company: string; website: string; city: string };

/**
 * What's already in the system, by branch. A company that is a client is always known. A company
 * that is a lead is known at its city: the same company at another city (another plant, warehouse
 * or branch) is a separate lead with its own contact. Without a city on either side it counts as
 * the same, so nothing is added twice by accident.
 */
export class KnownBranches {
  private leads: (Known & { keys: string[] })[] = [];
  private clientNames = new Set<string>();
  private clientDomains = new Set<string>();

  constructor(leadRows: Known[], clientRows: { company: string; website: string }[]) {
    for (const l of leadRows) this.add(l.company, l.website, l.city);
    for (const c of clientRows) {
      for (const k of companyKeys(c.company)) this.clientNames.add(k);
      if (domainOf(c.website)) this.clientDomains.add(domainOf(c.website));
    }
  }

  /** 'client', 'lead' (same branch already a lead), or '' when it can be added. */
  has(company: string, website: string, city: string): 'client' | 'lead' | '' {
    const names = companyKeys(company);
    const domain = domainOf(website);
    if (names.some((n) => this.clientNames.has(n)) || (domain && this.clientDomains.has(domain))) return 'client';
    const same = this.leads.filter((l) => l.keys.some((k) => names.includes(k)) || (domain && domainOf(l.website) === domain));
    // A list entry with no city, or only a state or the country ("Gujarat", "India"), covers every site.
    return same.some((l) => !city.trim() || vagueLocation(l.city) || sameCity(l.city, city)) ? 'lead' : '';
  }

  add(company: string, website: string, city: string) {
    this.leads.push({ company, website, city, keys: companyKeys(company) });
  }
}
