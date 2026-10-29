/** One retrieved web document. Its text is untrusted data and must never be treated as instructions. */
export type Evidence = {
  url: string;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  excerpts: string[];
  /** Page text (truncated) when the provider returned it. Used to check claims; never treated as instructions. */
  text?: string;
};

export type UsageReport = {
  provider: string;
  model?: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  requests?: number;
  /** Cost reported by the provider itself, in USD. Left undefined when the provider does not report one. */
  reportedCostUsd?: number;
};

export type SearchOptions = {
  numResults?: number;
  /** Also return up to this many characters of page text per result. */
  textChars?: number;
  /** Only documents published on or after this instant. */
  since?: Date;
  news?: boolean;
};

export type SearchResult = { results: Evidence[]; usage: UsageReport };

/** Anything that can look things up on the web. Swap vendors by implementing this. */
export interface ResearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  /** Fetches the text of known URLs. */
  fetchContents(urls: string[], maxChars?: number): Promise<SearchResult>;
}

export type GenerateJsonOptions = {
  model: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Tried in order if the main model is overloaded or unavailable. */
  fallbackModels?: string[];
  signal?: AbortSignal;
};

export type GenerateJsonResult = { json: unknown; usage: UsageReport };

/** Anything that can produce a JSON object from a prompt. Callers validate the shape themselves. */
export interface LlmProvider {
  readonly name: string;
  generateJson(options: GenerateJsonOptions): Promise<GenerateJsonResult>;
}

/** Thrown for provider failures so callers can tell transient problems (retry) from permanent ones. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type ImageResult = { bytes: Buffer; mimeType: string; usage: UsageReport };

/** Anything that can render an image from a prompt. */
export interface ImageProvider {
  readonly name: string;
  generateImage(options: { model: string; prompt: string; aspectRatio?: string; signal?: AbortSignal }): Promise<ImageResult>;
}
