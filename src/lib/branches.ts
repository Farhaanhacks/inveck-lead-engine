import { domainOf, normCompany } from './pipeline/text';

const place = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** "Pune" and "Pune, Maharashtra" are the same place; "Pune" and "Chakan" aren't. */
export function sameCity(a: string, b: string): boolean {
  const [x, y] = [place(a.split(',')[0] ?? ''), place(b.split(',')[0] ?? '')];
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

type Known = { company: string; website: string; city: string };

/**
 * What's already in the system, by branch. A company that is a client is always known. A company
 * that is a lead is known at its city: the same company at another city (another plant, warehouse
 * or branch) is a separate lead with its own contact. Without a city on either side it counts as
 * the same, so nothing is added twice by accident.
 */
export class KnownBranches {
  private leads: Known[] = [];
  private clientNames = new Set<string>();
  private clientDomains = new Set<string>();

  constructor(leadRows: Known[], clientRows: { company: string; website: string }[]) {
    this.leads = [...leadRows];
    for (const c of clientRows) {
      if (normCompany(c.company)) this.clientNames.add(normCompany(c.company));
      if (domainOf(c.website)) this.clientDomains.add(domainOf(c.website));
    }
  }

  /** 'client', 'lead' (same branch already a lead), or '' when it can be added. */
  has(company: string, website: string, city: string): 'client' | 'lead' | '' {
    const name = normCompany(company);
    const domain = domainOf(website);
    if ((name && this.clientNames.has(name)) || (domain && this.clientDomains.has(domain))) return 'client';
    const same = this.leads.filter((l) => (name && normCompany(l.company) === name) || (domain && domainOf(l.website) === domain));
    return same.some((l) => !city.trim() || !l.city.trim() || sameCity(l.city, city)) ? 'lead' : '';
  }

  add(company: string, website: string, city: string) {
    this.leads.push({ company, website, city });
  }
}
