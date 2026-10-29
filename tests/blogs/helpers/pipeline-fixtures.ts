import sharp from 'sharp';
import type { ImageProvider, ImageResult } from '@/lib/blogs/providers/types';
import { ProviderError } from '@/lib/blogs/providers/types';
import type { ImageStorage } from '@/lib/blogs/pipeline/image';
import type { Evidence } from '@/lib/blogs/providers/types';
import { NOW } from './fakes';

/** Deterministic, varied prose so repetition and keyword checks behave like they would on real text. */
function prose(seed: number, sentences: number): string {
  // Pseudo-words keep n-gram repetition at the level of real prose; the checks under test are not about vocabulary.
  let x = seed * 7919 + 13;
  const rnd = (n: number) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return (x >> 8) % n; };
  const syl = ['ba', 'ko', 'ri', 'tu', 'me', 'sa', 'lo', 'ven', 'dar', 'mil', 'qua', 'zen', 'pro', 'fi', 'gal', 'hu', 'nor', 'wex', 'yat', 'cel'];
  const word = () => Array.from({ length: 2 + rnd(2) }, () => syl[rnd(syl.length)]).join('');
  const fn = ['the', 'and', 'with', 'for', 'near', 'after', 'while'];
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const w: string[] = [];
    for (let j = 0; j < 14; j++) w.push(j % 4 === 3 ? fn[rnd(fn.length)] : word());
    out.push(`${w[0][0].toUpperCase()}${w[0].slice(1)} ${w.slice(1).join(' ')}.`);
  }
  return out.join(' ');
}

export const SOURCE_TEXT = (n: number) =>
  `Report ${n}. Independent retailers surveyed in the autumn said forecasting software cut unsold stock by 35% in the first year. ` +
  `The study found that adoption was highest among shops with fewer than ten staff. "Small shops gain the most from simple weekly forecasts" said the research team in its summary. ` +
  `${prose(900 + n, 12)} Analysts cautioned that results vary widely between product categories and that setup takes several weeks.`;

export const richEvidence = (n: number): Evidence[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://news${i + 1}.example.com/story-${i + 1}`,
    title: `Story ${i + 1} about forecasting`,
    publisher: `news${i + 1}.example.com`,
    publishedAt: new Date(NOW.getTime() - (i + 1) * 864e5).toISOString(),
    retrievedAt: NOW.toISOString(),
    excerpts: [`Excerpt ${i + 1}`],
    text: SOURCE_TEXT(i + 1),
  }));

export const GOOD_BODY = (extra = '', seed = 0) =>
  `Small shops lose money when stock sits unsold, and forecasting tools promise to help [S1]. This guide explains how the tools work and where they fall short.

## What the research found

Independent retailers surveyed in the autumn reported that forecasting software cut unsold stock by 35% in the first year [S1]. Adoption was highest among shops with fewer than ten staff [S2]. ${prose(11 + seed * 1000, 14)}

## How owners put it to use

${prose(22 + seed * 1000, 16)} ${extra}

## Where the tools fall short

Analysts cautioned that results vary widely between product categories, and that setup takes several weeks [S2]. ${prose(33 + seed * 1000, 14)}

## Frequently asked questions

### Is it worth it for a very small shop?

${prose(44 + seed * 1000, 10)}

## What to take away

${prose(55 + seed * 1000, 10)}
`;

let draftSeq = 0;
/** Each call yields different prose, so articles from different jobs are not near-duplicates of one another. */
export const goodDraft = (extra = '') => ({
  bodyMarkdown: GOOD_BODY(extra, ++draftSeq),
  claims: [
    { text: 'Forecasting software cut unsold stock by 35% in the first year', sourceIds: ['S1'] },
    { text: 'Adoption was highest among shops with fewer than ten staff', sourceIds: ['S2'] },
    { text: 'Results vary widely between product categories and setup takes several weeks', sourceIds: ['S2'] },
  ],
});

export const outlineJson = () => ({
  title: 'How small retailers can use forecasting to cut stock waste',
  angle: 'A plain guide for owners of shops with fewer than ten staff',
  sections: [
    { heading: 'What the research found', level: 2, keyPoints: ['35% less unsold stock'], sourceIds: ['S1'] },
    { heading: 'How owners put it to use', level: 2, keyPoints: ['weekly cadence'], sourceIds: ['S2'] },
    { heading: 'Where the tools fall short', level: 2, keyPoints: ['category variance'], sourceIds: ['S2'] },
  ],
  faqs: [{ question: 'Is it worth it for a very small shop?', keyPoints: ['depends on volume'], sourceIds: ['S2'] }],
  comparison: null,
  conclusionPoints: ['start small'],
  internalLinks: [],
});

export const seoJson = () => ({
  seoTitle: 'AI Stock Forecasting for Small Retail: What Works',
  metaDescription: 'A plain-English look at how forecasting tools help small shops cut unsold stock, what the research says, and where the tools fall short.',
  slug: 'ai-stock-forecasting-small-retail',
  secondaryKeywords: ['retail inventory', 'reduce stock waste'],
  excerpt: 'Forecasting tools can help small shops sell through stock, but results vary. Here is what the evidence shows.',
  imageAlt: 'A shop owner reviewing stock levels on a tablet in a bright store',
  imagePrompt: 'A small shop owner reviewing inventory on a tablet in a bright independent store, soft natural light',
  category: 'Business',
  tags: ['retail', 'inventory', 'forecasting'],
  canonicalNote: '',
  structuredData: ['Article', 'FAQPage'],
});

/** Answers each pipeline prompt with canned JSON; callers can override per kind. */
export function pipelineResponder(over: Partial<Record<'outline' | 'write' | 'seo' | 'verify' | 'repair', (n: number) => unknown>> = {}) {
  const calls = { outline: 0, write: 0, seo: 0, verify: 0, repair: 0 };
  const respond = (system: string, prompt: string): unknown => {
    const kind = system.includes('planning editor') ? 'outline' : system.includes('search metadata') ? 'seo' : system.includes('fact-checking') ? 'verify' : prompt.startsWith('Revise the article') ? 'repair' : 'write';
    calls[kind]++;
    const o = over[kind];
    if (o) return o(calls[kind]);
    switch (kind) {
      case 'outline': return outlineJson();
      case 'seo': return seoJson();
      case 'write':
      case 'repair': return goodDraft();
      case 'verify': {
        const count = (prompt.match(/^#\d+:/gm) ?? []).length;
        const quotes = ['reduced unsold stock by 35%', 'cut unsold stock by 35% in the first year', 'adoption was highest among shops with fewer than ten staff'];
        return { verdicts: Array.from({ length: count }, (_, index) => ({ index, verdict: 'supported', evidenceQuote: index === 0 ? 'cut unsold stock by 35% in the first year' : index === 1 ? 'adoption was highest among shops with fewer than ten staff' : 'results vary widely between product categories and that setup takes several weeks', note: quotes[0] ? '' : '' })) };
      }
    }
  };
  return { respond, calls };
}

export class FakeImage implements ImageProvider {
  readonly name = 'fake-image';
  calls = 0;
  constructor(private failures: ProviderError[] = []) {}
  async generateImage(): Promise<ImageResult> {
    this.calls++;
    const f = this.failures.shift();
    if (f) throw f;
    const bytes = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 60, g: 120, b: 100 } } }).png().toBuffer();
    return { bytes, mimeType: 'image/png', usage: { provider: 'fake-image', model: 'img', operation: 'generate_image', requests: 1 } };
  }
}

export class MemoryStorage implements ImageStorage {
  stored = new Map<string, { bytes: number; type: string }>();
  async put(key: string, bytes: Buffer, contentType: string) {
    this.stored.set(key, { bytes: bytes.length, type: contentType });
    return { url: `https://storage.example.com/${key}` };
  }
}
