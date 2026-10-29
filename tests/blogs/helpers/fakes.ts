import type { Evidence, GenerateJsonOptions, LlmProvider, ResearchProvider, SearchResult } from '@/lib/blogs/providers/types';
import { ProviderError } from '@/lib/blogs/providers/types';

export const NOW = new Date('2026-10-18T06:00:00Z');

export const evidence = (n: number): Evidence[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://news${i + 1}.example.com/story-${i + 1}`,
    title: `Story ${i + 1} about the topic`,
    publisher: `news${i + 1}.example.com`,
    publishedAt: new Date(NOW.getTime() - (i + 1) * 864e5).toISOString(),
    retrievedAt: NOW.toISOString(),
    excerpts: [`Excerpt ${i + 1}`],
  }));

export class FakeResearch implements ResearchProvider {
  readonly name = 'fake-research';
  calls: string[] = [];
  fetched: string[][] = [];
  constructor(private results: Evidence[] = evidence(6), private failWith?: ProviderError) {}
  async search(query: string): Promise<SearchResult> {
    this.calls.push(query);
    if (this.failWith) throw this.failWith;
    return { results: this.results, usage: { provider: 'fake-research', operation: 'search', requests: 1, reportedCostUsd: 0.007 } };
  }
  async fetchContents(urls: string[]): Promise<SearchResult> {
    this.fetched.push(urls);
    if (this.failWith) throw this.failWith;
    return { results: this.results.filter((r) => urls.includes(r.url)), usage: { provider: 'fake-research', operation: 'contents', requests: 1, reportedCostUsd: 0.001 } };
  }
}

export const candidate = (over: Record<string, unknown> = {}) => ({
  headline: 'How small retailers are using AI to cut stock waste this autumn',
  altHeadlines: ['AI stock planning for small shops explained', 'Can AI really reduce retail waste?'],
  summary: 'Small retailers are adopting AI forecasting tools to reduce unsold stock. This explainer covers what the tools do, what they cost and where they fall short for shops with thin margins.',
  category: 'Retail',
  primaryKeyword: 'ai stock forecasting small retail',
  secondaryKeywords: ['retail inventory ai', 'reduce stock waste'],
  relatedQuestions: ['Is AI inventory software worth it for a small shop?'],
  searchIntent: 'informational',
  targetAudience: 'Owners of small independent retail shops',
  articleFormat: 'Explainer',
  rationale: 'Several outlets covered launches of low-cost forecasting tools this week and few guides address small shops.',
  contentGap: 'Existing coverage targets large chains; a plain guide for shops under ten staff is missing.',
  trendEvidence: 'Three publishers covered new tools in the past week.',
  sourceIds: ['S1', 'S2', 'S3'],
  risks: [],
  relevanceScore: 80,
  engagementScore: 65,
  gapScore: 70,
  ...over,
});

export class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  prompts: GenerateJsonOptions[] = [];
  constructor(private respond: (call: number, options: GenerateJsonOptions) => unknown | Error) {}
  async generateJson(options: GenerateJsonOptions) {
    this.prompts.push(options);
    const out = this.respond(this.prompts.length, options);
    if (out instanceof Error) throw out;
    return { json: out, usage: { provider: 'fake-llm', model: options.model, operation: 'generate_json', inputTokens: 1000, outputTokens: 500, requests: 1 } };
  }
}
