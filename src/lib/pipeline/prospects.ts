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


/** Search rounds per run: when a round turns up too few companies not already on the list, plan new searches. */
const MAX_ROUNDS = 3;
/** Result pages read per search (ten results each). */
const PAGES = 2;

type Query = { query: string; segment: string; lookalike_of: string };
type Found = { query: string; segment: string; lookalike_of: string; title?: string; link?: string; snippet: string };

/**
 * Finds new companies like the current clients and matching the ICPs: the AI plans Google searches,
 * then picks real companies out of the results. Anything already a lead or a client is skipped, and
 * as the list grows the search goes further: two pages per search, and up to three rounds of new
 * searches until enough new companies are found. Throws when the searches themselves fail (so the
 * run shows it), not when they only turn up companies already on the list.
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

  const seenNames = new Set([...known.map((k) => normCompany(k.company)), ...clients.map((c) => normCompany(c.company))].filter(Boolean));
  const seenDomains = new Set([...known.map((k) => domainOf(k.website)), ...clients.map((c) => domainOf(c.website))].filter(Boolean));
  const knownList = [...known.map((k) => k.company), ...clients.map((c) => c.company)].filter(Boolean);
  const segmentNames = icps.map((i) => i.segment);
  const want = svc.settings.prospectsPerRun;
  const tried: string[] = [];
  const prospects: Prospect[] = [];
  let searchesOk = 0;
  let lastError = '';
  let searchError = '';

  for (let round = 0; round < MAX_ROUNDS && prospects.length < want; round++) {
    const text = tried.length
      ? `${planText}\n\n## Searches already run (write different ones: other cities, sub-industries, lookalikes, wording; these found mostly companies already on the list)\n${tried.map((q) => `- ${q}`).join('\n')}`
      : planText;
    const plan = await askJson(svc, PROSPECT_QUERIES_PROMPT, text, querySchema);
    if (plan.error !== undefined) {
      lastError = 'Planning searches failed: ' + plan.error;
      await log(lastError, 'warn');
      continue;
    }
    const queries: Query[] = asList(plan.data.queries)
      .map((q) =>
        typeof q === 'string'
          ? { query: q, segment: '', lookalike_of: '' }
          : {
              query: asText((q as Record<string, unknown>)?.query),
              segment: asText((q as Record<string, unknown>)?.segment),
              lookalike_of: asText((q as Record<string, unknown>)?.lookalike_of),
            },
      )
      .filter((q) => q.query && !tried.some((t) => t.toLowerCase() === q.query.toLowerCase()))
      .slice(0, 8);
    if (!queries.length) {
      lastError = 'The AI returned no new search queries';
      continue;
    }
    tried.push(...queries.map((q) => q.query));
    await log(`Searching Google${round ? ` (round ${round + 1})` : ''}: ${queries.map((q) => `"${q.query}"`).join(', ')}`);

    const jobs = queries.flatMap((q) => Array.from({ length: PAGES }, (_, i) => ({ q, page: i + 1 })));
    let okThisRound = 0;
    let failedThisRound = 0;
    const searched = await mapLimit(jobs, 4, async ({ q, page }) => {
      try {
        const results = await googleSearch(svc, q.query, page);
        searchesOk++;
        okThisRound++;
        return { q, results };
      } catch (e) {
        searchError = errorMessage(e);
        lastError = `Search failed for "${q.query}": ${searchError}`;
        if (++failedThisRound === 1) await log(lastError, 'warn');
        return { q, results: [] as SerperResult[] };
      }
    });
    // Results on companies already on the list are left out, so the AI only sees what's new.
    const seenLinks = new Set<string>();
    const results: Found[] = searched
      .flatMap(({ q, results }) => results.map((r) => ({ query: q.query, segment: q.segment, lookalike_of: q.lookalike_of, title: r.title, link: r.link, snippet: r.snippet || '' })))
      .filter((r) => {
        const link = (r.link || '').toLowerCase();
        if (!link || seenLinks.has(link)) return false;
        seenLinks.add(link);
        const d = domainOf(r.link || '');
        return !(d && seenDomains.has(d));
      });
    // Every search failed (no credits, a wrong key): more rounds would fail the same way.
    if (!okThisRound) break;
    if (!results.length) {
      await log('Every result was a company already on the list; searching again with new queries', 'info');
      continue;
    }

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
    if (picked.error !== undefined) {
      lastError = 'Picking companies failed: ' + picked.error;
      await log(lastError, 'warn');
      continue;
    }

    // Only trust a website that actually appeared in the results. The AI's guesses are often
    // wrong (bodalchemicals.com for bodal.com); research looks the real one up instead.
    const resultDomains = new Set(results.map((r) => domainOf(r.link || '')).filter(Boolean));
    const before = prospects.length;
    for (const raw of asList(picked.data.companies)) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const company = asText(c.company);
      let domain = domainOf(asText(c.website));
      // …and only when the domain is plausibly this company's (not "cumminscollege.org" for Cummins).
      if (isBlockedDomain(domain) || !resultDomains.has(domain) || !domainScore(company, domain)) domain = '';
      if (!company || seenNames.has(normCompany(company)) || (domain && seenDomains.has(domain))) continue;
      seenNames.add(normCompany(company));
      knownList.push(company);
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
      if (prospects.length >= want) break;
    }
    if (prospects.length < want && round < MAX_ROUNDS - 1) await log(`Round ${round + 1}: ${prospects.length - before} new companies; searching further`, 'info');
  }

  // Nothing came back from Google at all, or every step failed: that's a failure, not "no new prospects".
  if (!searchesOk) throw new Error(searchError ? `Google search (Serper) failed on every query: ${searchError}` : lastError || 'Google returned no results. Check SERPER_API_KEY.');
  if (!prospects.length && lastError) throw new Error(lastError);
  return prospects;
}
