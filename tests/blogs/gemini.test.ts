import { describe, expect, it } from 'vitest';
import { GeminiProvider } from '@/lib/blogs/providers/gemini';
import { ProviderError } from '@/lib/blogs/providers/types';

type Step = { status: number; body?: unknown };
function provider(steps: Step[]) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    const step = steps[Math.min(urls.length - 1, steps.length - 1)];
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { gemini: new GeminiProvider('key', f, async (ms) => { sleeps.push(ms); }), urls, sleeps };
}
const OK = { status: 200, body: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } } };
const BUSY = { status: 503, body: { error: { message: 'This model is currently experiencing high demand.' } } };
const call = (g: GeminiProvider, fallbackModels?: string[]) => g.generateJson({ model: 'main', system: 's', prompt: 'p', fallbackModels });
const modelOf = (u: string) => /models\/([^:]+):/.exec(u)![1];

describe('GeminiProvider overload handling', () => {
  it('waits and retries the same model once on a 503', async () => {
    const { gemini, urls, sleeps } = provider([BUSY, OK]);
    expect((await call(gemini)).json).toEqual({ ok: true });
    expect(urls.map(modelOf)).toEqual(['main', 'main']);
    expect(sleeps).toEqual([2500]);
  });

  it('falls back to the next model when the first stays overloaded', async () => {
    const { gemini, urls } = provider([BUSY, BUSY, OK]);
    const r = await call(gemini, ['backup-1', 'backup-2']);
    expect(urls.map(modelOf)).toEqual(['main', 'main', 'backup-1']);
    expect(r.usage.model).toBe('backup-1'); // usage records the model that actually answered
  });

  it('skips a fallback that is unavailable (404) or out of quota (429) and keeps going', async () => {
    const { gemini, urls } = provider([{ status: 404 }, { status: 429 }, OK]);
    await call(gemini, ['gone', 'quota-out', 'works']);
    expect(urls.map(modelOf)).toEqual(['main', 'gone', 'quota-out']);
  });

  it('throws the last overload error, still marked transient, when every model is busy', async () => {
    const { gemini } = provider([BUSY]);
    const err = await call(gemini, ['b1']).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ transient: true, status: 503 });
  });

  it('does not move on for errors another model cannot fix', async () => {
    const { gemini, urls } = provider([{ status: 400, body: { error: { message: 'bad request' } } }, OK]);
    await expect(call(gemini, ['b1'])).rejects.toMatchObject({ status: 400 });
    expect(urls).toHaveLength(1);
    const blocked = provider([{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }, OK]);
    await expect(call(blocked.gemini, ['b1'])).rejects.toThrow(/blocked/);
    expect(blocked.urls).toHaveLength(1);
  });
});
