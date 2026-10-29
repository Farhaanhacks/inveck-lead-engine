import { ProviderError, type ImageProvider, type ImageResult } from './types';

const API = 'https://api.wavespeed.ai/api/v3';
/** Width x height per aspect ratio, within the 256-1536 px range WaveSpeed's image models accept. */
const SIZES: Record<string, [number, number]> = { '16:9': [1344, 768], '1:1': [1024, 1024], '4:3': [1152, 864] };
const FAILED = new Set(['failed', 'cancelled', 'timeout', 'deleted']);

type Prediction = { id?: string; status?: string; outputs?: unknown[]; error?: string | null; urls?: { get?: string } };

/**
 * WaveSpeed AI (https://wavespeed.ai/docs/submit-task): POST /api/v3/{model} with a Bearer key, then read
 * /api/v3/predictions/{id}/result until it completes. Sync mode is requested so most images come back in the first
 * response; polling (at the documented 2 s minimum interval) covers the rest. Outputs are CDN URLs, which are downloaded here.
 */
export class WaveSpeedImageProvider implements ImageProvider {
  readonly name = 'wavespeed';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pollMs = 2000,
    private readonly deadlineMs = 120_000,
  ) {}

  private async call(url: string, init: RequestInit, signal: AbortSignal): Promise<Prediction> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, signal });
    } catch (e) {
      throw new ProviderError(`WaveSpeed request failed: ${e instanceof Error ? e.message : String(e)}`, 'wavespeed', true);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = text.replace(/\s+/g, ' ').slice(0, 200);
      // 429/5xx are temporary; 401/403 is a bad key; 402 means the account has run out of credit.
      const transient = res.status === 429 || res.status >= 500;
      const what = res.status === 401 || res.status === 403 ? 'rejected the API key' : res.status === 402 ? 'reports the account is out of credit' : `returned ${res.status}`;
      throw new ProviderError(`WaveSpeed ${what}: ${detail}`, 'wavespeed', transient, res.status);
    }
    try {
      const json = JSON.parse(text) as { data?: Prediction } & Prediction;
      return json.data ?? json;
    } catch {
      throw new ProviderError('WaveSpeed returned a response that is not JSON', 'wavespeed', true);
    }
  }

  async generateImage({ model, prompt, aspectRatio = '16:9', signal }: { model: string; prompt: string; aspectRatio?: string; signal?: AbortSignal }): Promise<ImageResult> {
    const sig = signal ?? AbortSignal.timeout(this.deadlineMs);
    const [width, height] = SIZES[aspectRatio] ?? SIZES['16:9'];
    const text = prompt.replace(/\s+/g, ' ').trim().slice(0, 1500);
    // Google's models on WaveSpeed (Nano Banana) take an aspect ratio and no size or seed; the others take width*height.
    const shape = model.startsWith('google/') ? { aspect_ratio: SIZES[aspectRatio] ? aspectRatio : '16:9' } : { size: `${width}*${height}`, seed: -1 };
    const body = { prompt: text, ...shape, output_format: 'jpeg', enable_sync_mode: true, enable_base64_output: false };
    let p = await this.call(`${API}/${model}`, { method: 'POST', body: JSON.stringify(body) }, sig);
    const started = Date.now();
    while (p.status !== 'completed') {
      if (p.status && FAILED.has(p.status)) throw new ProviderError(`WaveSpeed image ${p.status}: ${(p.error ?? '').slice(0, 200)}`, 'wavespeed', p.status === 'timeout');
      if (!p.id) throw new ProviderError('WaveSpeed returned no task id', 'wavespeed', true);
      if (Date.now() - started > this.deadlineMs) throw new ProviderError('WaveSpeed image was not ready in time', 'wavespeed', true);
      await new Promise((r) => setTimeout(r, this.pollMs));
      p = await this.call(`${API}/predictions/${encodeURIComponent(p.id)}/result`, { method: 'GET' }, sig);
    }
    const out = p.outputs?.find((o): o is string => typeof o === 'string');
    if (!out) throw new ProviderError('WaveSpeed finished without an image', 'wavespeed', true);

    let img: Response;
    try {
      img = await this.fetchImpl(out, { signal: sig });
    } catch (e) {
      throw new ProviderError(`Downloading the WaveSpeed image failed: ${e instanceof Error ? e.message : String(e)}`, 'wavespeed', true);
    }
    const type = img.headers.get('content-type') ?? '';
    if (!img.ok || !type.startsWith('image/')) throw new ProviderError(`Downloading the WaveSpeed image returned ${img.status} ${type}`, 'wavespeed', true);
    const bytes = Buffer.from(await img.arrayBuffer());
    if (bytes.length < 1000) throw new ProviderError('WaveSpeed returned an empty image', 'wavespeed', true);
    return { bytes, mimeType: type.split(';')[0], usage: { provider: 'wavespeed', model, operation: 'generate_image', requests: 1 } };
  }
}
