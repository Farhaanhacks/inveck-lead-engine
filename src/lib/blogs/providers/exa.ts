import 'server-only';
import { ProviderError, type Evidence, type ResearchProvider, type SearchOptions, type SearchResult } from './types';

type ExaResult = { url: string; title?: string | null; publishedDate?: string | null; author?: string | null; highlights?: string[]; text?: string };
type ExaResponse = { results?: ExaResult[]; costDollars?: { total?: number } };

export function publisherFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Maps Exa's response to Evidence. Exported for tests. */
export function toEvidence(results: ExaResult[], retrievedAt: string): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    try {
      const u = new URL(r.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    seen.add(r.url);
    out.push({
      url: r.url,
      title: (r.title ?? '').trim() || r.url,
      publisher: publisherFromUrl(r.url),
      publishedAt: r.publishedDate ?? null,
      retrievedAt,
      excerpts: (r.highlights ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 3),
      ...(r.text ? { text: r.text.trim() } : {}),
    });
  }
  return out;
}

export class ExaProvider implements ResearchProvider {
  readonly name = 'exa';
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query,
      numResults: options.numResults ?? 8,
      type: 'auto',
      contents: { highlights: { maxCharacters: 700 }, ...(options.textChars ? { text: { maxCharacters: options.textChars } } : {}) },
    };
    if (options.news) body.category = 'news';
    if (options.since) body.startPublishedDate = options.since.toISOString();

    const data = await this.post('/search', body);
    return {
      results: toEvidence(data.results ?? [], new Date().toISOString()),
      usage: { provider: 'exa', operation: 'search', requests: 1, reportedCostUsd: data.costDollars?.total },
    };
  }

  async fetchContents(urls: string[], maxChars = 6000): Promise<SearchResult> {
    if (!urls.length) return { results: [], usage: { provider: 'exa', operation: 'contents', requests: 0, reportedCostUsd: 0 } };
    const data = await this.post('/contents', { urls, text: { maxCharacters: maxChars } });
    return {
      results: toEvidence(data.results ?? [], new Date().toISOString()),
      usage: { provider: 'exa', operation: 'contents', requests: 1, reportedCostUsd: data.costDollars?.total },
    };
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ExaResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.exa.ai${path}`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError(`Exa request failed: ${e instanceof Error ? e.message : String(e)}`, 'exa', true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new ProviderError(`Exa returned ${res.status}: ${detail}`, 'exa', res.status === 429 || res.status >= 500, res.status);
    }
    return (await res.json()) as ExaResponse;
  }
}
