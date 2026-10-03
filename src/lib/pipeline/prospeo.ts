import type { Services } from './services';
import { freshCached, judgeMatch, linkedinHandle, redact, TIMEOUT_MS, type Cached, type PersonFacts, type PersonQuery, type ProviderResult } from './apollo';
import { errorMessage, normCompany, rootDomain, splitName } from './text';

/**
 * Prospeo email lookup for a contact the pipeline has already identified (POST /enrich-person),
 * asked before Apollo. EMAILS ONLY: every request switches mobile numbers off (`enrich_mobile:
 * false`), nothing about phones (the person's mobile, the company's phone) is read from a reply, and
 * only the work email and its status are kept. Only verified emails are asked for, so credits aren't
 * spent on addresses that can't be confirmed (Prospeo charges only when it finds one). A person is
 * accepted on the same rules as Apollo's: same person, same employer, never a name alone. "No match"
 * is an answer and is cached; a failed lookup is not, and nothing here throws. Requests are spaced
 * out to keep under Prospeo's per-second limit.
 */

export const PROSPEO_ENRICH_URL = 'https://api.prospeo.io/enrich-person';

/** Sent with every request: no mobile numbers, verified emails only. */
export const PROSPEO_EMAIL_ONLY = { only_verified_email: true, enrich_mobile: false } as const;

/** The gap between two requests (Prospeo's free plan allows one a second). Tests set it to 0. */
export const prospeoPace = { gapMs: 1100 };
let nextSlot = 0;

/** Waits for this request's turn. The slot is taken before waiting, so concurrent calls queue up. */
async function waitTurn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + prospeoPace.gapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** The request body, or why no request should be made (the same rules as Apollo's). */
export function prospeoBody(q: PersonQuery): { only_verified_email: true; enrich_mobile: false; data: Record<string, string> } | { skip: string } {
  const { first, last } = splitName(q.name);
  const handle = linkedinHandle(q.linkedin);
  if ((first.length < 2 || last.length < 2) && !handle) return { skip: 'name too incomplete to match safely without a LinkedIn profile' };
  const domain = rootDomain(q.domain);
  const company = q.company.trim();
  if (!domain && !company) return { skip: 'no employer to match against' };
  const data: Record<string, string> = {};
  if (first) data.first_name = first;
  if (last) data.last_name = last;
  data.full_name = q.name.replace(/\(.*?\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim();
  if (handle) data.linkedin_url = `https://www.linkedin.com/in/${handle}`;
  if (domain) data.company_website = domain;
  if (company) data.company_name = company;
  return { ...PROSPEO_EMAIL_ONLY, data };
}

/** The few facts read from Prospeo's reply. `person.mobile` and `company.phone_hq` are never read. */
export function readProspeoPerson(body: unknown): PersonFacts | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const p = b.person;
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const company = obj(b.company);
  const email = obj(o.email);
  const current = Array.isArray(o.job_history) ? o.job_history.map(obj).find((j) => j.current === true) : undefined;
  return {
    name: str(o.full_name) || [str(o.first_name), str(o.last_name)].filter(Boolean).join(' '),
    linkedin: str(o.linkedin_url),
    email: email.revealed === false ? '' : str(email.email).toLowerCase(),
    emailStatus: str(email.status).toLowerCase(),
    orgName: str(company.name) || str(current?.company_name),
    orgDomain: rootDomain(str(company.domain) || str(company.website)),
    confidence: '',
  };
}

export function prospeoCacheKey(q: PersonQuery): string {
  const handle = linkedinHandle(q.linkedin);
  if (handle) return `prospeo:v1:in:${handle}`;
  const { first, last } = splitName(q.name);
  return `prospeo:v1:name:${`${first} ${last}`.toLowerCase().replace(/[^a-z ]/g, '').trim()}@${rootDomain(q.domain) || normCompany(q.company)}`;
}

/** Per run: Prospeo stops being asked after a refused key, used-up credits or a long rate limit. */
const holds = new WeakMap<Services, { until: number; kind: Extract<ProviderResult, { outcome: 'failed' }>['kind']; reason: string }>();

/**
 * Prospeo's verified work email for an identified contact, from the cache when it's there.
 * `cacheOnly` reads the cache without spending anything (`skipped` when nothing is cached).
 */
export async function prospeoEmail(svc: Services, q: PersonQuery, opts: { cacheOnly?: boolean } = {}): Promise<ProviderResult> {
  const body = prospeoBody(q);
  if ('skip' in body) return { outcome: 'skipped', reason: body.skip };
  const key = prospeoCacheKey(q);
  const now = Date.now();
  try {
    const hit = freshCached(await svc.cache?.get(key), now);
    if (hit) return hit;
  } catch {
    // A cache that can't be read only means the lookup is made again.
  }
  if (opts.cacheOnly) return { outcome: 'skipped', reason: 'no cached Prospeo result' };
  const apiKey = svc.keys.prospeo;
  if (!apiKey) return { outcome: 'failed', kind: 'no_key', reason: 'PROSPEO_API_KEY is not set' };
  const hold = holds.get(svc);
  if (hold && hold.until > now) return { outcome: 'failed', kind: hold.kind, reason: `${hold.reason} (not asked again this run)`, held: true };

  const remember = async (result: Cached) => {
    try {
      // Only these fields are stored: never a phone number or the rest of Prospeo's reply.
      await svc.cache?.set(key, { ...result, cached: undefined });
    } catch {}
    return result;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let status = 0;
    let reply: Record<string, unknown> = {};
    let text = '';
    let retryAfter = 0;
    await waitTurn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await svc.fetch(PROSPEO_ENRICH_URL, {
        method: 'POST',
        headers: { 'x-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = res.status;
      retryAfter = Number(res.headers.get('retry-after')) || 0;
      text = await res.text();
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') reply = parsed;
      } catch {}
    } catch (e) {
      const reason = (e as Error)?.name === 'AbortError' ? `Prospeo didn't answer within ${TIMEOUT_MS / 1000}s` : `Prospeo couldn't be reached: ${errorMessage(e)}`;
      return { outcome: 'failed', kind: 'unavailable', reason: redact(reason, apiKey) };
    } finally {
      clearTimeout(timer);
    }

    const code = String(reply.error_code ?? '').toUpperCase();
    const retrievedAt = new Date().toISOString();
    if (status === 200 && reply.error !== true) {
      const judged = judgeMatch('Prospeo', q, readProspeoPerson(reply));
      return remember('email' in judged ? { outcome: 'found', email: judged.email, status: judged.status, retrievedAt, cached: false } : { ...judged, retrievedAt, cached: false });
    }
    // No such person, or no verified email for them: an answer, not a failure (and not charged).
    if (code === 'NO_MATCH') return remember({ outcome: 'not_found', reason: 'Prospeo has no match with a verified email', retrievedAt, cached: false });

    const said = redact(String(reply.message ?? reply.error_code ?? text).replace(/\s+/g, ' ').slice(0, 160), apiKey);
    const block = (kind: 'auth' | 'credits' | 'rate_limit', reason: string, ms = 24 * 3600_000) => {
      holds.set(svc, { until: now + ms, kind, reason });
      return { outcome: 'failed' as const, kind, reason };
    };
    if (code === 'INSUFFICIENT_CREDITS' || status === 402) return block('credits', `Prospeo credits are used up (${code || status})`);
    if (code === 'RATE_LIMITED' || status === 429) {
      // One more try after a short wait; a long wait means stop asking for a while.
      const wait = retryAfter || 2;
      if (attempt === 0 && wait <= 5) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      return block('rate_limit', `Prospeo rate limit reached${retryAfter ? `; resets in ${retryAfter}s` : ''}`, wait * 1000);
    }
    if (code === 'INVALID_API_KEY' || status === 401) return block('auth', `Prospeo rejected the API key (${code || status})`);
    if (status === 403) return block('auth', `Prospeo refused the request (403)${said ? `: ${said}` : ''}`);
    if (code === 'INVALID_DATAPOINTS') return { outcome: 'skipped', reason: "Prospeo needs more details than we have to look them up" };
    return { outcome: 'failed', kind: status >= 500 ? 'unavailable' : 'error', reason: `Prospeo error ${status}${said ? `: ${said}` : ''}` };
  }
  return { outcome: 'failed', kind: 'rate_limit', reason: 'Prospeo rate limit reached' };
}

/** Tests only: forget the per-run holds and the request spacing. */
export function resetProspeo(svc: Services) {
  holds.delete(svc);
  nextSlot = 0;
}
