import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads } from '@/lib/db/schema';
import { settingsSchema } from '@/lib/settings';
import type { EnrichmentCache, Services } from '@/lib/pipeline/services';
import { prospeoBody, prospeoEmail, prospeoPace, PROSPEO_ENRICH_URL, resetProspeo } from '@/lib/pipeline/prospeo';
import { emailLabel, findEmail } from '@/lib/pipeline/emails';
import { EMPTY_CONTACT, type Contact } from '@/lib/pipeline/contacts';
import { dbEnrichmentCache } from '@/lib/enrichment-cache';
import { refreshMainEmail } from '@/lib/email-refresh';

const KEY = 'prospeo-secret-key-456';

type Call = { url: URL; init: RequestInit; body: Record<string, unknown> };
type Seen = { prospeo: Call[]; apollo: URL[]; checks: string[] };

/** Prospeo's enrich-person reply, with the phone numbers its replies can carry (never to be kept). */
function reply(p: { name: string; email?: string; status?: string; company?: string; domain?: string; linkedin?: string; formerOnly?: boolean }) {
  const [first, ...rest] = p.name.split(' ');
  return {
    error: false,
    free_enrichment: false,
    person: {
      person_id: 'x1',
      first_name: first,
      last_name: rest.join(' '),
      full_name: p.name,
      linkedin_url: p.linkedin ?? null,
      current_job_title: 'Plant Head',
      job_history: p.company ? [{ title: 'Plant Head', company_name: p.company, current: !p.formerOnly }] : [],
      mobile: { status: 'VERIFIED', revealed: false, mobile: '+91 98765 4****', mobile_national: '98765 4****' },
      email: p.email ? { status: p.status ?? 'VERIFIED', revealed: true, email: p.email, verification_method: 'BOUNCEBAN', email_mx_provider: 'Google' } : null,
    },
    company: p.formerOnly || !(p.company || p.domain) ? null : { name: p.company ?? '', website: p.domain ? `https://${p.domain}` : '', domain: p.domain ?? '', phone_hq: { phone_hq: '+91 20 5555 0000' } },
  };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

function memoryCache(): EnrichmentCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return { store, get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))) };
}

function services(
  seen: Seen,
  prospeo: (body: Record<string, unknown>) => Response | Promise<Response>,
  opts: { cache?: EnrichmentCache; key?: string; apollo?: () => Response; check?: (email: string) => string } = {},
): Services {
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.prospeo.io') {
      const body = JSON.parse(String(init.body));
      seen.prospeo.push({ url, init, body });
      return prospeo(body);
    }
    if (url.host === 'api.apollo.io') {
      seen.apollo.push(url);
      return opts.apollo ? opts.apollo() : json({ person: null });
    }
    if (url.host === 'api.hunter.io' && url.pathname === '/v2/email-verifier') {
      const email = url.searchParams.get('email') ?? '';
      seen.checks.push(email);
      return json({ data: { status: opts.check?.(email) ?? 'unknown' } });
    }
    if (url.host === 'google.serper.dev') return json({ organic: [] });
    throw new Error('Unexpected request to ' + url.host);
  }) as typeof fetch;
  const svc: Services = {
    fetch: fetchFn,
    keys: { deepseek: '', anthropic: '', serper: 'serper-test', hunter: opts.check ? 'hunter-test' : '', apollo: opts.apollo ? 'apollo-test' : '', prospeo: opts.key ?? KEY, jina: '' },
    settings: settingsSchema.parse({}),
    cache: opts.cache,
  };
  resetProspeo(svc);
  return svc;
}

const amit: Contact = { ...EMPTY_CONTACT, name: 'Amit Kumar', title: 'Plant Head', linkedin: 'https://in.linkedin.com/in/amit-kumar-1' };
const acme = { company: 'Acme Forgings', domain: 'acmeforgings.in', websiteEmails: [] as string[] };
const q = { name: amit.name, company: acme.company, domain: acme.domain, linkedin: amit.linkedin };
const proven = { pattern: '{first}.{last}', domain: 'acmeforgings.in', strong: true, detail: 'first.last, 80% of acmeforgings.in emails' };
const ok = { name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', company: 'Acme Forgings', domain: 'acmeforgings.in', linkedin: 'https://www.linkedin.com/in/amit-kumar-1' };

let seen: Seen;
beforeEach(() => {
  seen = { prospeo: [], apollo: [], checks: [] };
  prospeoPace.gapMs = 0;
});

describe('Prospeo is asked for verified emails only', () => {
  it('never asks for mobile numbers, asks only for verified emails, and keeps no phone number', async () => {
    const cache = memoryCache();
    const svc = services(seen, () => json(reply(ok)), { cache });
    const r = await prospeoEmail(svc, q);
    expect(r).toMatchObject({ outcome: 'found', email: 'a.kumar@acmeforgings.in', status: 'verified' });
    const call = seen.prospeo[0];
    expect(call.url.toString()).toBe(PROSPEO_ENRICH_URL);
    expect(call.body).toMatchObject({ enrich_mobile: false, only_verified_email: true });
    expect(call.body).not.toHaveProperty('only_verified_mobile');
    expect(call.body.data).toMatchObject({ first_name: 'Amit', last_name: 'Kumar', linkedin_url: 'https://www.linkedin.com/in/amit-kumar-1', company_website: 'acmeforgings.in', company_name: 'Acme Forgings' });
    expect(new Headers(call.init.headers).get('x-key')).toBe(KEY);
    // Nothing about phones is stored: not the mobile, not the company's phone.
    const stored = JSON.stringify([...cache.store.values()]);
    expect(stored).not.toMatch(/98765|5555|mobile|phone/i);
    expect(JSON.stringify(r)).not.toMatch(/98765|5555|mobile|phone/i);
  });

  it('is asked before Apollo; a verified Prospeo email is used and Apollo is never asked', async () => {
    const svc = services(seen, () => json(reply(ok)), { apollo: () => json({ person: null }) });
    const r = await findEmail(svc, amit, { ...acme, format: proven, lookups: { left: 3 } });
    expect(r).toMatchObject({ email: 'a.kumar@acmeforgings.in', source: 'prospeo', verification: 'verified', verifiedBy: 'Prospeo', providerStatus: 'verified' });
    expect(seen.apollo).toHaveLength(0);
    expect(emailLabel(r)).toMatch(/^Prospeo \(Prospeo status: verified, retrieved \d{4}-\d{2}-\d{2}\) · verified by Prospeo$/);
  });

  it('"no match" is an answer, not a failure: remembered, and Apollo is asked next', async () => {
    const cache = memoryCache();
    const apolloPerson = { person: { name: 'Amit Kumar', linkedin_url: ok.linkedin, email: 'amit.k@acmeforgings.in', email_status: 'verified', organization: { name: 'Acme Forgings', primary_domain: 'acmeforgings.in' } } };
    const svc = services(seen, () => json({ error: true, error_code: 'NO_MATCH' }, 400), { cache, apollo: () => json(apolloPerson) });
    const r = await findEmail(svc, amit, { ...acme, lookups: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit.k@acmeforgings.in', source: 'apollo', verifiedBy: 'Apollo' });
    expect(r.notes.join('\n')).toContain('Prospeo: nothing for Amit Kumar: Prospeo has no match with a verified email');
    expect(r.notes.join('\n')).not.toMatch(/Prospeo lookup failed/);
    expect(await prospeoEmail(svc, q, { cacheOnly: true })).toMatchObject({ outcome: 'not_found', cached: true });
  });

  it('rejects the same name at another employer, and someone Prospeo has left the company', async () => {
    const elsewhere = services(seen, () => json(reply({ ...ok, company: 'Acme Steel', domain: 'acmesteel.com', email: 'amit.k@acmesteel.com' })));
    expect(await prospeoEmail(elsewhere, q)).toMatchObject({ outcome: 'not_found', reason: expect.stringContaining('another employer') });
    const differentProfile = services(seen, () => json(reply({ ...ok, linkedin: 'https://www.linkedin.com/in/amit-kumar-99' })));
    expect(await prospeoEmail(differentProfile, q)).toMatchObject({ outcome: 'not_found', reason: expect.stringContaining('different LinkedIn profile') });
    const left = services(seen, () => json(reply({ ...ok, formerOnly: true })));
    expect(await prospeoEmail(left, q)).toMatchObject({ outcome: 'not_found' });
    const offDomain = services(seen, () => json(reply({ ...ok, email: 'amit@gmail.com' })));
    expect(await prospeoEmail(offDomain, q)).toMatchObject({ outcome: 'no_email' });
  });

  it('never matches on a name alone: initials only without a profile, or no employer, are not looked up', async () => {
    expect(prospeoBody({ name: 'A. Kumar', company: 'Acme Forgings', domain: 'acmeforgings.in' })).toHaveProperty('skip');
    expect(prospeoBody({ name: 'Amit Kumar', company: '', domain: '' })).toHaveProperty('skip');
    const svc = services(seen, () => json(reply(ok)));
    expect(await prospeoEmail(svc, { name: 'A. Kumar', company: 'Acme Forgings', domain: 'acmeforgings.in' })).toMatchObject({ outcome: 'skipped' });
    expect(seen.prospeo).toHaveLength(0);
  });
});

describe('Prospeo failures and limits', () => {
  it('used-up credits and a refused key stop Prospeo for the run, without spending the budget again', async () => {
    const credits = services(seen, () => json({ error: true, error_code: 'INSUFFICIENT_CREDITS' }, 400));
    expect(await prospeoEmail(credits, q)).toMatchObject({ outcome: 'failed', kind: 'credits' });
    const budget = { left: 3 };
    const r = await findEmail(credits, { ...EMPTY_CONTACT, name: 'Neha Rao' }, { ...acme, lookups: budget });
    expect(seen.prospeo).toHaveLength(1);
    expect(budget.left).toBe(3);
    expect(r.notes.join('\n')).toContain('Prospeo lookup failed for Neha Rao: Prospeo credits are used up (INSUFFICIENT_CREDITS) (not asked again this run)');

    const badKey = services(seen, () => json({ error: true, error_code: 'INVALID_API_KEY' }, 401));
    expect(await prospeoEmail(badKey, q)).toMatchObject({ outcome: 'failed', kind: 'auth' });
  });

  it('waits and tries once more when rate limited, then holds off', async () => {
    let n = 0;
    const once = services(seen, () => (n++ === 0 ? json({ error: true, error_code: 'RATE_LIMITED' }, 429, { 'retry-after': '1' }) : json(reply(ok))));
    expect(await prospeoEmail(once, q)).toMatchObject({ outcome: 'found' });
    expect(seen.prospeo).toHaveLength(2);

    const always = services(seen, () => json({ error: true, error_code: 'RATE_LIMITED' }, 429, { 'retry-after': '1' }));
    expect(await prospeoEmail(always, q)).toMatchObject({ outcome: 'failed', kind: 'rate_limit' });
  });

  it('spaces requests out to stay under the per-second limit', async () => {
    prospeoPace.gapMs = 300;
    const svc = services(seen, () => json({ error: true, error_code: 'NO_MATCH' }, 400));
    const start = Date.now();
    await Promise.all([prospeoEmail(svc, q), prospeoEmail(svc, { ...q, name: 'Neha Rao', linkedin: '' }), prospeoEmail(svc, { ...q, name: 'Ravi Shah', linkedin: '' })]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(550);
  });

  it('a server error or an unreachable API is a failed lookup, not "not found", is not cached, and never shows the key', async () => {
    const cache = memoryCache();
    const down = services(seen, () => json({ error: true, error_code: 'INTERNAL_ERROR' }, 500), { cache });
    expect(await prospeoEmail(down, q)).toMatchObject({ outcome: 'failed', kind: 'unavailable' });
    expect(cache.store.size).toBe(0);
    const unreachable = services(seen, () => {
      throw new Error(`connect failed with key ${KEY}`);
    });
    const r = await prospeoEmail(unreachable, q);
    expect(r).toMatchObject({ outcome: 'failed', kind: 'unavailable' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('no key: Prospeo is not asked and the chain goes on without it', async () => {
    const svc = services(seen, () => json(reply(ok)), { key: '' });
    const r = await findEmail(svc, amit, { ...acme, format: proven, lookups: { left: 3 } });
    expect(seen.prospeo).toHaveLength(0);
    expect(r.source).toBe('inferred');
  });
});

describe('refreshing with Prospeo', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  it('upgrades an inferred address to Prospeo\'s verified one and keeps a team address', async () => {
    const base = { company: 'Acme Forgings', website: 'acmeforgings.in', contactName: 'Amit Kumar', contactLinkedin: amit.linkedin, status: 'Awaiting Approval' as const };
    const svc = services(seen, () => json(reply(ok)), { cache: dbEnrichmentCache(db) });
    const [lead] = await db.insert(leads).values({ ...base, contactEmail: 'amit.kumar@acmeforgings.in', emailSource: 'inferred', emailVerification: 'catch_all' }).returning();
    expect(await refreshMainEmail(db, svc, lead, { left: 3 })).toBe('upgraded');
    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after).toMatchObject({ contactEmail: 'a.kumar@acmeforgings.in', emailSource: 'prospeo', emailVerification: 'verified', emailProviderStatus: 'verified' });
    const log = (await db.select().from(activities).where(eq(activities.leadId, lead.id))).map((a) => a.text);
    expect(log).toContain('Email upgraded for Amit Kumar: amit.kumar@acmeforgings.in (inferred) → a.kumar@acmeforgings.in (Prospeo, verified by Prospeo)');

    const [team] = await db.insert(leads).values({ ...base, contactEmail: 'amit@acmeforgings.in', emailSource: 'manual' }).returning();
    expect(await refreshMainEmail(db, svc, team, { left: 3 })).toBe('conflict');
    expect((await db.select().from(leads).where(eq(leads.id, team.id)))[0].contactEmail).toBe('amit@acmeforgings.in');
  });
});
