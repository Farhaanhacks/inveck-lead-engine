import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, people } from '@/lib/db/schema';
import { settingsSchema, type Settings } from '@/lib/settings';
import type { EnrichmentCache, Services } from '@/lib/pipeline/services';
import { apolloEmail, apolloParams, APOLLO_MATCH_URL, judgeApolloPerson } from '@/lib/pipeline/apollo';
import { emailLabel, findEmail, type ApolloBudget } from '@/lib/pipeline/emails';
import { EMPTY_CONTACT, type Contact } from '@/lib/pipeline/contacts';
import { dbEnrichmentCache } from '@/lib/enrichment-cache';
import { emailKind, refreshMainEmail } from '@/lib/email-refresh';

const KEY = 'apollo-secret-key-123';

type Seen = { apollo: { url: URL; init: RequestInit }[]; checks: string[]; google: string[] };

/** Apollo's reply for a person, with the phone numbers its replies can carry (never to be kept). */
function person(p: { name: string; email?: string; status?: string; org?: string; domain?: string; linkedin?: string; confidence?: string }) {
  const [first, ...rest] = p.name.split(' ');
  return {
    person: {
      id: 'p1',
      first_name: first,
      last_name: rest.join(' '),
      name: p.name,
      linkedin_url: p.linkedin ?? null,
      email: p.email ?? null,
      email_status: p.status ?? null,
      ...(p.confidence ? { match_confidence: p.confidence } : {}),
      phone_numbers: [{ raw_number: '+91 98765 43210', sanitized_number: '+919876543210', type: 'mobile' }],
      mobile_phone: '+919876543210',
      organization: p.org || p.domain ? { name: p.org ?? '', primary_domain: p.domain ?? '', phone: '+91 20 5555 0000', primary_phone: { number: '+91 20 5555 0000' } } : null,
    },
  };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

function memoryCache(): EnrichmentCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return { store, get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))) };
}

function services(
  seen: Seen,
  apollo: (url: URL) => Response | Promise<Response>,
  opts: { check?: (email: string) => string; cache?: EnrichmentCache; key?: string; settings?: Partial<Settings> } = {},
): Services {
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.apollo.io') {
      seen.apollo.push({ url, init });
      return apollo(url);
    }
    if (url.host === 'api.hunter.io' && url.pathname === '/v2/email-verifier') {
      const email = url.searchParams.get('email') ?? '';
      seen.checks.push(email);
      return json({ data: { status: opts.check?.(email) ?? 'unknown' } });
    }
    if (url.host === 'google.serper.dev') {
      seen.google.push(JSON.parse(String(init.body)).q);
      return json({ organic: [] });
    }
    throw new Error('Unexpected request to ' + url.host);
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    keys: { deepseek: '', anthropic: '', serper: 'serper-test', hunter: opts.check ? 'hunter-test' : '', apollo: opts.key ?? KEY, jina: '' },
    settings: settingsSchema.parse(opts.settings ?? {}),
    cache: opts.cache,
  };
}

const amit: Contact = { ...EMPTY_CONTACT, name: 'Amit Kumar', title: 'Plant Head', linkedin: 'https://in.linkedin.com/in/amit-kumar-1' };
const acme = { company: 'Acme Forgings', domain: 'acmeforgings.in', websiteEmails: [] as string[] };
/** The company's proven format, as found from published data: amit.kumar@acmeforgings.in. */
const proven = { pattern: '{first}.{last}', domain: 'acmeforgings.in', strong: true, detail: 'first.last, 80% of acmeforgings.in emails' };

let seen: Seen;
beforeEach(() => {
  seen = { apollo: [], checks: [], google: [] };
});

describe('Apollo is asked for emails only', () => {
  it('switches off phone numbers, personal emails and waterfalls on every request, and never sends a webhook', async () => {
    const params = apolloParams({ name: 'Amit Kumar', company: 'Acme Forgings', domain: 'acmeforgings.in', linkedin: amit.linkedin });
    expect(params).toBeInstanceOf(URLSearchParams);
    const p = params as URLSearchParams;
    expect(p.get('reveal_phone_number')).toBe('false');
    expect(p.get('run_waterfall_phone')).toBe('false');
    expect(p.get('reveal_personal_emails')).toBe('false');
    expect(p.get('run_waterfall_email')).toBe('false');
    expect(p.has('webhook_url')).toBe(false);

    const cache = memoryCache();
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'amit.k@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in', linkedin: amit.linkedin })), { cache });
    const r = await apolloEmail(svc, { name: amit.name, company: acme.company, domain: acme.domain, linkedin: amit.linkedin });
    expect(r).toMatchObject({ outcome: 'found', email: 'amit.k@acmeforgings.in', status: 'verified' });
    const [{ url, init }] = seen.apollo;
    expect(`${url.origin}${url.pathname}`).toBe(APOLLO_MATCH_URL);
    expect(init.method).toBe('POST');
    expect(url.searchParams.get('reveal_phone_number')).toBe('false');
    expect(url.searchParams.get('run_waterfall_phone')).toBe('false');
    expect([...url.searchParams.values()].some((v) => v === 'true')).toBe(false);
    // The key goes in a header, never in the address.
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(url.toString()).not.toContain(KEY);
    // The phone numbers in Apollo's reply are neither returned nor cached.
    expect(JSON.stringify(r)).not.toMatch(/phone|98765|5555/i);
    expect(JSON.stringify([...cache.store.values()])).not.toMatch(/phone|98765|5555/i);
  });
});

describe('email priority', () => {
  it("a verified Apollo email outranks an address built from the company's format", async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in' })), { check: () => 'accept_all' });
    const r = await findEmail(svc, amit, { ...acme, format: proven, apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'a.kumar@acmeforgings.in', source: 'apollo', verification: 'verified', verifiedBy: 'Apollo', providerStatus: 'verified' });
    // The template address was never built or checked.
    expect(seen.checks).not.toContain('amit.kumar@acmeforgings.in');
  });

  it('only infers from the format when no direct source or Apollo has a usable email, and says so', async () => {
    const svc = services(seen, () => json({ person: null }), { check: () => 'accept_all' });
    const r = await findEmail(svc, amit, { ...acme, format: proven, apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit.kumar@acmeforgings.in', source: 'inferred', verification: 'catch_all' });
    expect(emailLabel(r)).toMatch(/^inferred from the company's email format: .* · unverified: the company's mail server accepts every address/);
    expect(r.notes.join('\n')).toContain('Apollo: nothing for Amit Kumar: Apollo has no matching person');
  });

  it("an Apollo address on another domain is never used; the person's published address beats an unconfirmed Apollo one", async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'amit@gmail.com', status: 'verified', domain: 'acmeforgings.in' })), { check: () => 'accept_all' });
    const r = await findEmail(svc, amit, { ...acme, websiteEmails: ['amit@acmeforgings.in'], apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit@acmeforgings.in', source: 'website', verification: 'catch_all' });
  });
});

describe('only the same person at the same employer', () => {
  const q = { name: 'Amit Kumar', company: 'Acme Forgings', domain: 'acmeforgings.in', linkedin: 'https://in.linkedin.com/in/amit-kumar-1' };
  const read = (body: unknown) => {
    // Through the same reader the client uses.
    const p = (body as { person: Record<string, unknown> }).person;
    return {
      name: String(p.name ?? ''),
      linkedin: String(p.linkedin_url ?? ''),
      email: String(p.email ?? ''),
      emailStatus: String(p.email_status ?? ''),
      orgName: String((p.organization as { name?: string } | null)?.name ?? ''),
      orgDomain: String((p.organization as { primary_domain?: string } | null)?.primary_domain ?? ''),
      confidence: String(p.match_confidence ?? ''),
    };
  };

  it('rejects a person at another company, another person, another profile, and a low-confidence match', () => {
    const ok = { name: 'Amit Kumar', email: 'amit.k@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in', linkedin: q.linkedin };
    expect(judgeApolloPerson(q, read(person(ok)))).toEqual({ email: 'amit.k@acmeforgings.in', status: 'verified' });
    expect(judgeApolloPerson(q, read(person({ ...ok, domain: 'acmesteel.com', org: 'Acme Steel', email: 'amit.k@acmesteel.com' })))).toMatchObject({ outcome: 'not_found', reason: expect.stringContaining('another employer') });
    expect(judgeApolloPerson(q, read(person({ ...ok, name: 'Amit Sharma' })))).toMatchObject({ outcome: 'not_found', reason: expect.stringContaining('different person') });
    expect(judgeApolloPerson(q, read(person({ ...ok, linkedin: 'https://www.linkedin.com/in/amit-kumar-2' })))).toMatchObject({ outcome: 'not_found', reason: expect.stringContaining('different LinkedIn profile') });
    expect(judgeApolloPerson(q, read(person({ ...ok, confidence: 'low' })))).toMatchObject({ outcome: 'not_found', reason: expect.stringContaining('ambiguous') });
    expect(judgeApolloPerson(q, read(person({ ...ok, domain: '', org: '' })))).toMatchObject({ outcome: 'not_found' });
    expect(judgeApolloPerson(q, read(person({ ...ok, email: 'email_not_unlocked@domain.com' })))).toMatchObject({ outcome: 'no_email' });
  });

  it('never looks up a bare or initials-only name without a LinkedIn profile', async () => {
    const svc = services(seen, () => json(person({ name: 'A Kumar' })));
    const r = await apolloEmail(svc, { name: 'A. Kumar', company: 'Acme Forgings', domain: 'acmeforgings.in' });
    expect(r).toMatchObject({ outcome: 'skipped' });
    expect(seen.apollo).toHaveLength(0);
  });

  it("a wrong-employer match gives no email in the chain; the fallback still runs", async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'amit.k@acmesteel.com', status: 'verified', org: 'Acme Steel', domain: 'acmesteel.com' })), { check: () => 'valid' });
    const r = await findEmail(svc, amit, { ...acme, format: proven, apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit.kumar@acmeforgings.in', source: 'inferred', verification: 'verified' });
    expect(r.notes.join('\n')).toContain('another employer (Acme Steel)');
  });
});

describe("the team's and verified addresses are kept", () => {
  it('a team-entered email is kept and Apollo is not asked', async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in' })), { check: () => 'invalid' });
    const r = await findEmail(svc, { ...amit, email: 'amit.k@acme-personal.in', emailSource: 'manual' }, { ...acme, apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit.k@acme-personal.in', source: 'manual', verification: 'invalid' });
    expect(seen.apollo).toHaveLength(0);
  });

  it('a verified published address is used without spending an Apollo lookup', async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in' })), { check: () => 'valid' });
    const r = await findEmail(svc, amit, { ...acme, websiteEmails: ['amit.kumar@acmeforgings.in'], apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit.kumar@acmeforgings.in', source: 'website', verification: 'verified', verifiedBy: 'mail-server check' });
    expect(seen.apollo).toHaveLength(0);
  });
});

describe('unverified Apollo results stay unverified', () => {
  it("is labelled with Apollo's own status and our verdict apart, never as verified", async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'extrapolated', domain: 'acmeforgings.in' })));
    const r = await findEmail(svc, amit, { ...acme, apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'a.kumar@acmeforgings.in', source: 'apollo', verification: 'unverified', providerStatus: 'extrapolated' });
    expect(r.verifiedBy).toBeUndefined();
    expect(emailLabel(r)).toMatch(/^Apollo \(Apollo status: extrapolated, retrieved \d{4}-\d{2}-\d{2}\) · unverified$/);
  });

  it('goes through the mail-server check: confirmed is verified by the check, a catch-all stays unverified', async () => {
    const reply = () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'unverified', domain: 'acmeforgings.in' }));
    const valid = await findEmail(services(seen, reply, { check: () => 'valid' }), amit, { ...acme, apollo: { left: 3 } });
    expect(valid).toMatchObject({ source: 'apollo', verification: 'verified', verifiedBy: 'mail-server check', providerStatus: 'unverified' });
    const catchAll = await findEmail(services(seen, reply, { check: () => 'accept_all' }), amit, { ...acme, apollo: { left: 3 } });
    expect(catchAll).toMatchObject({ source: 'apollo', verification: 'catch_all' });
    expect(emailLabel(catchAll)).not.toContain('verified by');
    const rejected = await findEmail(services(seen, reply, { check: () => 'invalid' }), amit, { ...acme, apollo: { left: 3 } });
    expect(rejected.email).not.toBe('a.kumar@acmeforgings.in');
  });
});

describe('Apollo failures', () => {
  it('records why a lookup failed, separately from "not found", and the chain falls back', async () => {
    const svc = services(seen, () => json({ error: `Invalid access credentials for ${KEY}` }, 401), { check: () => 'accept_all' });
    const r = await findEmail(svc, amit, { ...acme, format: proven, apollo: { left: 3 } });
    expect(r).toMatchObject({ email: 'amit.kumar@acmeforgings.in', source: 'inferred' });
    const notes = r.notes.join('\n');
    expect(notes).toContain('Apollo lookup failed for Amit Kumar: Apollo rejected the API key (401)');
    expect(notes).not.toContain('nothing for');
    // The key is never repeated, even when the server echoes it.
    expect(notes).not.toContain(KEY);
  });

  it('stops asking after exhausted credits, waits out a rate limit, and never caches a failure', async () => {
    const credits = services(seen, () => json({ error: 'You have insufficient credits to perform this action' }, 422));
    expect(await apolloEmail(credits, { name: amit.name, company: acme.company, domain: acme.domain })).toMatchObject({ outcome: 'failed', kind: 'credits' });
    expect(await apolloEmail(credits, { name: 'Neha Rao', company: acme.company, domain: acme.domain })).toMatchObject({ outcome: 'failed', kind: 'credits' });
    expect(seen.apollo).toHaveLength(1);

    seen.apollo = [];
    const cache = memoryCache();
    const limited = services(seen, () => json({ message: 'Too many requests' }, 429, { 'retry-after': '30' }), { cache });
    expect(await apolloEmail(limited, { name: amit.name, company: acme.company, domain: acme.domain })).toMatchObject({ outcome: 'failed', kind: 'rate_limit' });
    expect(cache.store.size).toBe(0);

    const down = services(seen, () => {
      throw new Error('socket hang up');
    });
    expect(await apolloEmail(down, { name: amit.name, company: acme.company, domain: acme.domain })).toMatchObject({ outcome: 'failed', kind: 'unavailable' });
  });

  it('without a key nothing is called and the result says so', async () => {
    const svc = services(seen, () => json({}), { key: '' });
    expect(await apolloEmail(svc, { name: amit.name, company: acme.company, domain: acme.domain })).toMatchObject({ outcome: 'failed', kind: 'no_key' });
    expect(seen.apollo).toHaveLength(0);
  });
});

describe('cached results are reused', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  it('the same person is paid for once, across runs, and a cached result costs no lookup from the budget', async () => {
    const reply = () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in', linkedin: amit.linkedin }));
    const run1 = services(seen, reply, { cache: dbEnrichmentCache(db) });
    const budget: ApolloBudget = { left: 1 };
    expect((await findEmail(run1, amit, { ...acme, apollo: budget })).email).toBe('a.kumar@acmeforgings.in');
    expect(budget.left).toBe(0);
    // A later run (new services, same database): no new request, and the budget isn't touched.
    const run2 = services(seen, reply, { cache: dbEnrichmentCache(db) });
    const again: ApolloBudget = { left: 1 };
    const r = await findEmail(run2, amit, { ...acme, apollo: again });
    expect(r).toMatchObject({ email: 'a.kumar@acmeforgings.in', source: 'apollo', verification: 'verified' });
    expect(r.notes.join('\n')).toContain('from an earlier lookup');
    expect(again.left).toBe(1);
    expect(seen.apollo).toHaveLength(1);
  });

  it('a "no match" is remembered too; the per-company budget stops further lookups', async () => {
    const run = services(seen, () => json({ person: null }), { cache: dbEnrichmentCache(db) });
    const budget: ApolloBudget = { left: 1 };
    await findEmail(run, amit, { ...acme, apollo: budget });
    await findEmail(run, amit, { ...acme, apollo: budget });
    const other = await findEmail(run, { ...EMPTY_CONTACT, name: 'Neha Rao' }, { ...acme, apollo: budget });
    expect(seen.apollo).toHaveLength(1);
    expect(other.notes.join('\n')).toContain("this company's Apollo lookups are used up");
  });
});

describe('refreshing an email on file', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });
  const base = { company: 'Acme Forgings', website: 'acmeforgings.in', contactName: 'Amit Kumar', contactLinkedin: amit.linkedin, status: 'Awaiting Approval' as const };

  it('upgrades an inferred address when Apollo has a verified one, on the lead and the People row', async () => {
    const [lead] = await db
      .insert(leads)
      .values({ ...base, contactEmail: 'amit.kumar@acmeforgings.in', emailSource: 'inferred', emailVerification: 'catch_all', emailStatus: 'inferred · unverified' })
      .returning();
    await db.insert(people).values({ leadId: lead.id, name: 'Amit Kumar', email: 'amit.kumar@acmeforgings.in', isPrimary: true, emailSource: 'inferred' });
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'verified', domain: 'acmeforgings.in', linkedin: amit.linkedin })), { cache: dbEnrichmentCache(db) });
    expect(await refreshMainEmail(db, svc, lead, { left: 3 })).toBe('upgraded');
    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after).toMatchObject({ contactEmail: 'a.kumar@acmeforgings.in', emailSource: 'apollo', emailVerification: 'verified', emailProviderStatus: 'verified' });
    expect((await db.select().from(people).where(eq(people.leadId, lead.id)))[0]).toMatchObject({ email: 'a.kumar@acmeforgings.in', emailSource: 'apollo' });
    const log = (await db.select().from(activities).where(eq(activities.leadId, lead.id))).map((a) => a.text);
    expect(log).toContain('Email upgraded for Amit Kumar: amit.kumar@acmeforgings.in (inferred) → a.kumar@acmeforgings.in (Apollo, verified by Apollo)');
    // Again: no new request.
    await refreshMainEmail(db, svc, after, { left: 3 });
    expect(seen.apollo).toHaveLength(1);
  });

  it("never replaces an inferred address with an unverified Apollo one, nor the team's address, and logs a conflict for review", async () => {
    const svc = services(seen, () => json(person({ name: 'Amit Kumar', email: 'a.kumar@acmeforgings.in', status: 'extrapolated', domain: 'acmeforgings.in', linkedin: amit.linkedin })), { cache: dbEnrichmentCache(db) });
    const [inferred] = await db.insert(leads).values({ ...base, contactEmail: 'amit.kumar@acmeforgings.in', emailSource: 'inferred', emailVerification: 'unverified' }).returning();
    expect(await refreshMainEmail(db, svc, inferred, { left: 3 })).toBe('kept');
    expect((await db.select().from(leads).where(eq(leads.id, inferred.id)))[0].contactEmail).toBe('amit.kumar@acmeforgings.in');

    // A verified Apollo result already on file for this person, and the team's own different address.
    await dbEnrichmentCache(db).set('apollo:v1:in:amit-kumar-1', { outcome: 'found', email: 'a.kumar@acmeforgings.in', status: 'verified', retrievedAt: new Date().toISOString() });
    const [team] = await db.insert(leads).values({ ...base, contactEmail: 'amit@acmeforgings.in', emailSource: 'manual', emailStatus: 'entered by the team' }).returning();
    const before = seen.apollo.length;
    expect(await refreshMainEmail(db, svc, team, { left: 3 })).toBe('conflict');
    expect(seen.apollo.length).toBe(before);
    expect((await db.select().from(leads).where(eq(leads.id, team.id)))[0].contactEmail).toBe('amit@acmeforgings.in');
    const log = (await db.select().from(activities).where(eq(activities.leadId, team.id))).map((a) => a.text);
    expect(log.find((t) => t.startsWith('Email conflict for review'))).toContain("amit@acmeforgings.in (entered by the team); Apollo has a verified a.kumar@acmeforgings.in. The address on file is kept.");
  });

  it('reads older rows from their readable status', () => {
    const row = (emailStatus: string) => ({ email: 'x@y.in', emailSource: '', emailVerification: '', emailStatus });
    expect(emailKind(row('entered by the team'))).toBe('team');
    expect(emailKind(row('accept_all (sales team)'))).toBe('team');
    expect(emailKind(row("likely (company's email format: first.last)"))).toBe('inferred');
    expect(emailKind(row('valid (common email format)'))).toBe('verified');
    expect(emailKind({ ...row(''), email: '' })).toBe('none');
  });
});
