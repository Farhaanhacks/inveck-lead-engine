import { describe, expect, it } from 'vitest';
import { chooseImageService } from '@/lib/blogs/providers/image-choice';
import { WaveSpeedImageProvider } from '@/lib/blogs/providers/wavespeed';

const JPEG = new Uint8Array(new ArrayBuffer(4000)).fill(255);
const CDN = 'https://cdn.wavespeed.ai/out/abc.jpeg';
type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A fake WaveSpeed: replies to each API call in order, then serves the image from the CDN URL. */
function fake(replies: { status?: number; json?: unknown; text?: string }[], image: { status?: number; type?: string; bytes?: Uint8Array<ArrayBuffer> } = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : null });
    if (String(url) === CDN) return new Response(image.bytes ?? JPEG, { status: image.status ?? 200, headers: { 'content-type': image.type ?? 'image/jpeg' } });
    const r = replies.shift() ?? { status: 500, text: 'no more replies' };
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { p: new WaveSpeedImageProvider('wsk_test', f, 1, 2000), calls };
}
const done = { code: 200, data: { id: 't1', status: 'completed', outputs: [CDN] } };

describe('WaveSpeedImageProvider', () => {
  it('submits to the model endpoint with a Bearer key and 16:9 size, and downloads the output', async () => {
    const { p, calls } = fake([{ json: done }]);
    const r = await p.generateImage({ model: 'wavespeed-ai/z-image/turbo', prompt: 'A rooftop   dish at dusk' });
    expect(calls[0]).toMatchObject({ url: 'https://api.wavespeed.ai/api/v3/wavespeed-ai/z-image/turbo', method: 'POST', auth: 'Bearer wsk_test' });
    expect(calls[0].body).toMatchObject({ prompt: 'A rooftop dish at dusk', size: '1344*768', enable_sync_mode: true, enable_base64_output: false });
    expect(calls.every((c) => !c.url.includes('wsk_test'))).toBe(true); // the key never goes in a URL
    expect(calls[1].url).toBe(CDN);
    expect(calls[1].auth).toBeNull(); // nor to the CDN
    expect(r.bytes.length).toBe(4000);
    expect(r).toMatchObject({ mimeType: 'image/jpeg', usage: { provider: 'wavespeed', model: 'wavespeed-ai/z-image/turbo' } });
  });

  it('sends Nano Banana an aspect ratio instead of a pixel size', async () => {
    const { p, calls } = fake([{ json: done }]);
    await p.generateImage({ model: 'google/nano-banana/text-to-image', prompt: 'x' });
    expect(calls[0].url).toBe('https://api.wavespeed.ai/api/v3/google/nano-banana/text-to-image');
    expect(calls[0].body).toEqual({ prompt: 'x', aspect_ratio: '16:9', output_format: 'jpeg', enable_sync_mode: true, enable_base64_output: false });
  });

  it('polls the result endpoint until the task completes', async () => {
    const { p, calls } = fake([{ json: { code: 200, data: { id: 't1', status: 'created', outputs: [] } } }, { json: { code: 200, data: { id: 't1', status: 'processing', outputs: [] } } }, { json: done }]);
    await p.generateImage({ model: 'm/x', prompt: 'x' });
    expect(calls.slice(1, 3).map((c) => c.url)).toEqual(Array(2).fill('https://api.wavespeed.ai/api/v3/predictions/t1/result'));
  });

  it('reports a failed task, and gives up when it never finishes', async () => {
    await expect(fake([{ json: { data: { id: 't1', status: 'failed', error: 'NSFW content detected' } } }]).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toThrow(/failed: NSFW/);
    const slow = new WaveSpeedImageProvider('k', (async () => new Response(JSON.stringify({ data: { id: 't', status: 'processing' } }))) as unknown as typeof fetch, 5, 30);
    await expect(slow.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: true, message: expect.stringMatching(/not ready in time/) });
  });

  it('treats a bad key or no credit as permanent, and overload as temporary', async () => {
    await expect(fake([{ status: 401, text: 'unauthorized' }]).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: false, status: 401, message: expect.stringMatching(/rejected the API key/) });
    await expect(fake([{ status: 402, text: 'insufficient balance' }]).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: false, message: expect.stringMatching(/out of credit/) });
    await expect(fake([{ status: 503, text: 'busy' }]).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: true, status: 503 });
    await expect(fake([{ status: 429, text: 'slow down' }]).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: true });
  });

  it('refuses a missing, empty or non-image output', async () => {
    await expect(fake([{ json: { data: { id: 't', status: 'completed', outputs: [] } } }]).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toThrow(/without an image/);
    await expect(fake([{ json: done }], { type: 'text/html' }).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toThrow(/text\/html/);
    await expect(fake([{ json: done }], { bytes: new Uint8Array(new ArrayBuffer(10)) }).p.generateImage({ model: 'm', prompt: 'x' })).rejects.toThrow(/empty image/);
  });
});

describe('chooseImageService', () => {
  it('prefers WaveSpeed, then Pollinations, then none (Gemini)', () => {
    expect(chooseImageService({ WAVESPEED_API_KEY: 'w', POLLINATIONS_API_KEY: 'p' })).toMatchObject({ name: 'wavespeed', model: 'google/nano-banana/text-to-image' });
    expect(chooseImageService({ WAVESPEED_API_KEY: 'w', WAVESPEED_IMAGE_MODEL: 'bytedance/seedream-v4' })?.model).toBe('bytedance/seedream-v4');
    expect(chooseImageService({ POLLINATIONS_API_KEY: 'p' })).toMatchObject({ name: 'pollinations', model: 'tongyi-mai/z-image-turbo' });
    expect(chooseImageService({})).toBeNull();
    expect(chooseImageService({ WAVESPEED_API_KEY: 'w' })!.provider().name).toBe('wavespeed');
  });
});
