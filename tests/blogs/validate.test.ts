import { describe, expect, it } from 'vitest';
import { renderArticleHtml } from '@/lib/blogs/pipeline/markdown';
import type { SourceDoc } from '@/lib/blogs/pipeline/schemas';
import { extractFigures, extractQuotes, keywordDensity, markdownLinks } from '@/lib/blogs/pipeline/text';
import { applyDeterministicFixes, validateArticle, type ValidateInput } from '@/lib/blogs/pipeline/validate';
import { domainConfigSchema } from '@/lib/blogs/domains/config';
import { DOMAIN_SEEDS } from './helpers/domain-seeds';
import { NOW } from './helpers/fakes';
import { GOOD_BODY, richEvidence } from './helpers/pipeline-fixtures';

const sources: SourceDoc[] = richEvidence(4).map((e, i) => ({ n: i + 1, id: `S${i + 1}`, url: e.url, title: e.title, publisher: e.publisher, publishedAt: e.publishedAt, excerpts: e.excerpts, text: e.text! }));
const biz = DOMAIN_SEEDS[0];
const seo = { seoTitle: 'AI Stock Forecasting for Small Retail: What Works', metaDescription: 'A plain-English look at how forecasting tools help small shops cut unsold stock, what the research says, and where the tools fall short.', slug: 'ai-stock-forecasting', secondaryKeywords: [], excerpt: 'x'.repeat(60), imageAlt: 'A shop owner reviewing stock on a tablet', imagePrompt: 'p'.repeat(30), category: 'Business', tags: [], canonicalNote: '', structuredData: [] as never[] };
const claims = [{ text: 'Forecasting software cut unsold stock by 35% in the first year', sourceIds: ['S1'] }];

const base = (over: Partial<ValidateInput> = {}): ValidateInput => ({
  title: 'How small retailers can use forecasting to cut stock waste',
  bodyMarkdown: GOOD_BODY(),
  seo,
  primaryKeyword: 'forecasting small retail',
  sources,
  claims,
  domain: { slug: 'business', name: 'Business', config: domainConfigSchema.parse(biz.config) },
  targetWords: 400,
  existing: [],
  round: 0,
  now: NOW,
  ...over,
});
const codes = (r: ReturnType<typeof validateArticle>, sev?: string) => r.issues.filter((i) => !sev || i.severity === sev).map((i) => i.code);

describe('validateArticle', () => {
  it('passes a well-formed, well-sourced article', () => {
    const r = validateArticle(base());
    expect(codes(r, 'critical')).toEqual([]);
    expect(codes(r, 'major')).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('flags a figure that appears in no source as critical', () => {
    const r = validateArticle(base({ bodyMarkdown: GOOD_BODY('Another study put the saving at 73% for grocers [S1].') }));
    expect(codes(r, 'critical')).toContain('unsupported_figure');
    expect(r.passed).toBe(false);
  });

  it('accepts figures that appear in a source, even with different formatting', () => {
    const r = validateArticle(base({ bodyMarkdown: GOOD_BODY('Savings of 35 percent were reported [S1].') }));
    expect(codes(r)).not.toContain('unsupported_figure');
  });

  it('flags a quotation that is not in any source, but allows a verbatim one', () => {
    const fake = validateArticle(base({ bodyMarkdown: GOOD_BODY('As one expert put it, "forecasting will transform every high street shop within five years" [S1].') }));
    expect(codes(fake, 'critical')).toContain('unverified_quote');
    const real = validateArticle(base({ bodyMarkdown: GOOD_BODY('The team said "Small shops gain the most from simple weekly forecasts" in its summary [S1].') }));
    expect(codes(real)).not.toContain('unverified_quote');
  });

  it('flags text copied from a source', () => {
    const copied = sources[0].text;
    const r = validateArticle(base({ bodyMarkdown: GOOD_BODY(copied) }));
    expect(codes(r, 'critical')).toContain('close_to_source');
  });

  it('flags citations to sources that do not exist', () => {
    const r = validateArticle(base({ bodyMarkdown: GOOD_BODY('This claim cites a ghost [S9].') }));
    expect(codes(r, 'critical')).toContain('unknown_citation');
  });

  it('requires enough distinct citations, more for health and finance', () => {
    const one = GOOD_BODY().replaceAll('[S2]', '[S1]');
    expect(codes(validateArticle(base({ bodyMarkdown: one })), 'major')).toContain('too_few_citations');
    const health = DOMAIN_SEEDS.find((d) => d.slug === 'health')!;
    const r = validateArticle(base({ domain: { slug: 'health', name: 'Health', config: domainConfigSchema.parse(health.config) } }));
    expect(codes(r)).toContain('too_few_citations'); // two sources cited, three needed
  });

  it('flags keyword stuffing', () => {
    const stuffed = GOOD_BODY('forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail forecasting small retail.');
    expect(codes(validateArticle(base({ bodyMarkdown: stuffed })))).toEqual(expect.arrayContaining([expect.stringMatching(/keyword_(stuffing|density_high)/)]));
    expect(keywordDensity('one two three', 'two')).toBeCloseTo(1 / 3);
  });

  it('flags generic filler and repetition', () => {
    const filler = GOOD_BODY("In today's fast-paced world, it is important to note that we delve into a game-changer.");
    expect(codes(validateArticle(base({ bodyMarkdown: filler })), 'major')).toContain('generic_filler');
    const repeated = GOOD_BODY('The same sentence appears here again and again. '.repeat(12));
    expect(codes(validateArticle(base({ bodyMarkdown: repeated })))).toContain('repetitive');
  });

  it('flags structure problems: H1, too few sections, empty section, raw script', () => {
    expect(codes(validateArticle(base({ bodyMarkdown: `# A title\n\n${GOOD_BODY()}` })))).toContain('body_has_h1');
    expect(codes(validateArticle(base({ bodyMarkdown: 'Intro text.\n\n## Only one\n\nSome text here.' })))).toEqual(expect.arrayContaining(['few_sections', 'too_short']));
    expect(codes(validateArticle(base({ bodyMarkdown: GOOD_BODY('\n\n## Empty heading\n\n## Next heading\n\nText.') })))).toContain('empty_section');
    expect(codes(validateArticle(base({ bodyMarkdown: GOOD_BODY('<script>alert(1)</script>') })), 'critical')).toContain('raw_html');
  });

  it('flags missing or poor metadata', () => {
    expect(codes(validateArticle(base({ seo: null })), 'critical')).toContain('missing_seo');
    expect(codes(validateArticle(base({ seo: { ...seo, metaDescription: 'Too short to be useful for anyone at all.' } })), 'major')).toContain('meta_description_length');
    expect(codes(validateArticle(base({ seo: { ...seo, slug: 'Bad Slug!' } })))).toContain('bad_slug');
    expect(codes(validateArticle(base({ hasImage: false })))).toContain('missing_image');
  });

  it('flags near-duplicates of existing articles', () => {
    const r = validateArticle(base({ existing: [{ id: 'a', title: 'Existing piece', slug: 'existing-piece', bodyMarkdown: GOOD_BODY() }] }));
    expect(codes(r, 'critical')).toContain('near_duplicate');
  });

  it('checks links: only researched sources and existing internal pages', () => {
    expect(markdownLinks('[a](https://x.com) ![img](https://y.com/i.png) [b](/slug)').map((l) => l.url)).toEqual(['https://x.com', '/slug']);
    expect(codes(validateArticle(base({ bodyMarkdown: GOOD_BODY('See [this](https://random.example.org/page).') })))).toContain('link_not_in_sources');
    expect(codes(validateArticle(base({ bodyMarkdown: GOOD_BODY('See [this](javascript:alert(1)).') })), 'critical')).toContain('bad_link');
    expect(codes(validateArticle(base({ bodyMarkdown: GOOD_BODY('See [this](/missing-page).') })))).toContain('unknown_internal_link');
    const ok = validateArticle(base({ bodyMarkdown: GOOD_BODY('See [our guide](/existing-piece).'), existing: [{ id: 'a', title: 'T', slug: 'existing-piece', bodyMarkdown: 'Entirely different words about gardens and weather patterns.' }] }));
    expect(codes(ok)).not.toContain('unknown_internal_link');
  });

  it('applies restricted-claim patterns as overridable risk flags and demands disclaimers', () => {
    const health = DOMAIN_SEEDS.find((d) => d.slug === 'health')!;
    const domain = { slug: 'health', name: 'Health', config: domainConfigSchema.parse(health.config) };
    const r = validateArticle(base({ domain, bodyMarkdown: GOOD_BODY('This supplement is a miracle for joints [S1][S2][S3].') }));
    const hit = r.issues.find((i) => i.code === 'restricted_pattern');
    expect(hit).toMatchObject({ severity: 'critical', overridable: true });
    expect(codes(r)).toContain('missing_disclaimer');
  });
});

describe('deterministic fixes', () => {
  it('removes a leading H1 and adds the health/finance disclaimer once', () => {
    const a = applyDeterministicFixes('# Title\n\nBody text.', 'health');
    expect(a.markdown.startsWith('Body text.')).toBe(true);
    expect(a.markdown).toMatch(/not medical advice/);
    expect(applyDeterministicFixes(a.markdown, 'health').changes).toEqual([]);
    expect(applyDeterministicFixes('Body.', 'finance').markdown).toMatch(/not financial advice/);
    expect(applyDeterministicFixes('Body.', 'business').changes).toEqual([]);
  });
});

describe('text helpers', () => {
  it('extracts figures that need sources but skips years and small counts', () => {
    expect(extractFigures('In 2026, 3 steps raised sales by 12.5% to $4,200 and 1,500 units.').map((f) => f.digits)).toEqual(['12.5', '4200', '1500']);
  });
  it('extracts only long quotations', () => {
    expect(extractQuotes('He said "no way" and "this is a much longer quoted passage from someone".')).toEqual(['this is a much longer quoted passage from someone']);
  });
});

describe('renderArticleHtml', () => {
  const refs = [{ n: 1, title: 'First <b>source</b>', url: 'https://a.example.com/x?y=1&z=2', publisher: 'a.example.com' }];
  it('strips scripts, event handlers and javascript: links', () => {
    const html = renderArticleHtml('Hello <script>alert(1)</script> <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](https://good.example.com)', refs);
    expect(html).not.toMatch(/<script|onerror|javascript:|<img/i);
    expect(html).toContain('href="https://good.example.com"');
  });
  it('turns citation markers into numbered links and drops unknown ones', () => {
    const html = renderArticleHtml('A claim [S1]. Another [S7].', refs);
    expect(html).toContain('<a href="#source-1">1</a>');
    expect(html).not.toContain('S7');
    expect(html).toContain('id="source-1"');
    expect(html).toContain('First &lt;b&gt;source&lt;/b&gt;');
  });
  it('escapes ampersands in source URLs', () => {
    expect(renderArticleHtml('x [S1]', refs)).toContain('y=1&amp;z=2');
  });
});

import { parseJsonText } from '@/lib/blogs/providers/gemini';

describe('parseJsonText', () => {
  it('parses fenced JSON and repairs small slips from the model', () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('Here you go: {"a": "x", "b": [1,2,],}')).toEqual({ a: 'x', b: [1, 2] });
    expect(() => parseJsonText('no json here')).toThrow();
  });
});
