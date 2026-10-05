import { KnownBranches } from '../branches';
import type { Client, Icp } from '../db/schema';
import { askJson } from './ai';
import { PROSPECT_EXTRACT_PROMPT, PROSPECT_QUERIES_PROMPT } from './prompts';
import type { SerperResult, Services } from './services';
import { googleSearch, mapLimit } from './services';
import { asList, asText, domainOf, errorMessage, normCompany } from './text';
import { domainScore, isBlockedDomain } from './website';
import { normQuery, tooSimilar } from './query-history';
import { canonicalSegment } from '../icp-match';

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
/** Planning attempts per run: a plan whose queries all repeat earlier searches is asked for again. */
const MAX_PLANS = 5;
/** Result pages read per search (ten results each). */
const PAGES = 2;
/** Queries per round. */
const PER_ROUND = 8;

type Query = { query: string; segment: string; lookalike_of: string };
type Found = { query: string; segment: string; lookalike_of: string; title?: string; link?: string; snippet: string };

/** An earlier search, as the history gives it: what was searched and how many results were new. */
export type PastSearch = { query: string; fresh: number; added: number };

/**
 * What earlier runs searched and saw, kept in the database (see runs.ts), and where this run records
 * its own. Without it (tests, one-off use) only the current lead list is checked.
 */
export type ProspectHistory = {
  /** Recent searches, newest first. */
  searches: PastSearch[];
  /** Companies earlier searches already picked (added or not), by branch: the same company elsewhere is new. */
  seenBranches: { company: string; website: string; city: string }[];
  recordSearch(s: { query: string; segment: string; status: 'ok' | 'failed'; resultsCount: number; freshCount: number; error?: string }): Promise<number | null>;
  recordResults(searchId: number | null, rows: { url: string; domain: string; title: string; company?: string; city?: string; outcome: 'known' | 'result' | 'added' | 'duplicate' }[]): Promise<void>;
  recordAdded(searchId: number | null, count: number): Promise<void>;
};

const NO_HISTORY: ProspectHistory = {
  searches: [],
  seenBranches: [],
  recordSearch: async () => null,
  recordResults: async () => {},
  recordAdded: async () => {},
};

/** The company a result is about, from its title ("Bharat Forge | Forging Solutions" → Bharat Forge). */
const titleCompany = (title = '') => title.split(/\s+[|–—-]\s+|\s*\|\s*/)[0]?.trim() ?? '';

/**
 * Finds new companies like the current clients and matching the ICPs: the AI plans Google searches,
 * then picks real companies out of the results.
 *
 * It searches somewhere new each time: the searches of earlier runs (kept in the database) go to the
 * planner as ones not to repeat, and any query that is the same as or a trivial variation of an
 * earlier one is dropped in code (see query-history), not left to the AI. Companies already known
 * (leads in any state, clients, and companies earlier searches turned up) are removed from the results
 * before the AI sees them, so no picking or research is spent rediscovering them. Two pages per search,
 * and up to three rounds of new searches until enough new companies are found.
 *
 * Throws when the searches themselves fail (so the run shows it), not when they only turn up
 * companies already known.
 */
export async function findProspects(
  svc: Services,
  icps: Icp[],
  clients: Client[],
  /** Leads and INVECK's own lead list, by branch: the same company at another location is a new lead. */
  known: { company: string; website: string; city?: string }[],
  log: (msg: string, level?: 'info' | 'warn' | 'error') => Promise<void>,
  history: ProspectHistory = NO_HISTORY,
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

  // Clients are known everywhere. Leads (and INVECK's own lead list) are known at their location: the
  // same company's plant elsewhere is a new lead, so results about it aren't hidden.
  const seenNames = new Set(clients.map((c) => normCompany(c.company)).filter(Boolean));
  const seenDomains = new Set(clients.map((c) => domainOf(c.website)).filter(Boolean));
  const branches = new KnownBranches([...known.map((k) => ({ company: k.company, website: k.website, city: k.city ?? '' })), ...history.seenBranches], clients);
  const knownList = [
    ...[...known, ...history.seenBranches].filter((k) => k.company).map((k) => `${k.company} (${k.city?.trim() || 'any location'})`),
    ...clients.map((c) => `${c.company} (client, any location)`),
  ].filter(Boolean);
  const segmentNames = icps.map((i) => i.segment);
  const want = svc.settings.prospectsPerRun;
  // Every active ICP gets its share of the run, in code, not only by asking the AI: most clients are
  // in one segment, so client lookalikes alone would make every new lead that segment.
  const share = Math.ceil(want / Math.max(1, segmentNames.length));
  const bySegment = (seg: string) => prospects.filter((p) => p.segment === seg).length;
  const shortOf = () => segmentNames.filter((seg) => bySegment(seg) < share);
  /** Companies over their segment's share, used only if the other segments can't fill the run. */
  const heldBack: (Prospect & { record: { searchId: number | null; row: Parameters<ProspectHistory['recordResults']>[1][number] } })[] = [];
  // Everything searched before (recent runs) and in this run: no query that repeats any of them is run.
  const earlier = history.searches.map((s) => s.query);
  const tried: string[] = [];
  const prospects: Prospect[] = [];
  let searchesOk = 0;
  let lastError = '';
  let searchError = '';
  let rounds = 0;

  for (let plans = 0; plans < MAX_PLANS && rounds < MAX_ROUNDS && prospects.length < want; plans++) {
    const past = [
      ...tried.map((q) => `- ${q} (this run)`),
      ...history.searches.slice(0, 150).map((s) => `- ${s.query}${s.added ? '' : s.fresh ? ' (found little new)' : ' (exhausted: found nothing new)'}`),
    ];
    const needed = shortOf();
    const balance = segmentNames.length > 1
      ? `\n\n## Segments to search this time\nWrite at least 2 queries for each of these segments: ${(needed.length ? needed : segmentNames).join(', ')}. Lookalikes of a client belong to the client's own segment; for a segment with no similar client, search for companies matching that ICP directly. A company's segment is what the company itself does, never the query it came from: a manufacturer (pipes, forgings, tea, machinery) is never 3PL & Logistics, even when found by a logistics search; leave out a company that fits no segment rather than labelling it one.`
      : '';
    const text = (past.length
      ? `${planText}\n\n## Searches already run (do not repeat them or reword them; search elsewhere)\n${past.join('\n')}`
      : planText) + balance;
    const plan = await askJson(svc, PROSPECT_QUERIES_PROMPT, text, querySchema);
    if (plan.error !== undefined) {
      lastError = 'Planning searches failed: ' + plan.error;
      await log(lastError, 'warn');
      continue;
    }
    const proposed: Query[] = asList(plan.data.queries)
      .map((q) =>
        typeof q === 'string'
          ? { query: q, segment: '', lookalike_of: '' }
          : {
              query: asText((q as Record<string, unknown>)?.query),
              segment: asText((q as Record<string, unknown>)?.segment),
              lookalike_of: asText((q as Record<string, unknown>)?.lookalike_of),
            },
      )
      .filter((q) => q.query && normQuery(q.query));
    // Repeats are dropped here, whatever the AI was told: the same words reworded, or an earlier
    // query with a word or two added.
    const fresh: Query[] = [];
    const repeats: string[] = [];
    for (const q of proposed) {
      if (tooSimilar(q.query, [...earlier, ...tried, ...fresh.map((x) => x.query)])) repeats.push(q.query);
      else fresh.push({ ...q, segment: canonicalSegment(q.segment, segmentNames) });
    }
    // Taken in turn from each segment, those furthest short of their share first.
    const order = [...segmentNames].sort((a, b) => bySegment(a) - bySegment(b));
    const queue = new Map(order.map((seg) => [seg, fresh.filter((q) => q.segment === seg)]));
    const queries: Query[] = [];
    while (queries.length < PER_ROUND && [...queue.values()].some((l) => l.length)) {
      for (const seg of order) {
        const next = queue.get(seg)?.shift();
        if (next && queries.length < PER_ROUND) queries.push(next);
      }
    }
    for (const q of fresh) if (queries.length < PER_ROUND && !queries.includes(q) && !segmentNames.includes(q.segment)) queries.push(q);
    if (repeats.length) await log(`Skipped ${repeats.length} search${repeats.length === 1 ? '' : 'es'} already run before: ${repeats.map((q) => `"${q}"`).join(', ')}`);
    if (!queries.length) {
      lastError = 'The AI only suggested searches already run before';
      continue;
    }
    rounds++;
    tried.push(...queries.map((q) => q.query));
    await log(`Searching Google${rounds > 1 ? ` (round ${rounds})` : ''}: ${queries.map((q) => `"${q.query}"`).join(', ')}`);

    let okThisRound = 0;
    let failedThisRound = 0;
    // Each query's pages together, so the search is recorded once with what it found.
    const searched = await mapLimit(queries, 4, async (q) => {
      const results: SerperResult[] = [];
      let error = '';
      for (let page = 1; page <= PAGES; page++) {
        try {
          const found = await googleSearch(svc, q.query, page);
          searchesOk++;
          okThisRound++;
          results.push(...found);
          if (found.length < 10) break;
        } catch (e) {
          error = errorMessage(e);
          searchError = error;
          lastError = `Search failed for "${q.query}": ${error}`;
          if (++failedThisRound === 1) await log(lastError, 'warn');
          break;
        }
      }
      return { q, results, error };
    });

    // Results about companies already known are left out (and recorded as such), so the AI only sees
    // what's new and no research is spent rediscovering them.
    const seenLinks = new Set<string>();
    const results: (Found & { searchId: number | null })[] = [];
    for (const { q, results: raw, error } of searched) {
      const rows: Parameters<ProspectHistory['recordResults']>[1] = [];
      let fresh = 0;
      const mine: Found[] = [];
      for (const r of raw) {
        const link = (r.link || '').trim();
        if (!link || seenLinks.has(link.toLowerCase())) continue;
        seenLinks.add(link.toLowerCase());
        const d = domainOf(link);
        const named = normCompany(titleCompany(r.title));
        const isKnown = (!!d && seenDomains.has(d)) || (named.length > 3 && seenNames.has(named));
        rows.push({ url: link, domain: d, title: r.title || '', outcome: isKnown ? 'known' : 'result' });
        if (isKnown) continue;
        fresh++;
        mine.push({ query: q.query, segment: q.segment, lookalike_of: q.lookalike_of, title: r.title, link, snippet: r.snippet || '' });
      }
      const searchId = await history.recordSearch({ query: q.query, segment: q.segment, status: error && !raw.length ? 'failed' : 'ok', resultsCount: raw.length, freshCount: fresh, error });
      await history.recordResults(searchId, rows);
      results.push(...mine.map((m) => ({ ...m, searchId })));
    }
    // Every search failed (no credits, a wrong key): more rounds would fail the same way.
    if (!okThisRound) break;
    if (!results.length) {
      await log('Every result was a company already known; searching again with new queries', 'info');
      continue;
    }

    const pickText = [
      `ICP segments: ${icps.map((i) => i.segment).join(', ')}`,
      '',
      '## Already on the list at these locations (skip the same company at the same location; its plant or branch at another location is new)',
      knownList.length ? knownList.slice(-400).join(', ') : '(none)',
      '',
      '## Search results',
      JSON.stringify(results.map((r) => ({ query: r.query, segment: r.segment, lookalike_of: r.lookalike_of, title: r.title, link: r.link, snippet: r.snippet })), null, 2),
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
    const addedBySearch = new Map<number | null, number>();
    for (const raw of asList(picked.data.companies)) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const company = asText(c.company);
      let domain = domainOf(asText(c.website));
      // …and only when the domain is plausibly this company's (not "cumminscollege.org" for Cummins).
      if (isBlockedDomain(domain) || !resultDomains.has(domain) || !domainScore(company, domain)) domain = '';
      if (!company) continue;
      // The search this company came from (its website's result, else the first that names it).
      const from = results.find((r) => domain && domainOf(r.link || '') === domain) ?? results.find((r) => `${r.title} ${r.snippet}`.toLowerCase().includes(company.toLowerCase()));
      const searchId = from?.searchId ?? null;
      const name = normCompany(company);
      const city = asText(c.city);
      if (seenNames.has(name) || (domain && seenDomains.has(domain)) || branches.has(company, domain, city)) {
        await history.recordResults(searchId, [{ url: from?.link ?? '', domain, title: from?.title ?? '', company, city, outcome: 'duplicate' }]);
        continue;
      }
      if (prospects.length >= want) continue;
      const segment = canonicalSegment(asText(c.segment), segmentNames);
      branches.add(company, domain, city);
      knownList.push(`${company} (${city || 'any location'})`);
      const record = { searchId, row: { url: from?.link ?? '', domain, title: from?.title ?? '', company, city, outcome: 'added' as const } };
      const lookalike = asText(c.lookalike_of);
      const why = asText(c.why);
      const prospect = {
        company,
        website: domain,
        city,
        // The ICP's own spelling; a segment no ICP has stays as given, so research flags it for review
        // instead of checking the company against some other ICP.
        segment,
        source: (lookalike ? `Lookalike of ${lookalike}` : 'Found by prospect search') + (why ? `: ${why}` : ''),
      };
      // A segment at its share waits while another is still short (used at the end if they can't fill).
      // Recorded as found only once used: one held back and never used can be found again another day.
      if (segmentNames.includes(segment) && bySegment(segment) >= share && shortOf().length) {
        heldBack.push({ ...prospect, record });
      } else {
        prospects.push(prospect);
        await history.recordResults(record.searchId, [record.row]);
        addedBySearch.set(record.searchId, (addedBySearch.get(record.searchId) ?? 0) + 1);
      }
    }
    for (const [searchId, count] of addedBySearch) await history.recordAdded(searchId, count);
    if (prospects.length < want && rounds < MAX_ROUNDS) await log(`Round ${rounds}: ${prospects.length - before} new companies; searching further`, 'info');
  }

  // The other segments couldn't fill the run: the companies held back fill it.
  for (const { record, ...p } of heldBack) {
    if (prospects.length >= want) break;
    prospects.push(p);
    await history.recordResults(record.searchId, [record.row]);
    await history.recordAdded(record.searchId, 1);
  }
  // Nothing came back from Google at all, or every step failed: that's a failure, not "no new prospects".
  if (!searchesOk) throw new Error(searchError ? `Google search (Serper) failed on every query: ${searchError}` : lastError || 'Google returned no results. Check SERPER_API_KEY.');
  if (!prospects.length && lastError) throw new Error(lastError);
  return prospects;
}
