import { describe, expect, it } from 'vitest';
import { PollinationsImageProvider } from '@/lib/blogs/providers/pollinations';

function provider(status: number, body: BodyInit | null, type = 'image/jpeg') {
  const calls: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    return new Response(body, { status, headers: { 'content-type': type } });
  }) as unknown as typeof fetch;
  return { p: new PollinationsImageProvider('sk_test', f), calls };
}
const JPEG = new Uint8Array(4000).fill(255);

describe('PollinationsImageProvider', () => {
  it('calls the documented endpoint with a Bearer key, model and 16:9 size, and returns the bytes', async () => {
    const { p, calls } = provider(200, JPEG);
    const r = await p.generateImage({ model: 'tongyi-mai/z-image-turbo', prompt: 'A rooftop   dish at dusk' });
    const u = new URL(calls[0].url);
    expect(u.origin + decodeURIComponent(u.pathname)).toBe('https://gen.pollinations.ai/image/A rooftop dish at dusk');
    expect(u.searchParams.get('model')).toBe('tongyi-mai/z-image-turbo');
    expect([u.searchParams.get('width'), u.searchParams.get('height')]).toEqual(['1344', '768']);
    expect(calls[0].auth).toBe('Bearer sk_test');
    expect(calls[0].url).not.toContain('sk_test'); // the key never goes in the URL
    expect(r.bytes.length).toBe(4000);
    expect(r).toMatchObject({ mimeType: 'image/jpeg', usage: { provider: 'pollinations', model: 'tongyi-mai/z-image-turbo' } });
  });

  it('treats a bad key or no credit as permanent, and overload as temporary', async () => {
    await expect(provider(401, 'unauthorized', 'text/plain').p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: false, status: 401, message: expect.stringMatching(/rejected the API key/) });
    await expect(provider(402, 'no pollen', 'text/plain').p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: false, message: expect.stringMatching(/out of credit/) });
    await expect(provider(503, 'busy', 'text/plain').p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: true, status: 503 });
    await expect(provider(429, 'slow down', 'text/plain').p.generateImage({ model: 'm', prompt: 'x' })).rejects.toMatchObject({ transient: true });
  });

  it('refuses a response that is not an image', async () => {
    await expect(provider(200, '{"error":"x"}', 'application/json').p.generateImage({ model: 'm', prompt: 'x' })).rejects.toThrow(/instead of an image/);
    await expect(provider(200, new Uint8Array(10), 'image/png').p.generateImage({ model: 'm', prompt: 'x' })).rejects.toThrow(/empty image/);
  });
});
