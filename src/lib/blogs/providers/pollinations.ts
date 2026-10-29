import { ProviderError, type ImageProvider, type ImageResult } from './types';

/** Width x height per aspect ratio, in multiples of 32 so every Pollinations model accepts them. */
const SIZES: Record<string, [number, number]> = { '16:9': [1344, 768], '1:1': [1024, 1024], '4:3': [1152, 864] };

/**
 * pollinations.ai image API (https://gen.pollinations.ai/image/{prompt}), authenticated with a server-side `sk_` key as a Bearer token,
 * as documented in pollinations' APIDOCS.md. Returns the raw image bytes; the pipeline resizes and converts them.
 */
export class PollinationsImageProvider implements ImageProvider {
  readonly name = 'pollinations';
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async generateImage({ model, prompt, aspectRatio = '16:9', signal }: { model: string; prompt: string; aspectRatio?: string; signal?: AbortSignal }): Promise<ImageResult> {
    const [width, height] = SIZES[aspectRatio] ?? SIZES['16:9'];
    const params = new URLSearchParams({ model, width: String(width), height: String(height), seed: String(Math.floor(Math.random() * 2_000_000_000)) });
    const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt.replace(/\s+/g, ' ').trim().slice(0, 1500))}?${params}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: signal ?? AbortSignal.timeout(120_000) });
    } catch (e) {
      throw new ProviderError(`Pollinations request failed: ${e instanceof Error ? e.message : String(e)}`, 'pollinations', true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      // 429/5xx are temporary (the docs say to retry); 401/403 is a bad key; 402 means the account has run out of credit.
      const transient = res.status === 429 || res.status >= 500;
      const what = res.status === 401 || res.status === 403 ? 'rejected the API key' : res.status === 402 ? 'reports the account is out of credit' : `returned ${res.status}`;
      throw new ProviderError(`Pollinations ${what}: ${detail}`, 'pollinations', transient, res.status);
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new ProviderError(`Pollinations returned ${type || 'no content type'} instead of an image`, 'pollinations', true);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1000) throw new ProviderError('Pollinations returned an empty image', 'pollinations', true);
    return { bytes, mimeType: type.split(';')[0], usage: { provider: 'pollinations', model, operation: 'generate_image', requests: 1 } };
  }
}
