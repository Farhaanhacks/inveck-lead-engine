import { describe, expect, it } from 'vitest';
import { findProspects } from '@/lib/pipeline/prospects';
import { settingsSchema } from '@/lib/settings';
import type { Services } from '@/lib/pipeline/services';
import { DEFAULT_ICPS, LOGISTICS } from '@/lib/db/seed';

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const reply = (content: unknown) => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });

/**
 * An AI that leans on the clients (all manufacturers): every search it proposes is a manufacturing
 * lookalike unless told otherwise, and it picks every company it sees.
 */
function services(seen: { plans: string[] }): Services {
  let n = 0;
  const fetchFn = (async (u: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(u));
    const body = JSON.parse(String(init.body ?? '{}'));
    if (url.host === 'google.serper.dev') {
      const q = String(body.q);
      const seg = /3pl|warehous/i.test(q) ? 'L' : /chartered/i.test(q) ? 'C' : 'M';
      return json({ organic: Array.from({ length: 6 }, (_, i) => ({ title: `${seg} Co ${q.length}-${i}`, link: `https://${seg.toLowerCase()}${q.length}x${i}.in/`, snippet: '' })) });
    }
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    if (system.startsWith('You plan Google searches')) {
      seen.plans.push(user);
      const asked = /Write at least 2 queries for each of these segments: (.+?)\. Lookalikes/.exec(user)?.[1] ?? '';
      const queries = Array.from({ length: 6 }, (_, i) => ({ query: `forging manufacturer lookalike ${n++} ${i}`, segment: 'Manufacturing', lookalike_of: 'Wheels India' }));
      if (asked.includes(LOGISTICS)) queries.push({ query: `3PL warehousing company ${n++}`, segment: LOGISTICS, lookalike_of: '' }, { query: `warehousing 3PL Chennai ${n++}`, segment: LOGISTICS, lookalike_of: '' });
      if (asked.includes('CA Firms')) queries.push({ query: `chartered accountants stock audit ${n++}`, segment: 'CA Firms', lookalike_of: '' }, { query: `chartered accountant firm partners ${n++}`, segment: 'CA Firms', lookalike_of: '' });
      return reply({ queries });
    }
    if (system.startsWith('You pick new prospect companies')) {
      const results = JSON.parse(user.slice(user.indexOf('## Search results') + '## Search results'.length));
      return reply({ companies: results.map((r: { title: string; segment: string; link: string }) => ({ company: r.title, website: '', city: '', segment: r.segment, lookalike_of: '', why: '' })) });
    }
    throw new Error('unexpected ' + system.slice(0, 40));
  }) as typeof fetch;
  return { fetch: fetchFn, keys: { deepseek: 'k', anthropic: '', serper: 'k', jina: '' } as never, settings: settingsSchema.parse({ prospectsPerRun: 12 }) };
}

describe('prospect search covers every active ICP', () => {
  it('asks for searches in every segment and shares the run among them, even when the clients are all one segment', async () => {
    const seen = { plans: [] as string[] };
    const icps = DEFAULT_ICPS.map((i, id) => ({ ...i, id: id + 1, active: true })) as never;
    const clients = [{ company: 'Wheels India', website: 'wheelsindia.com', industry: 'Auto components', whyBought: 'Plants' }] as never;
    const found = await findProspects(services(seen), icps, clients, [], async () => {});
    const count = (seg: string) => found.filter((p) => p.segment === seg).length;
    expect(found).toHaveLength(12);
    expect([count('Manufacturing'), count(LOGISTICS), count('CA Firms')]).toEqual([4, 4, 4]);
    expect(seen.plans[0]).toContain(`Write at least 2 queries for each of these segments: Manufacturing, ${LOGISTICS}, CA Firms`);
  });
});
