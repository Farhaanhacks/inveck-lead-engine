import type { Signal } from '../db/schema';
import { askJson } from './ai';
import { SIGNALS_PROMPT } from './prompts';
import type { NewsResult, Services } from './services';
import { newsSearch } from './services';
import { asList, asText, errorMessage, normCompany, searchName } from './text';
import { nameTokens } from './website';

const KINDS = ['expansion', 'new_facility', 'acquisition', 'funding', 'audit', 'hiring', 'leadership', 'other'];

export const SIGNAL_LABELS: Record<string, string> = {
  expansion: 'Expansion',
  new_facility: 'New facility',
  acquisition: 'Acquisition',
  funding: 'Funding',
  audit: 'Audit',
  hiring: 'Hiring',
  leadership: 'Leadership',
  other: 'News',
};

const schema = {
  type: 'object',
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, headline: { type: 'string' }, kind: { type: 'string', enum: KINDS } },
        required: ['id', 'headline', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['signals'],
  additionalProperties: false,
};

/** A company's news checked in the last this many days isn't checked again, where that's asked for (the Morning Sample Run). */
export const NEWS_MEMORY_DAYS = 7;

/**
 * Buying signals: one Google News search for the company's last year, then the AI picks
 * the items that suggest it needs INVECK now. It answers with item numbers, so every
 * signal links to a real article about this company. With `remember`, the signals found for the
 * company in the last NEWS_MEMORY_DAYS are used again (no search); a failed check isn't remembered.
 */
export async function findSignals(svc: Services, company: string, opts: { remember?: boolean } = {}): Promise<{ signals: Signal[]; error: string }> {
  const name = searchName(company);
  if (!name) return { signals: [], error: '' };
  if (!opts.remember) return checkNews(svc, company, name);
  const key = `news-check:v1:${normCompany(company)}`;
  const was = (await svc.cache?.get(key).catch(() => null)) as { at?: string; signals?: Signal[] } | null;
  if (was?.at && Array.isArray(was.signals) && Date.now() - new Date(was.at).getTime() < NEWS_MEMORY_DAYS * 86_400_000) return { signals: was.signals, error: '' };
  const found = await checkNews(svc, company, name);
  if (!found.error) await svc.cache?.set(key, { at: new Date().toISOString(), signals: found.signals }).catch(() => {});
  return found;
}

async function checkNews(svc: Services, company: string, name: string): Promise<{ signals: Signal[]; error: string }> {
  let news: NewsResult[];
  try {
    news = await newsSearch(
      svc,
      `"${name}" (plant OR expansion OR warehouse OR facility OR acquisition OR acquires OR investment OR capex OR IPO OR funding OR audit OR inventory OR appoints)`,
    );
  } catch (e) {
    return { signals: [], error: errorMessage(e) };
  }
  const tokens = nameTokens(company);
  const items = news
    .filter((n) => n.link && n.title && tokens.some((t) => `${n.title} ${n.snippet}`.toLowerCase().includes(t)))
    .slice(0, 10);
  if (!items.length) return { signals: [], error: '' };

  const list = items.map((n, i) => `${i + 1}. ${n.title} (${n.source || 'news'}, ${n.date || 'recent'})\n   ${n.snippet || ''}`).join('\n');
  const result = await askJson(svc, SIGNALS_PROMPT, `Company: ${company}\n\n## News\n${list}`, schema);
  if (result.error !== undefined) return { signals: [], error: result.error };

  const seen = new Set<number>();
  const signals: Signal[] = [];
  for (const raw of asList(result.data.signals)) {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const index = Number(asText(s.id).replace(/\D/g, '')) - 1;
    const item = items[index];
    if (!item || seen.has(index)) continue;
    seen.add(index);
    const kind = asText(s.kind);
    signals.push({
      headline: (asText(s.headline) || item.title || '').slice(0, 140),
      date: item.date || '',
      url: item.link || '',
      source: item.source || '',
      kind: KINDS.includes(kind) ? kind : 'other',
    });
    if (signals.length >= 3) break;
  }
  return { signals, error: '' };
}

/** "Opened a new plant in Chakan (Economic Times, 3 weeks ago)" lines for the AI. */
export function signalLines(signals: Signal[]): string {
  return signals.map((s) => `- ${s.headline} (${[s.source, s.date].filter(Boolean).join(', ')})`).join('\n');
}
