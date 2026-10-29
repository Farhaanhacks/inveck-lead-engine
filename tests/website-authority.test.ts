import { describe, expect, it } from 'vitest';
import { resolveWebsite } from '@/lib/pipeline/process-lead';
import { knowFirmPage } from '@/lib/pipeline/firm-identity';
import { pickOfficialDomain, siteNamesCompany } from '@/lib/pipeline/website';
import type { Services } from '@/lib/pipeline/services';
import { settingsSchema } from '@/lib/settings';

/**
 * The company's website (29 Oct 2026): the one its own LinkedIn page lists is kept, and one found by a search for the
 * name is used only when its pages name the company. Nordic Logistics and Warehousing (nordiccold.com, a site that
 * blocks automated readers) had been given nordicglobal.net, Nordic Shipping's.
 */

const page = (text: string) => `<html><head><title>${text.split('.')[0]}</title></head><body><p>${text}</p><p>${'Warehousing, distribution and logistics services for our clients. '.repeat(6)}</p></body></html>`;
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

function services(searched: string[]): Services {
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('https://r.jina.ai/')) return new Response('', { status: 500 });
    if (url.includes('google.serper.dev')) {
      const q = String(JSON.parse(String(init.body)).q);
      searched.push(q);
      if (q.startsWith('site:')) return json({ organic: [] });
      if (/^Nordic Logistics/.test(q)) return json({ organic: [{ title: 'Warehousing & Distribution - Nordic Shipping', link: 'https://www.nordicglobal.net/warehouse', snippet: 'Warehousing.' }] });
      if (/^Forgeline/.test(q)) return json({ organic: [{ title: 'Forgeline Components', link: 'https://www.forgeline.in/', snippet: 'Forgings' }] });
      return json({ organic: [] });
    }
    if (url.includes('nordiccold.com')) return new Response('Forbidden', { status: 403 });
    if (url.includes('nordicglobal.net')) return html(page('Nordic Shipping LLC. Owned warehouse and a fleet of vehicles in the Jebel Ali Free Zone, with offices in India and Canada.'));
    if (url.includes('forgeline.in')) return html(page('Forgeline Components Pvt. Ltd. makes closed-die forgings for the automotive industry in Pune.'));
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  }) as typeof fetch;
  return { fetch: fetchFn, keys: { deepseek: '', anthropic: '', serper: 'serper-test', jina: '' }, settings: settingsSchema.parse({}) };
}

describe("the company's website", () => {
  it('a site found by the name must name the company: a shared word is not enough', () => {
    // The name search alone would take Nordic Shipping's site for Nordic Logistics and Warehousing.
    expect(pickOfficialDomain('Nordic Logistics and Warehousing, LLC', [{ link: 'https://www.nordicglobal.net/warehouse' }])).toBe('nordicglobal.net');
    expect(siteNamesCompany('Nordic Shipping LLC. Owned warehouse and a fleet of vehicles.', 'Nordic Logistics and Warehousing, LLC')).toBe(false);
    expect(siteNamesCompany('Welcome to Nordic Logistics & Warehousing, one of the largest cold storage companies.', 'Nordic Logistics and Warehousing, LLC')).toBe(true);
    expect(siteNamesCompany('K.R. Auto Components makes sheet metal parts.', 'KR Auto Components Private Limited')).toBe(true);
    expect(siteNamesCompany('Bharat Forge Ltd is a global forging company.', 'Bharat Forge Limited')).toBe(true);
  });

  it("keeps the website the company's own LinkedIn page lists, even when it can't be read", async () => {
    const searched: string[] = [];
    const svc = services(searched);
    const company = 'Nordic Logistics and Warehousing, LLC';
    await knowFirmPage(svc, company, 'nordiccold.com', { name: company, url: 'https://www.linkedin.com/company/nordic-logistics-and-warehousing-llc', size: '501-1,000 employees', followers: 1200, text: `${company}. Nordic is one of the nation's largest cold storage warehouse companies. Website http://www.nordiccold.com ... 501-1,000 employees.` });
    const r = await resolveWebsite(svc, { company, website: 'nordiccold.com', city: 'Atlanta' });
    expect(r.website).toContain('nordiccold.com');
    expect(r.found).toBeUndefined();
    // No search for another site by the name.
    expect(searched.some((q) => /official website/.test(q))).toBe(false);
  });

  it('with no website known, one found by the name is used only when its pages name the company', async () => {
    const searched: string[] = [];
    const none = await resolveWebsite(services(searched), { company: 'Nordic Logistics and Warehousing, LLC', website: '', city: '' });
    expect(searched.some((q) => /official website/.test(q))).toBe(true);
    expect(none).toMatchObject({ website: '' });
    expect(none.found).toBeUndefined();
    const forgeline = await resolveWebsite(services([]), { company: 'Forgeline Components Private Limited', website: '', city: 'Pune' });
    expect(forgeline.found).toBe('forgeline.in');
    expect(forgeline.website).toContain('forgeline.in');
  });
});
