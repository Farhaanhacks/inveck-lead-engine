import { settingsSchema } from '@/lib/settings';
import type { Services } from '@/lib/pipeline/services';
import { fakeFetch, type FakeLog } from './fake-apis';

/**
 * A small made-up Google for the people-first search: the "forging" searches find four people (a plant
 * head and a supply chain manager at a right-sized forging company, a plant head at one too small, and
 * one at a company INVECK already has), the "warehousing" ones a warehouse head at a 3PL. Company pages
 * and everything else (research, AI) answer as in the other tests.
 */

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const person = (name: string, role: string, company: string, place = 'Pune, Maharashtra, India') => ({
  title: `${name} - ${role} - ${company} | LinkedIn`,
  subtitle: `${place} · ${role} · ${company}`,
  link: `https://in.linkedin.com/in/${name.toLowerCase().replace(/ /g, '-')}`,
  snippet: '',
});
const page = (slug: string, name: string, facts: string) => ({ title: `${name} | LinkedIn`, link: `https://in.linkedin.com/company/${slug}`, snippet: `${name} | 2,345 followers on LinkedIn. ${facts}` });

const PROFILES: Record<string, ReturnType<typeof person>[]> = {
  forging: [
    person('Rahul Patil', 'Plant Head', 'Forgeline Components'),
    person('Sunita Rao', 'Supply Chain Manager', 'Forgeline Components'),
    person('Imran Shaikh', 'Plant Head', 'Tiny Tools'),
    person('Vikas Jain', 'Plant Head', 'Known Gears'),
  ],
  warehousing: [person('Deepak Nair', 'Warehouse Head', 'Swift Warehousing Solutions', 'Bhiwandi, Maharashtra, India')],
};
const PAGES: Record<string, ReturnType<typeof page>> = {
  'Forgeline Components': page('forgeline-components', 'Forgeline Components', 'Website: http://www.forgeline.in. Industry: Motor Vehicle Parts Manufacturing. Company size: 501-1,000 employees. Headquarters: Pune, Maharashtra'),
  'Tiny Tools': page('tiny-tools', 'Tiny Tools', 'Website: http://www.tinytools.in. Industry: Machinery Manufacturing. Company size: 11-50 employees. Headquarters: Pune, Maharashtra'),
  'Swift Warehousing Solutions': page('swift-warehousing', 'Swift Warehousing Solutions', 'Website: http://www.swiftwh.in. Industry: Transportation, Logistics, Supply Chain and Storage. Company size: 201-500 employees. Headquarters: Mumbai, Maharashtra'),
};

/** Serper for the people-first searches and company pages; everything else (research, AI) as in the other tests. */
function world(log: FakeLog, searched: string[]): typeof fetch {
  const rest = fakeFetch(log);
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === 'google.serper.dev' && url.pathname === '/search') {
      const { q } = JSON.parse(String(init.body));
      if (q.startsWith('site:linkedin.com/in ') && /"(forging|warehousing)"/.test(q)) {
        searched.push(q);
        return json({ organic: PROFILES[/"forging"/.test(q) ? 'forging' : 'warehousing'] });
      }
      const name = Object.keys(PAGES).find((n) => q.includes(n) || q.includes(PAGES[n].snippet.match(/www\.([a-z]+\.[a-z]+)/)![1]));
      if (q.startsWith('site:linkedin.com/company') && name) return json({ organic: [PAGES[name]] });
    }
    return rest(input, init);
  }) as typeof fetch;
}

export function morningServices(log: FakeLog, searched: string[] = [], extra: Partial<Services> & { budget?: number } = {}): Services {
  const { budget, ...rest } = extra;
  return {
    fetch: world(log, searched),
    keys: { deepseek: 'ds-test', anthropic: 'ant-test', serper: 'serper-test', jina: '' },
    settings: settingsSchema.parse({ manufacturingPerAssociate: 1, logisticsPerAssociate: 1, ...(budget ? { dailySearchBudget: budget } : {}) }),
    ...rest,
  };
}

