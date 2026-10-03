import type { Services } from './services';
import { sameName } from './contacts';
import { sameFirm } from './employer';
import { errorMessage, normCompany, rootDomain, splitName } from './text';

/**
 * Apollo email enrichment for a contact the pipeline has already identified (People Enrichment,
 * POST /api/v1/people/match). EMAILS ONLY: every request switches off phone numbers, personal
 * emails and the paid waterfall lookups, nothing about phones is read from a reply, and nothing but
 * the work email and its status is kept. A person is accepted only when the reply is the same person
 * (name, and LinkedIn profile when both sides have one) at the same employer (domain, or the company's
 * name in full); never on a name alone. Results are cached so a person isn't paid for twice; failed
 * lookups are not cached, and a failure never throws.
 */

export const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match';

/** Sent with every request. Apollo's defaults are already false; they are sent anyway, explicitly. */
export const APOLLO_EMAIL_ONLY = {
  reveal_phone_number: 'false',
  reveal_personal_emails: 'false',
  run_waterfall_phone: 'false',
  run_waterfall_email: 'false',
} as const;

export type ApolloQuery = {
  /** The contact's name as identified (LinkedIn, the team). */
  name: string;
  /** Their employer as the lead has it, and its website. */
  company: string;
  domain: string;
  /** Their LinkedIn profile, when known. */
  linkedin?: string;
};

/** What a lookup came to. `not_found` and `no_email` are answers; `failed` means the lookup itself didn't work. */
export type ApolloResult =
  | { outcome: 'found'; email: string; status: string; retrievedAt: string; cached: boolean }
  | { outcome: 'no_email' | 'not_found'; reason: string; retrievedAt: string; cached: boolean }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; kind: 'no_key' | 'auth' | 'credits' | 'rate_limit' | 'unavailable' | 'error'; reason: string; held?: boolean };

/** Every email provider (Apollo, Prospeo) answers in the same shape. */
export type PersonQuery = ApolloQuery;
export type ProviderResult = ApolloResult;

const FOUND_TTL_DAYS = 90;
const MISS_TTL_DAYS = 30;
export const TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

/** The profile's handle: "https://in.linkedin.com/in/sdigge/?x" gives "sdigge"; '' for anything else. */
export function linkedinHandle(url: string | null | undefined): string {
  const m = String(url ?? '').toLowerCase().match(/linkedin\.com\/in\/([^/?#\s]+)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, '');
  } catch {
    return m[1];
  }
}

/**
 * The request's query string, or why no request should be made: a name too incomplete to match
 * safely without a LinkedIn profile (initials only), or no employer to check the match against.
 */
export function apolloParams(q: ApolloQuery): URLSearchParams | { skip: string } {
  const { first, last } = splitName(q.name);
  const handle = linkedinHandle(q.linkedin);
  if ((first.length < 2 || last.length < 2) && !handle) return { skip: 'name too incomplete to match safely without a LinkedIn profile' };
  const domain = rootDomain(q.domain);
  const company = q.company.trim();
  if (!domain && !company) return { skip: 'no employer to match against' };
  const params = new URLSearchParams();
  if (first) params.set('first_name', first);
  if (last) params.set('last_name', last);
  params.set('name', q.name.replace(/\(.*?\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim());
  if (handle) params.set('linkedin_url', `https://www.linkedin.com/in/${handle}`);
  if (domain) params.set('domain', domain);
  if (company) params.set('organization_name', company);
  for (const [k, v] of Object.entries(APOLLO_EMAIL_ONLY)) params.set(k, v);
  return params;
}

/** The few facts read from a provider's reply. Phone numbers and everything else are never read. */
export type PersonFacts = {
  name: string;
  linkedin: string;
  email: string;
  emailStatus: string;
  orgName: string;
  orgDomain: string;
  confidence: string;
};

function readPerson(body: unknown): PersonFacts | null {
  const p = (body as { person?: unknown } | null)?.person;
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const org = (o.organization && typeof o.organization === 'object' ? o.organization : {}) as Record<string, unknown>;
  return {
    name: str(o.name) || [str(o.first_name), str(o.last_name)].filter(Boolean).join(' '),
    linkedin: str(o.linkedin_url),
    email: str(o.email).toLowerCase(),
    emailStatus: str(o.email_status).toLowerCase(),
    orgName: str(org.name) || str(o.organization_name),
    orgDomain: rootDomain(str(org.primary_domain) || str(org.website_url)),
    confidence: str(o.match_confidence ?? (body as Record<string, unknown>).match_confidence).toLowerCase(),
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;
/** A stand-in for an email not unlocked ("email_not_unlocked@domain.com") or masked ("a***@x.com"). */
const PLACEHOLDER = /not_unlocked|email_not|^n\/a$|@domain\.com$|\*/;

/**
 * Whether a provider's person is ours, and their usable work email. Rejected: another LinkedIn
 * profile, another name, another employer (or none given), a low-confidence match, and an address
 * that isn't on the company's domain. The same rules for every provider (Apollo, Prospeo).
 */
export function judgeMatch(provider: string, q: ApolloQuery, person: PersonFacts | null): { email: string; status: string } | { outcome: 'not_found' | 'no_email'; reason: string } {
  if (!person) return { outcome: 'not_found', reason: `${provider} has no matching person` };
  const ours = linkedinHandle(q.linkedin);
  const theirs = linkedinHandle(person.linkedin);
  if (ours && theirs && ours !== theirs) return { outcome: 'not_found', reason: `${provider} matched a different LinkedIn profile (${theirs})` };
  if (!person.name || !sameName(person.name, q.name)) return { outcome: 'not_found', reason: `${provider} matched a different person (${person.name || 'no name'})` };
  if (/^(none|low)$/.test(person.confidence)) return { outcome: 'not_found', reason: `${provider}'s match is ambiguous (confidence: ${person.confidence})` };
  const domain = rootDomain(q.domain);
  const sameEmployer = domain && person.orgDomain ? person.orgDomain === domain : !!person.orgName && sameFirm(person.orgName, q.company);
  if (!sameEmployer) {
    return {
      outcome: 'not_found',
      reason: person.orgName || person.orgDomain ? `${provider} has them at another employer (${person.orgName || person.orgDomain})` : `${provider} doesn't say where they work now`,
    };
  }
  if (!person.email || !EMAIL_RE.test(person.email) || PLACEHOLDER.test(person.email) || person.emailStatus === 'unavailable') {
    return { outcome: 'no_email', reason: `${provider} has no work email for them` };
  }
  const onDomain = rootDomain(person.email.split('@')[1]);
  const allowed = [domain, person.orgDomain].filter(Boolean);
  if (!allowed.includes(onDomain)) return { outcome: 'no_email', reason: `${provider}'s address is not on the company's domain (${onDomain})` };
  return { email: person.email, status: person.emailStatus || 'unknown' };
}

export const judgeApolloPerson = (q: ApolloQuery, person: PersonFacts | null) => judgeMatch('Apollo', q, person);

/** The cache key for a person: their LinkedIn handle, else their name at the company's domain. */
export function apolloCacheKey(q: ApolloQuery): string {
  const handle = linkedinHandle(q.linkedin);
  if (handle) return `apollo:v1:in:${handle}`;
  const { first, last } = splitName(q.name);
  return `apollo:v1:name:${`${first} ${last}`.toLowerCase().replace(/[^a-z ]/g, '').trim()}@${rootDomain(q.domain) || normCompany(q.company)}`;
}

export type Cached = Exclude<ApolloResult, { outcome: 'skipped' | 'failed' }>;

export function freshCached(value: unknown, now: number): Cached | null {
  const v = value as Cached | null;
  if (!v || !['found', 'no_email', 'not_found'].includes(v.outcome) || !v.retrievedAt) return null;
  const age = now - new Date(v.retrievedAt).getTime();
  return age >= 0 && age < (v.outcome === 'found' ? FOUND_TTL_DAYS : MISS_TTL_DAYS) * DAY_MS ? { ...v, cached: true } : null;
}

/** Per run: Apollo stops being asked after a refused key, exhausted credits or a long rate limit. */
const holds = new WeakMap<Services, { until: number; kind: Extract<ApolloResult, { outcome: 'failed' }>['kind']; reason: string }>();

export const redact = (text: string, key: string) => (key ? text.split(key).join('[key]') : text);

/**
 * Apollo's work email for an identified contact, from the cache when it's there. `cacheOnly` reads
 * the cache without spending anything (`skipped` when nothing is cached).
 */
export async function apolloEmail(svc: Services, q: ApolloQuery, opts: { cacheOnly?: boolean } = {}): Promise<ApolloResult> {
  const params = apolloParams(q);
  if (!(params instanceof URLSearchParams)) return { outcome: 'skipped', reason: params.skip };
  const key = apolloCacheKey(q);
  const now = Date.now();
  try {
    const hit = freshCached(await svc.cache?.get(key), now);
    if (hit) return hit;
  } catch {
    // A cache that can't be read only means the lookup is made again.
  }
  if (opts.cacheOnly) return { outcome: 'skipped', reason: 'no cached Apollo result' };
  const apiKey = svc.keys.apollo;
  if (!apiKey) return { outcome: 'failed', kind: 'no_key', reason: 'APOLLO_API_KEY is not set' };
  const hold = holds.get(svc);
  if (hold && hold.until > now) return { outcome: 'failed', kind: hold.kind, reason: `${hold.reason} (not asked again this run)`, held: true };

  for (let attempt = 0; attempt < 2; attempt++) {
    let status = 0;
    let body: unknown = null;
    let text = '';
    let retryAfter = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await svc.fetch(`${APOLLO_MATCH_URL}?${params}`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'cache-control': 'no-cache', accept: 'application/json' },
        signal: controller.signal,
      });
      status = res.status;
      retryAfter = Number(res.headers.get('retry-after')) || 0;
      text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {}
    } catch (e) {
      const reason = (e as Error)?.name === 'AbortError' ? `Apollo didn't answer within ${TIMEOUT_MS / 1000}s` : `Apollo couldn't be reached: ${errorMessage(e)}`;
      return { outcome: 'failed', kind: 'unavailable', reason: redact(reason, apiKey) };
    } finally {
      clearTimeout(timer);
    }

    if (status === 200) {
      const judged = judgeMatch('Apollo', q, readPerson(body));
      const retrievedAt = new Date().toISOString();
      const result: Cached = 'email' in judged ? { outcome: 'found', email: judged.email, status: judged.status, retrievedAt, cached: false } : { ...judged, retrievedAt, cached: false };
      try {
        // Only these fields are stored: never a phone number or the rest of Apollo's reply.
        await svc.cache?.set(key, { ...result, cached: undefined });
      } catch {}
      return result;
    }

    const said = redact(String((body as { error?: unknown; message?: unknown } | null)?.error ?? (body as { message?: unknown } | null)?.message ?? text).replace(/\s+/g, ' ').slice(0, 160), apiKey);
    const block = (kind: 'auth' | 'credits' | 'rate_limit', reason: string, ms = 24 * 3600_000) => {
      holds.set(svc, { until: now + ms, kind, reason });
      return { outcome: 'failed' as const, kind, reason };
    };
    if (status === 402 || (/credit/i.test(said) && [403, 422, 429].includes(status))) return block('credits', `Apollo credits are used up (${status})`);
    if (status === 429) {
      // A short wait is worth it once; a long one means stop asking for a while.
      if (attempt === 0 && retryAfter > 0 && retryAfter <= 5) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      return block('rate_limit', `Apollo rate limit reached (429)${retryAfter ? `; resets in ${retryAfter}s` : ''}`, (retryAfter || 60) * 1000);
    }
    if (status === 401) return block('auth', 'Apollo rejected the API key (401)');
    if (status === 403) return block('auth', "Apollo refused: the plan or key doesn't allow People Enrichment (403)");
    if (status === 422) return { outcome: 'failed', kind: 'error', reason: `Apollo couldn't process the request (422)${said ? `: ${said}` : ''}` };
    return { outcome: 'failed', kind: status >= 500 ? 'unavailable' : 'error', reason: `Apollo error ${status}${said ? `: ${said}` : ''}` };
  }
  return { outcome: 'failed', kind: 'rate_limit', reason: 'Apollo rate limit reached (429)' };
}

/** Tests only: forget the per-run holds. */
export function resetApolloHolds(svc: Services) {
  holds.delete(svc);
}
