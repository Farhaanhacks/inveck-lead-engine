import type { ApiKeys, Settings } from '../settings';
import { errorMessage } from './text';

/** Everything a pipeline step needs from the outside world; tests pass fakes. */
export type Services = {
  fetch: typeof fetch;
  keys: ApiKeys;
  settings: Settings;
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(svc: Services, url: string, init: RequestInit = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await svc.fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 300);
      try {
        const j = JSON.parse(body);
        detail = j?.errors?.[0]?.details || j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : detail);
      } catch {}
      throw new HttpError(`${res.status} ${detail}`.trim(), res.status);
    }
    return body;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(svc: Services, url: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  return JSON.parse(await request(svc, url, init, timeoutMs)) as T;
}

export type SerperResult = { title?: string; link?: string; snippet?: string };

/** Google search through Serper. */
export async function googleSearch(svc: Services, q: string): Promise<SerperResult[]> {
  if (!svc.keys.serper) throw new Error('SERPER_API_KEY is not set');
  const data = await getJson<{ organic?: SerperResult[] }>(svc, 'https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': svc.keys.serper, 'content-type': 'application/json' },
    body: JSON.stringify({ q, gl: 'in', num: 10 }),
  });
  return Array.isArray(data.organic) ? data.organic : [];
}

/** A Hunter API call. */
export async function hunter<T = unknown>(svc: Services, path: string, params: Record<string, string>): Promise<T> {
  if (!svc.keys.hunter) throw new Error('HUNTER_API_KEY is not set');
  const url = `https://api.hunter.io/v2/${path}?${new URLSearchParams({ ...params, api_key: svc.keys.hunter })}`;
  const data = await getJson<{ data?: T }>(svc, url);
  return (data.data ?? {}) as T;
}

export type HunterCredits = { searchesLeft: number; verificationsLeft: number; resetDate: string; error: string };

/** What's left on the Hunter plan. The account call itself is free. */
export async function hunterCredits(svc: Services): Promise<HunterCredits> {
  const left = (q: unknown) => {
    const o = (q || {}) as { available?: number; used?: number };
    return Math.max(0, Number(o.available ?? 0) - Number(o.used ?? 0));
  };
  try {
    const d = await hunter<{ requests?: { searches?: unknown; verifications?: unknown }; reset_date?: string }>(svc, 'account', {});
    return { searchesLeft: left(d.requests?.searches), verificationsLeft: left(d.requests?.verifications), resetDate: d.reset_date || '', error: '' };
  } catch (e) {
    return { searchesLeft: 0, verificationsLeft: 0, resetDate: '', error: errorMessage(e) };
  }
}

/** Runs `fn` over `items` with at most `limit` running at once, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
