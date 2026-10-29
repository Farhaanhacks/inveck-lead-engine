import 'server-only';
import { jsonrepair } from 'jsonrepair';
import { ProviderError, type GenerateJsonOptions, type GenerateJsonResult, type ImageProvider, type ImageResult, type LlmProvider } from './types';

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

/** Strips a ```json fence if the model added one, then parses. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch (first) {
    // Models occasionally emit a stray quote, raw newline or trailing comma inside long strings; repair those slips.
    const start = trimmed.indexOf('{');
    if (start < 0) throw first;
    return JSON.parse(jsonrepair(trimmed.slice(start)));
  }
}

/** Errors worth trying another model for: overload, rate limit or quota, server errors, and a model that is no longer offered. */
const movesOn = (e: ProviderError) => e.status === 503 || e.status === 500 || e.status === 502 || e.status === 504 || e.status === 429 || e.status === 404;

type ImageResponse = {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

export class GeminiProvider implements LlmProvider, ImageProvider {
  readonly name = 'gemini';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Google's models sometimes answer 503 "high demand" for a minute or two. A short pause and one retry usually clears it; if not,
   * the next model in `fallbackModels` is tried. Only overload and "model unavailable" answers move on; real errors surface at once.
   */
  async generateJson(options: GenerateJsonOptions): Promise<GenerateJsonResult> {
    const models = [options.model, ...(options.fallbackModels ?? [])];
    let last: ProviderError | undefined;
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.generateJsonOnce({ ...options, model });
        } catch (e) {
          if (!(e instanceof ProviderError) || !movesOn(e)) throw e;
          last = e;
          if (attempt === 0 && e.status === 503) await this.sleep(2500);
          else break;
        }
      }
    }
    throw last!;
  }

  private async generateJsonOnce({ model, system, prompt, temperature = 0.4, maxOutputTokens, signal }: GenerateJsonOptions): Promise<GenerateJsonResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // Low thinking: these are writing and checking tasks, and long hidden reasoning made calls slow enough to time out.
          generationConfig: { responseMimeType: 'application/json', temperature, thinkingConfig: { thinkingLevel: 'low' }, ...(maxOutputTokens ? { maxOutputTokens } : {}) },
        }),
        signal: signal ?? AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ProviderError(`Gemini request failed: ${e instanceof Error ? e.message : String(e)}`, 'gemini', true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 240);
      // 429 can be a rate limit (transient) or an exhausted quota; either way retrying immediately will not help, so callers back off.
      throw new ProviderError(`Gemini returned ${res.status}: ${detail}`, 'gemini', res.status === 429 || res.status >= 500, res.status);
    }
    const data = (await res.json()) as GeminiResponse;
    if (data.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, 'gemini', false);
    const text = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new ProviderError(`Gemini returned no text (finish reason: ${data.candidates?.[0]?.finishReason ?? 'unknown'})`, 'gemini', true);
    let json: unknown;
    try {
      json = parseJsonText(text);
    } catch {
      const reason = data.candidates?.[0]?.finishReason ?? 'unknown';
      throw new ProviderError(`Gemini returned text that is not valid JSON (finish reason: ${reason}, ${text.length} characters, ends with "${text.slice(-40).replace(/\s+/g, ' ')}")`, 'gemini', true);
    }
    const u = data.usageMetadata;
    return {
      json,
      usage: {
        provider: 'gemini',
        model,
        operation: 'generate_json',
        requests: 1,
        inputTokens: u?.promptTokenCount,
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) || undefined,
      },
    };
  }

  async generateImage({ model, prompt, aspectRatio = '16:9', signal }: { model: string; prompt: string; aspectRatio?: string; signal?: AbortSignal }): Promise<ImageResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
        }),
        signal: signal ?? AbortSignal.timeout(150_000),
      });
    } catch (e) {
      throw new ProviderError(`Gemini image request failed: ${e instanceof Error ? e.message : String(e)}`, 'gemini', true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 240);
      throw new ProviderError(`Gemini image returned ${res.status}: ${detail}`, 'gemini', res.status === 429 || res.status >= 500, res.status);
    }
    const data = (await res.json()) as ImageResponse;
    if (data.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the image prompt: ${data.promptFeedback.blockReason}`, 'gemini', false);
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
    const inline = part?.inlineData ?? (part?.inline_data ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data } : undefined);
    if (!inline?.data) throw new ProviderError(`Gemini returned no image (finish reason: ${data.candidates?.[0]?.finishReason ?? 'unknown'})`, 'gemini', true);
    return {
      bytes: Buffer.from(inline.data, 'base64'),
      mimeType: inline.mimeType ?? 'image/png',
      usage: { provider: 'gemini', model, operation: 'generate_image', requests: 1, inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount },
    };
  }
}
