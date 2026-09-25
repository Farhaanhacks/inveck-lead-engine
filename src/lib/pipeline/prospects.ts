import type { Client, Icp } from '../db/schema';
import { askJson } from './ai';
import { PROSPECT_EXTRACT_PROMPT, PROSPECT_QUERIES_PROMPT } from './prompts';
import type { SerperResult, Services } from './services';
import { googleSearch, mapLimit } from './services';
import { asList, asText, domainOf, errorMessage, normCompany } from './text';
import { domainScore, isBlockedDomain } from './website';

export type Prospect = { company: string; website: string; city: string; segment: string; source: string };

const querySchema = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { query: { type: 'string' }, segment: { type: 'string' }, lookalike_of: { type: 'string' } },
        required: ['query', 'segment', 'lookalike_of'],
        additionalProperties: false,
      },
    },
  },
  required: ['queries'],
  additionalProperties: false,
};

const companySchema = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          website: { type: 'string' },
          city: { type: 'string' },
          segment: { type: 'string' },
          lookalike_of: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['company', 'website', 'city', 'segment', 'lookalike_of', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['companies'],
  additionalProperties: false,
};


/**
 * Finds new companies like the current clients and matching the ICPs: the AI plans
 * Google searches, then picks real companies out of the results. Anything already a
 * lead or a client is skipped.
 */
export async function findProspects(
  svc: Services,
  icps: Icp[],
  clients: Client[],
  known: { company: string; website: string }[],
  log: (msg: string, level?: 'info' | 'warn' | 'error') => Promise<void>,
): Promise<Prospect[]> {
  const planText = [
    '## ICPs',
    ...icps.map((i) =>
      [`### ${i.segment}`, `Description: ${i.description}`, `Industries: ${i.industries}`, `Company size: ${i.companySize}`, `Geography: ${i.geography}`].join('\n'),
    ),
    '',
    '## Current clients',
    clients.length
      ? clients.map((c) => `- ${c.company} (${c.website || 'no website'}): ${c.industry}. ${c.whyBought}`).join('\n')
      : '(none listed)',
  ].join('\n');

  const plan = await askJson(svc, PROSPECT_QUERIES_PROMPT, planText, querySchema);
  if (plan.error !== undefined) throw new Error('Planning searches failed: ' + plan.error);
  const queries = asList(plan.data.queries)
    .map((q) =>
      typeof q === 'string'
        ? { query: q, segment: '', lookalike_of: '' }
        : {
            query: asText((q as Record<string, unknown>)?.query),
            segment: asText((q as Record<string, unknown>)?.segment),
            lookalike_of: asText((q as Record<string, unknown>)?.lookalike_of),
          },
    )
    .filter((q) => q.query)
    .slice(0, 8);
  if (!queries.length) throw new Error('The AI returned no search queries');
  await log(`Searching Google: ${queries.map((q) => `"${q.query}"`).join(', ')}`);

  const searched = await mapLimit(queries, 4, async (q) => {
    try {
      return { q, results: await googleSearch(svc, q.query) };
    } catch (e) {
      await log(`Search failed for "${q.query}": ${errorMessage(e)}`, 'warn');
      return { q, results: [] as SerperResult[] };
    }
  });
  const results = searched.flatMap(({ q, results }) =>
    results.slice(0, 10).map((r) => ({ query: q.query, segment: q.segment, lookalike_of: q.lookalike_of, title: r.title, link: r.link, snippet: r.snippet || '' })),
  );
  if (!results.length) throw new Error('Google returned no results. Check SERPER_API_KEY.');

  const knownList = [...known.map((k) => k.company), ...clients.map((c) => c.company)].filter(Boolean);
  const pickText = [
    `ICP segments: ${icps.map((i) => i.segment).join(', ')}`,
    '',
    '## Already on the list (skip these)',
    knownList.length ? knownList.join(', ') : '(none)',
    '',
    '## Search results',
    JSON.stringify(results, null, 2),
  ].join('\n');
  const picked = await askJson(svc, PROSPECT_EXTRACT_PROMPT, pickText, companySchema);
  if (picked.error !== undefined) throw new Error('Picking companies failed: ' + picked.error);

  const seenNames = new Set([...known.map((k) => normCompany(k.company)), ...clients.map((c) => normCompany(c.company))].filter(Boolean));
  const seenDomains = new Set([...known.map((k) => domainOf(k.website)), ...clients.map((c) => domainOf(c.website))].filter(Boolean));
  const segmentNames = icps.map((i) => i.segment);
  // Only trust a website that actually appeared in the results. The AI's guesses are often
  // wrong (bodalchemicals.com for bodal.com); research looks the real one up instead.
  const resultDomains = new Set(results.map((r) => domainOf(r.link)).filter(Boolean));

  const prospects: Prospect[] = [];
  for (const raw of asList(picked.data.companies)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const company = asText(c.company);
    let domain = domainOf(asText(c.website));
    // …and only when the domain is plausibly this company's (not "cumminscollege.org" for Cummins).
    if (isBlockedDomain(domain) || !resultDomains.has(domain) || !domainScore(company, domain)) domain = '';
    if (!company || seenNames.has(normCompany(company)) || (domain && seenDomains.has(domain))) continue;
    seenNames.add(normCompany(company));
    if (domain) seenDomains.add(domain);
    const lookalike = asText(c.lookalike_of);
    const why = asText(c.why);
    prospects.push({
      company,
      website: domain,
      city: asText(c.city),
      segment: segmentNames.find((s) => s.toLowerCase() === asText(c.segment).toLowerCase()) || segmentNames[0] || '',
      source: (lookalike ? `Lookalike of ${lookalike}` : 'Found by prospect search') + (why ? `: ${why}` : ''),
    });
    if (prospects.length >= svc.settings.prospectsPerRun) break;
  }
  return prospects;
}
