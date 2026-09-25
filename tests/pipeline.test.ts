import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { clients, leads, runEvents, runs } from '@/lib/db/schema';
import { settingsSchema, type Settings } from '@/lib/settings';
import { executeRun, startRun } from '@/lib/runs';
import type { Services } from '@/lib/pipeline/services';
import { fakeFetch, type FakeLog } from './fake-apis';

const TEST_LEADS = [
  { company: 'Tata Motors', website: 'https://www.tatamotors.com/', city: 'Pune', segment: 'Manufacturing & 3PL' },
  { company: 'Bajaj Finance', website: 'bajajfinserv.in', city: 'Pune', segment: 'Manufacturing & 3PL' },
  { company: 'Kirtane & Pandit', website: 'kirtanepandit.com', city: 'Pune', segment: 'CA Firms' },
  { company: 'Mystery Castings', city: 'Nashik' },
  { company: 'Garbage Output Ltd', website: 'garbage.in', segment: 'Manufacturing & 3PL' },
  { company: 'Motherson', website: 'motherson.com', segment: 'manufacturing & 3pl', contactName: 'Vijay Agrawal', contactTitle: 'Plant Head', contactEmail: 'vijay@motherson.com' },
  { company: 'No Draft Industries', website: 'nodraft.in' },
  { company: 'Haldex India Pvt Ltd', website: 'haldexindia.in' },
  { company: 'HX Brakes', website: 'https://haldex.com/in' },
  { company: 'Website Email Co', website: 'websiteemail.in' },
  { company: 'Format Guess Co', website: 'formatguess.in' },
  { company: 'Finder Co', website: 'findr.in' },
  { company: 'Catchall Co', website: 'catchall.in' },
  { company: 'Ash Logistics and Traders Pvt Ltd', website: 'ash-logistics.com', city: 'Pune' },
];

let db: Db;
let log: FakeLog;

function services(overrides: Partial<Settings> = {}): Services {
  return {
    fetch: fakeFetch(log),
    keys: { deepseek: 'ds-test', anthropic: 'ant-test', serper: 'serper-test', hunter: 'hunter-test' },
    settings: settingsSchema.parse({ dailyLimit: 50, ...overrides }),
  };
}

async function byCompany() {
  const rows = await db.select().from(leads);
  return Object.fromEntries(rows.map((r) => [r.company, r]));
}

beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  log = { calls: [], verified: [], finder: [] };
  await db.insert(clients).values([
    { company: 'Haldex', website: 'https://www.haldex.com/' },
    { company: 'Other Client', website: 'otherclient.com' },
  ]);
});

describe('full run with DeepSeek-style messy answers', () => {
  it('handles every lead correctly and never crashes', async () => {
    await db.insert(leads).values(TEST_LEADS);
    const { run } = await startRun(db, { findProspects: true, trigger: 'test' });
    expect(await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY)).toBe('done');

    const L = await byCompany();
    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(finished.status).toBe('done');

    // Existing clients are skipped, by name and by website domain, with no API calls.
    expect(L['Haldex India Pvt Ltd'].status).toBe('Existing Client');
    expect(L['HX Brakes'].status).toBe('Existing Client');
    expect(log.calls.some((c) => c.includes('haldex'))).toBe(false);

    // Messy AI answers (objects for text, "true" as text, fenced JSON) still work.
    expect(L['Tata Motors'].status).toBe('Awaiting Approval');
    expect(L['Tata Motors'].fitReason).toBe('6 plants, SAP');
    expect(L['Tata Motors'].contactName).toBe('Sangamnath Digge');
    expect(L['Tata Motors'].contactEmail).toBe('sangamnath.digge@tatamotors.com');
    expect(L['Tata Motors'].emailStatus).toBe('valid (common email format)');
    expect(L['Tata Motors'].emailBody).toBe('Hi,, body text');
    expect(L['Tata Motors'].linkedinMessage).toBe('Hello');
    expect(L['Tata Motors'].otherDecisionMakers).toContain('Anita Rao | Head Supply Chain - Tata Motors | anita.rao@tatamotors.com');
    // "Z9" isn't a real candidate, so it's ignored rather than invented.
    expect(L['Tata Motors'].otherDecisionMakers).not.toContain('Z9');

    expect(L['Bajaj Finance'].status).toBe('Disqualified');
    expect(L['Bajaj Finance'].fitReason).toBe('Lender, no physical inventory');

    expect(L['Kirtane & Pandit'].status).toBe('Needs Manual Contact');
    expect(L['Kirtane & Pandit'].otherDecisionMakers).toContain('Email search error: 429 usage limit');
    expect(L['Kirtane & Pandit'].emailStatus).toMatch(/^no email found: /);

    expect(L['Mystery Castings'].status).toBe('Needs Manual Contact');
    expect(L['Mystery Castings'].otherDecisionMakers).toContain('LinkedIn search error');

    expect(L['Garbage Output Ltd'].status).toBe('Error');
    expect(L['Garbage Output Ltd'].lastError).toContain('Could not read the AI JSON');

    // The sales team's contact is kept.
    expect(L['Motherson'].contactName).toBe('Vijay Agrawal');
    expect(L['Motherson'].contactEmail).toBe('vijay@motherson.com');
    expect(L['Motherson'].emailStatus).toBe('accept_all (sales team)');

    // Company pattern from Hunter → verified guess; draft missing a body → Error.
    expect(L['No Draft Industries'].contactEmail).toBe('ravi.shah@nodraft.in');
    expect(L['No Draft Industries'].emailStatus).toBe("valid (company's email format)");
    expect(L['No Draft Industries'].status).toBe('Error');

    // Email search, cheapest first.
    expect(L['Website Email Co'].contactEmail).toBe('arjun.mehta@websiteemail.in');
    expect(L['Website Email Co'].emailStatus).toBe('accept_all (company website)');
    expect(log.verified.filter((e) => e.endsWith('websiteemail.in'))).toEqual(['arjun.mehta@websiteemail.in']);

    expect(L['Format Guess Co'].contactEmail).toBe('nkapoor@formatguess.in');
    // Stops at the first valid guess.
    expect(log.verified.filter((e) => e.endsWith('formatguess.in'))).toEqual(['neha.kapoor@formatguess.in', 'nkapoor@formatguess.in']);

    // No LinkedIn hits: leadership from company records is used; invented names are dropped.
    expect(L['Ash Logistics and Traders Pvt Ltd'].contactName).toBe('Jitendra Govind Joshi');
    expect(L['Ash Logistics and Traders Pvt Ltd'].contactTitle).toBe('Founder, Chairman and Managing Director');
    expect(L['Ash Logistics and Traders Pvt Ltd'].otherDecisionMakers).toContain('Vidya Girish Pathak | CFO');
    expect(L['Ash Logistics and Traders Pvt Ltd'].otherDecisionMakers).not.toContain('Invented Person');
    expect(L['Ash Logistics and Traders Pvt Ltd'].contactEmail).toBe('jg.joshi@ash-logistics.com');

    expect(L['Finder Co'].contactEmail).toBe('k.rao@findr.in');
    expect(L['Finder Co'].emailStatus).toBe('valid (Hunter finder)');

    // A catch-all server can't confirm a guess: nothing is saved (no unconfirmed guesses),
    // and it stops guessing after the first address.
    expect(L['Catchall Co'].contactEmail).toBe('');
    expect(L['Catchall Co'].emailStatus).toBe("no email found: company's mail server can't confirm addresses");
    expect(L['Catchall Co'].otherDecisionMakers).toContain('No confirmed email');
    expect(log.verified.filter((e) => e.endsWith('catchall.in'))).toEqual(['amit.joshi@catchall.in']);
    expect(L['Catchall Co'].status).toBe('Awaiting Approval'); // reachable on LinkedIn

    // Prospect search added new companies but skipped duplicates, clients and directories.
    expect(L['Bharat Forge Ltd'].source).toBe('Lookalike of Haldex: forging plants');
    expect(L['Sona Comstar']).toBeDefined();
    expect(L['Tata Motors Limited']).toBeUndefined();
    expect(L['Haldex India']).toBeUndefined();
    expect(L['IndiaMART Listing Co'].website).toBe('');
    // …and researched them in the same run.
    expect(L['Bharat Forge Ltd'].status).not.toBe('New');

    expect(finished.stats.prospectsAdded).toBe(3);
    expect(Object.values(L).every((l) => l.status !== 'New' && l.status !== 'Processing')).toBe(true);
  });

  it('respects the daily limit and continues later', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 5));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await executeRun(db, run.id, services({ dailyLimit: 2 }), Number.POSITIVE_INFINITY);
    const rows = await db.select().from(leads);
    expect(rows.filter((r) => r.status === 'New')).toHaveLength(3);
  });

  it('hands over to a new invocation when out of time', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 5));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    expect(await executeRun(db, run.id, services(), 0)).toBe('continue');
    expect(await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY)).toBe('done');
    const rows = await db.select().from(leads);
    expect(rows.every((r) => r.status !== 'New')).toBe(true);
  });

  it('only allows one run at a time', async () => {
    const a = await startRun(db, { findProspects: false, trigger: 'test' });
    const b = await startRun(db, { findProspects: false, trigger: 'test' });
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
  });

  it('stops when asked', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 3));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, run.id));
    await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY);
    const [r] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(r.status).toBe('cancelled');
  });

  it('reports a missing API key clearly instead of crashing', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 1));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    const svc = services();
    svc.keys.deepseek = '';
    await executeRun(db, run.id, svc, Number.POSITIVE_INFINITY);
    const L = await byCompany();
    expect(L['Tata Motors'].status).toBe('Error');
    expect(L['Tata Motors'].lastError).toContain('DEEPSEEK_API_KEY is not set');
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(events.some((e) => e.level === 'error')).toBe(true);
  });
});

describe('full run with Claude', () => {
  it('uses the Anthropic API with structured outputs and fallbacks', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 2));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await executeRun(db, run.id, services({ aiProvider: 'anthropic', aiModel: 'claude-opus-5' }), Number.POSITIVE_INFINITY);
    const L = await byCompany();
    expect(L['Tata Motors'].status).toBe('Awaiting Approval');
    expect(L['Bajaj Finance'].status).toBe('Disqualified');
    expect(log.calls.some((c) => c.startsWith('POST api.anthropic.com/v1/messages'))).toBe(true);
    expect(log.calls.some((c) => c.includes('deepseek'))).toBe(false);
  });
});
