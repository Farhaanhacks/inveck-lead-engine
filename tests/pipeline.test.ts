import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, clients, leads, opportunities, people, runEvents, runs, tasks } from '@/lib/db/schema';
import { startFollowUpSequence } from '@/lib/follow-up-sequence';
import { istDay } from '@/lib/tasks';
import { makePrimary } from '@/lib/people';
import { addOpportunityAsLead, scanRadar } from '@/lib/pipeline/radar';
import { settingsSchema, type Settings } from '@/lib/settings';
import { executeRun, startRun } from '@/lib/runs';
import type { Services } from '@/lib/pipeline/services';
import { fakeFetch, type FakeLog } from './fake-apis';
import { applyStage } from '@/lib/stages';
import { draftDueFollowUps } from '@/lib/pipeline/follow-ups';
import { getAnalytics } from '@/lib/analytics';

const M = 'Manufacturing';
const TEST_LEADS = [
  { company: 'Tata Motors', website: 'https://www.tatamotors.com/', city: 'Pune', segment: M },
  { company: 'Bajaj Finance', website: 'bajajfinserv.in', city: 'Pune', segment: M },
  { company: 'Kirtane & Pandit', website: 'kirtanepandit.com', city: 'Pune', segment: 'CA Firms' },
  { company: 'Mystery Castings', city: 'Nashik', segment: 'manufacturing' },
  { company: 'Garbage Output Ltd', website: 'garbage.in', segment: M },
  { company: 'Motherson', website: 'motherson.com', segment: M, contactName: 'Vijay Agrawal', contactTitle: 'Plant Head', contactEmail: 'vijay@motherson.com' },
  { company: 'No Draft Industries', website: 'nodraft.in', segment: M },
  { company: 'Haldex India Pvt Ltd', website: 'haldexindia.in' },
  { company: 'HX Brakes', website: 'https://haldex.com/in' },
  { company: 'Website Email Co', website: 'websiteemail.in', segment: M },
  { company: 'Format Guess Co', website: 'formatguess.in', segment: M },
  { company: 'Finder Co', website: 'findr.in', segment: M },
  { company: 'Catchall Co', website: 'catchall.in', segment: M },
  { company: 'Ash Logistics and Traders Pvt Ltd', website: 'ash-logistics.com', city: 'Pune', segment: M },
  { company: 'Honeywell', website: 'honeywell.com', city: 'Pune', segment: M },
  // A segment no ICP has: flagged for review, never checked against another ICP.
  { company: 'Old Segment Co', website: 'oldsegment.in', segment: 'manufacturing & 3pl' },
];

let db: Db;
let log: FakeLog;

function services(overrides: Partial<Settings> = {}): Services {
  return {
    fetch: fakeFetch(log),
    keys: { deepseek: 'ds-test', anthropic: 'ant-test', serper: 'serper-test', jina: '' },
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
  log = { calls: [], verified: [], finder: [], apollo: [] };
  await db.insert(clients).values([
    { company: 'Haldex', website: 'https://www.haldex.com/' },
    { company: 'Other Client', website: 'otherclient.com' },
  ]);
});

describe('full run with DeepSeek-style messy answers', () => {
  it('handles every lead correctly and never crashes', async () => {
    await db.insert(leads).values(TEST_LEADS);
    // The prospect search (people first) has its own tests: tests/morning-sourcing.test.ts.
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    expect(await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY)).toBe('done');

    const L = await byCompany();
    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(finished.status).toBe('done');

    // Existing clients are skipped, by name and by website domain, with no API calls.
    expect(L['Haldex India Pvt Ltd'].status).toBe('Existing Client');
    expect(L['HX Brakes'].status).toBe('Existing Client');
    expect(log.calls.some((c) => c.includes('haldex'))).toBe(false);

    // A malformed AI answer (wrong types, criteria missing) is asked for again; the second one stands.
    expect(L['Tata Motors'].status).toBe('Approved');
    expect(L['Tata Motors'].fitStatus).toBe('qualified');
    expect(L['Tata Motors'].fitReason).toBe('6 plants, SAP');
    expect(L['Tata Motors'].fitEvidence.find((e) => e.id === 'M1')).toMatchObject({ status: 'met', verified: true, url: 'https://www.tatamotors.com/' });
    expect(L['Tata Motors'].contactName).toBe('Sangamnath Digge');
    // Emails are never looked up (like phone numbers): nothing for a contact found on LinkedIn.
    // no longer guessed (there is no mail-server check to confirm a guess), and no Hunter call is made.
    expect(L['Tata Motors'].contactEmail).toBe('');
    expect(L['Tata Motors'].emailStatus).toBe('');
    expect(log.calls.some((c) => /hunter\.io/.test(c))).toBe(false);
    expect(L['Tata Motors'].emailBody).toBe('Hi,, body text');
    expect(L['Tata Motors'].linkedinMessage).toBe('Hello');
    expect(L['Tata Motors'].otherDecisionMakers).toContain('Anita Rao | Head Supply Chain | https://in.linkedin.com/in/anita');
    // "Z9" isn't a real candidate, so it's ignored rather than invented.
    expect(L['Tata Motors'].otherDecisionMakers).not.toContain('Z9');

    // Ruled out on evidence: its own pages (Google's index of them) quote what fails the ICP.
    expect(L['Bajaj Finance'].status).toBe('Disqualified');
    expect(L['Bajaj Finance'].fitStatus).toBe('not_fit');
    expect(L['Bajaj Finance'].fitReason).toBe('Lender, no physical inventory');
    expect(L['Bajaj Finance'].fitDecision).toContain('non-banking financial company');
    expect(L['Bajaj Finance'].fitEvidence.find((e) => e.id === 'D1')).toMatchObject({ status: 'met', verified: true, url: 'https://www.bajajfinserv.in/' });
    expect(L['Bajaj Finance'].fitScore).toBe(1);

    // A CA firm is worked from the firm's own details: it stays Approved with no person named.
    expect(L['Kirtane & Pandit'].status).toBe('Approved');
    expect(L['Kirtane & Pandit'].emailStatus).toBe('');

    // A segment written differently still names its ICP; finding contacts failing leaves the fit alone.
    expect(L['Mystery Castings'].segment).toBe('Manufacturing');
    expect(L['Mystery Castings'].status).toBe('Deleted');
    expect(L['Mystery Castings']).toMatchObject({ fitStatus: 'qualified', qualified: true, fitScore: 6 });
    expect(L['Mystery Castings'].otherDecisionMakers).toContain('LinkedIn search error');
    // No contact found: it goes to Deleted (restorable) with no draft written, and the reason is recorded.
    expect(L['Mystery Castings'].emailBody).toBe('');
    expect(L['Mystery Castings'].statusBeforeDelete).toBe('Approved');
    expect(L['Mystery Castings'].deletedReason).toMatch(/^No contact found/);

    // An answer that can't be read even when asked again is Disqualified as unconfirmed, never as not a fit.
    expect(L['Garbage Output Ltd']).toMatchObject({ status: 'Disqualified', fitStatus: 'review' });
    expect(L['Garbage Output Ltd'].qualified).toBeNull();
    expect(L['Garbage Output Ltd'].fitDecision).toContain('Could not read the AI JSON');

    expect(L['Old Segment Co']).toMatchObject({ status: 'Disqualified', fitStatus: 'review' });
    expect(L['Old Segment Co'].fitDecision).toContain('matches no ICP');
    expect(L['Old Segment Co'].segment).toBe('manufacturing & 3pl');
    expect(log.calls.some((c) => c.includes('oldsegment'))).toBe(false);

    // The sales team's contact is kept.
    expect(L['Motherson'].contactName).toBe('Vijay Agrawal');
    expect(L['Motherson'].contactEmail).toBe('vijay@motherson.com');
    // The team's address is kept as theirs.
    expect(L['Motherson']).toMatchObject({ emailSource: 'manual', emailVerification: 'unverified' });
    expect(L['Motherson'].emailStatus).toBe('entered by the team');

    // No email or phone number is ever looked up; draft missing a body → kept, retried later.
    expect(L['No Draft Industries'].contactEmail).toBe('');
    expect(L['No Draft Industries'].contactPhone).toBe('');
    // Drafting failed: the lead keeps its research and contact, and the draft is retried later.
    expect(L['No Draft Industries'].status).toBe('Approved');
    expect(L['No Draft Industries'].lastError).toMatch(/^Drafting failed \(retrying automatically\)/);

    // Not even an address published on the website, nor a guessed format; no email service is called.
    expect(L['Website Email Co'].contactEmail).toBe('');
    expect(L['Format Guess Co'].contactEmail).toBe('');
    expect(log.verified).toEqual([]);
    expect(log.apollo ?? []).toEqual([]);

    // No LinkedIn hits: leadership named only in company records can't be confirmed on LinkedIn, so it is
    // set aside, not used: no main contact (the team finds one); invented names are dropped.
    expect(L['Ash Logistics and Traders Pvt Ltd'].contactName).toBe('');
    expect(L['Ash Logistics and Traders Pvt Ltd'].otherDecisionMakers).toContain('Jitendra Govind Joshi set aside: no LinkedIn profile confirms');
    // A CFO isn't on the Manufacturing P1/P2/P3 lists, so the client doesn't want their details.
    expect(L['Ash Logistics and Traders Pvt Ltd'].otherDecisionMakers).not.toContain('Vidya Girish Pathak');
    expect(L['Ash Logistics and Traders Pvt Ltd'].otherDecisionMakers).not.toContain('Invented Person');

    // The company's email format is published, but no address is built from it.
    expect(L['Honeywell'].contactEmail).toBe('');
    // Buying signals: only real news items, linked to their article.
    expect(L['Honeywell'].signals).toEqual([
      { headline: 'Opening a new plant in Chakan', date: '3 weeks ago', url: 'https://news.example/hw-pune', source: 'Economic Times', kind: 'new_facility' },
    ]);
    // The timeline records what research found.
    const hwTimeline = (await db.select().from(activities).where(eq(activities.leadId, L['Honeywell'].id))).map((a) => a.kind);
    expect(hwTimeline).toEqual(expect.arrayContaining(['researched', 'contact', 'approved']));

    // Everyone found at the company is kept, best first, with no email (none is looked up).
    const tataPeople = await db.select().from(people).where(eq(people.leadId, L['Tata Motors'].id));
    expect(tataPeople[0]).toMatchObject({ name: 'Sangamnath Digge', isPrimary: true, email: '' });
    expect(tataPeople.find((p) => p.name === 'Anita Rao')).toMatchObject({ source: 'LinkedIn', isPrimary: false, email: '' });
    const ashPeople = await db.select().from(people).where(eq(people.leadId, L['Ash Logistics and Traders Pvt Ltd'].id));
    expect(ashPeople).toEqual([]);

    // Switching the main contact updates the lead.
    const anita = tataPeople.find((p) => p.name === 'Anita Rao')!;
    await makePrimary(db, anita.id);
    const [tata] = await db.select().from(leads).where(eq(leads.id, L['Tata Motors'].id));
    expect(tata).toMatchObject({ contactName: 'Anita Rao', contactEmail: anita.email });
    expect((await db.select().from(people).where(eq(people.leadId, tata.id))).filter((p) => p.isPrimary).map((p) => p.name)).toEqual(['Anita Rao']);

    expect(L['Finder Co'].contactEmail).toBe('');
    expect(log.calls.some((c) => /hunter\.io|apollo\.io|prospeo\.io/.test(c))).toBe(false);
    expect(L['Catchall Co'].contactEmail).toBe('');
    expect(L['Catchall Co'].status).toBe('Approved'); // reachable on LinkedIn

    expect(Object.values(L).every((l) => l.status !== 'New' && l.status !== 'Processing')).toBe(true);
  });

  it('researches every waiting company in one run: nothing is left at New', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 5));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    // The old per-run cap is ignored.
    await executeRun(db, run.id, services({ dailyLimit: 2 }), Number.POSITIVE_INFINITY);
    const rows = await db.select().from(leads);
    expect(rows.filter((r) => r.status === 'New')).toHaveLength(0);
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

  it("rules out a company its own LinkedIn page shows far below the ICP's size, quoting the page; a big enough one goes on", async () => {
    await db.insert(leads).values([
      { company: 'Tiny Brass Components', website: 'tinybrass.in', city: 'Jamnagar', segment: M },
      { company: 'Big Brass Components', website: 'bigbrass.in', city: 'Jamnagar', segment: M },
    ]);
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY);
    const L = await byCompany();
    expect(L['Tiny Brass Components'].status).toBe('Disqualified');
    expect(L['Tiny Brass Components'].fitDecision).toBe(
      "Not a fit: too small for the ICP's size target (200+ employees or Rs 100 Cr+ revenue): its LinkedIn page shows “Company size: 11-50 employees” (https://in.linkedin.com/company/tiny-brass-components)",
    );
    // 201-500 employees: not too small; it goes on to the contact search like any other.
    expect(L['Big Brass Components'].status).not.toBe('Disqualified');
    expect(L['Big Brass Components'].fitDecision).not.toContain('too small');
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

describe('follow-ups, stages and analytics', () => {
  it('sending schedules nothing; the sequence drafts a follow-up when a round is due, and a reply stops it', async () => {
    const [lead] = await db
      .insert(leads)
      .values({ company: 'Acme Forge', status: 'Approved', ownerId: 1, mailOutcome: 'Sent', emailSubject: 'Stock checks at Acme', emailBody: 'Hi', contactName: 'Ravi Shah', segment: 'Manufacturing', qualified: true, source: 'Lookalike of Haldex: x' })
      .returning();
    await applyStage(db, [lead.id], 'Contacted');
    let [l] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.sentAt).toBeInstanceOf(Date);
    // Marking a lead as sent no longer schedules follow-ups: only a no answer / busy / wrong number call does.
    expect(l.nextFollowUpAt).toBeNull();
    expect(await startFollowUpSequence(db, lead.id)).toHaveLength(5);

    // Not due yet: nothing drafted.
    const noop = async () => {};
    expect(await draftDueFollowUps(db, services(), noop)).toBe(0);
    // Follow-up 1 comes due.
    await db.update(tasks).set({ dueDate: istDay() }).where(eq(tasks.followUpRound, 1));
    expect(await draftDueFollowUps(db, services(), noop)).toBe(1);
    [l] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.followUpBody).toBe('Follow-up 1 body');
    expect(l.followUpSubject).toBe('Re: original');

    // Replying ends the sequence.
    await applyStage(db, [lead.id], 'Replied');
    [l] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(l.followUpBody).toBe('');
    const kinds = (await db.select().from(activities).where(eq(activities.leadId, lead.id))).map((a) => `${a.kind}:${a.stage}`);
    expect(kinds).toEqual(['sent:Contacted', 'note:', 'follow_up_drafted:', 'stage:Replied', 'note:']);

    // Analytics see the whole journey, even after the lead moves on.
    await applyStage(db, [lead.id], 'Lost');
    const a = await getAnalytics(db);
    expect(a.funnel.map((s) => [s.label, s.value])).toEqual([
      ['Researched', 1], ['Qualified', 1], ['Contacted', 1], ['Replied', 1], ['Meetings', 0], ['Won', 0],
    ]);
    expect(a.replyRate).toBe(100);
    expect(a.weeks.at(-1)).toMatchObject({ sent: 1, replied: 1 });
    expect(a.bestSource).toMatchObject({ name: 'Lookalike of a client', hits: 1, total: 1, metric: 'replied' });
  });
});

describe('full run with Claude', () => {
  it('uses the Anthropic API with structured outputs and fallbacks', async () => {
    await db.insert(leads).values(TEST_LEADS.slice(0, 2));
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await executeRun(db, run.id, services({ aiProvider: 'anthropic', aiModel: 'claude-opus-5' }), Number.POSITIVE_INFINITY);
    const L = await byCompany();
    expect(L['Tata Motors'].status).toBe('Approved');
    expect(L['Bajaj Finance'].status).toBe('Disqualified');
    expect(log.calls.some((c) => c.startsWith('POST api.anthropic.com/v1/messages'))).toBe(true);
    expect(log.calls.some((c) => c.includes('deepseek'))).toBe(false);
  });
});

describe('winning a lead', () => {
  it('adds the company to the client sheet, keeps the lead Won, and marks its duplicates', async () => {
    const [won, dup] = await db
      .insert(leads)
      .values([
        { company: 'Acme Forge Pvt Ltd', website: 'acmeforge.in', segment: 'Manufacturing', status: 'Meeting Booked' },
        { company: 'Acme Forge', website: 'https://www.acmeforge.in', status: 'New' },
      ])
      .returning();
    await applyStage(db, [won.id], 'Won', 'Stock verification across 4 plants');
    const client = (await db.select().from(clients)).find((c) => c.company === 'Acme Forge Pvt Ltd');
    expect(client).toMatchObject({ website: 'acmeforge.in', industry: 'Manufacturing', whyBought: 'Stock verification across 4 plants' });
    const statuses = Object.fromEntries((await db.select().from(leads)).map((l) => [l.id, l.status]));
    expect(statuses[won.id]).toBe('Won');
    expect(statuses[dup.id]).toBe('Existing Client');
    const notes = (await db.select().from(activities).where(eq(activities.leadId, won.id))).map((a) => a.text);
    expect(notes).toContain('Added to current clients');
    // Winning again doesn't duplicate the client.
    await applyStage(db, [won.id], 'Lost');
    await applyStage(db, [won.id], 'Won');
    expect((await db.select().from(clients)).filter((c) => c.company.startsWith('Acme')).length).toBe(1);
  });
});

describe('new facility radar', () => {
  it('finds real new openings, skips known companies and invented ones, and adds them as leads', async () => {
    await db.insert(leads).values({ company: 'Tata Motors', status: 'New' });
    const r = await scanRadar(db, services(), undefined, { force: true });
    expect(r).toEqual({ added: 1, error: '' });
    // The AI's " MANUFACTURING " is the Manufacturing ICP, spelled its way.
    const [o] = await db.select().from(opportunities);
    expect(o).toMatchObject({
      company: 'Varroc Engineering',
      headline: 'New lighting plant in Chakan',
      location: 'Chakan, Maharashtra',
      segment: 'Manufacturing',
      url: 'https://news.example/varroc',
      source: 'Economic Times',
      status: 'new',
    });

    // Scans at most every 12 hours, and never duplicates an opening.
    expect(await scanRadar(db, services())).toEqual({ added: 0, error: '' });
    expect(await scanRadar(db, services(), undefined, { force: true })).toEqual({ added: 0, error: '' });

    const leadId = await addOpportunityAsLead(db, o.id);
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId!));
    expect(lead).toMatchObject({ company: 'Varroc Engineering', city: 'Chakan', status: 'New', segment: 'Manufacturing' });
    expect(lead.signals[0]).toMatchObject({ headline: 'New lighting plant in Chakan', url: 'https://news.example/varroc', kind: 'new_facility' });
    expect((await db.select().from(opportunities))[0]).toMatchObject({ status: 'added', leadId });
    // Adding twice does nothing.
    expect(await addOpportunityAsLead(db, o.id)).toBeNull();
  });
});

describe('dashboard and board agree', () => {
  it('a lead sent and then moved back before sending is no longer counted as contacted', async () => {
    const [a, b] = await db
      .insert(leads)
      .values([
        { company: 'Sent Co', status: 'Approved', qualified: true },
        { company: 'Undo Co', status: 'Approved', qualified: true },
      ])
      .returning();
    await applyStage(db, [a.id, b.id], 'Contacted');
    await applyStage(db, [b.id], 'New'); // "Research again"
    const [undone] = await db.select().from(leads).where(eq(leads.id, b.id));
    expect(undone.sentAt).toBeNull();
    expect(undone.nextFollowUpAt).toBeNull();
    const stats = await getAnalytics(db);
    expect(stats.funnel[2]).toMatchObject({ label: 'Contacted', value: 1 });
    expect(stats.awaitingReply).toBe(1);
  });
});

describe('contacts reset', () => {
  it('wipes saved contacts except live conversations, then finds them again keeping research and stage', async () => {
    const { sql } = await import('drizzle-orm');
    const { tasks, settings } = await import('@/lib/db/schema');
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const base = { website: 'tatamotors.com', city: 'Pune', segment: 'Manufacturing', qualified: true, fitScore: 9, fitReason: 'Plants', researchSummary: 'Tata Motors makes vehicles at several plants.' };
    const [a, b, c] = await db
      .insert(leads)
      .values([
        { ...base, company: 'Tata Motors', status: 'Contacted', contactName: 'Old Person', contactTitle: 'Chief of Operations - Express', contactEmail: 'old@tatamotors.com' },
        { ...base, company: 'Talking Co', website: 'talking.in', status: 'Contacted', contactName: 'Live Contact' },
        { ...base, company: 'Demo Co', website: 'demo.in', status: 'Meeting Booked', contactName: 'Demo Person' },
      ])
      .returning();
    await db.insert(people).values({ leadId: a.id, name: 'Old Person', title: 'Chief of Operations - Express', isPrimary: true });
    await db.insert(tasks).values({ leadId: b.id, ownerId: 1, kind: 'call', title: 'c', dueDate: '2026-10-01', doneAt: new Date(), outcome: 'connected' });

    await db.delete(settings).where(eq(settings.key, 'contactsResetV1'));
    for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes('contactsResetV1'))) await db.execute(sql.raw(s));

    let [ta] = await db.select().from(leads).where(eq(leads.id, a.id));
    expect(ta).toMatchObject({ contactName: '', contactTitle: '', contactEmail: '', refetchPending: true, status: 'Contacted', fitScore: 9 });
    expect(await db.select().from(people).where(eq(people.leadId, a.id))).toHaveLength(0);
    const kept = await db.select().from(leads).where(eq(leads.refetchPending, false));
    expect(kept.map((l) => l.contactName).sort()).toEqual(['Demo Person', 'Live Contact']);
    expect(c.id).toBeGreaterThan(0);

    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    expect(await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY)).toBe('done');
    [ta] = await db.select().from(leads).where(eq(leads.id, a.id));
    expect(ta.refetchPending).toBe(false);
    expect(ta.contactName).not.toBe('');
    expect(ta.contactName).not.toBe('Old Person');
    // Research and the stage are kept.
    expect(ta).toMatchObject({ status: 'Contacted', fitScore: 9, researchSummary: base.researchSummary });
  });
});

describe('fresh start', () => {
  it('clears every contact and everything done, takes leads off their BDAs, keeps companies and research', async () => {
    const { sql } = await import('drizzle-orm');
    const { tasks, settings, attendance, companyDays } = await import('@/lib/db/schema');
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const base = { website: 'acme.in', city: 'Pune', segment: 'Manufacturing', qualified: true, fitScore: 8, researchSummary: 'Acme makes parts.', ownerId: 1 };
    const [a, b] = await db
      .insert(leads)
      .values([
        { ...base, company: 'Acme', status: 'Meeting Booked', contactName: 'Demo Person', callFeedback: 'Demo scheduled', remark: 'hot', sentAt: new Date(), drawnOn: '2026-10-02' },
        { ...base, company: 'Ruled Out', website: 'ro.in', status: 'Disqualified', contactName: '' },
      ])
      .returning();
    await db.insert(people).values({ leadId: a.id, name: 'Demo Person', isPrimary: true });
    await db.insert(tasks).values({ leadId: a.id, ownerId: 1, kind: 'call', title: 'c', dueDate: '2026-10-01', doneAt: new Date(), outcome: 'connected' });
    await db.insert(attendance).values({ userId: 1, day: '2026-10-01' });
    await db.insert(companyDays).values({ leadId: a.id, ownerId: 1, day: '2026-10-01' });
    await db.insert(activities).values({ leadId: a.id, kind: 'note', text: 'x' });
    await db.insert(settings).values({ key: 'draw:2026-09-30', value: { drawn: 1 } });

    await db.delete(settings).where(eq(settings.key, 'freshStartV1'));
    for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes('freshStartV1'))) await db.execute(sql.raw(s));

    const [ta] = await db.select().from(leads).where(eq(leads.id, a.id));
    expect(ta).toMatchObject({
      contactName: '', ownerId: null, status: 'Approved', callFeedback: '', remark: '', sentAt: null, drawnOn: '', refetchPending: true,
      fitScore: 8, researchSummary: 'Acme makes parts.',
    });
    expect(await db.select().from(people)).toHaveLength(0);
    expect(await db.select().from(tasks)).toHaveLength(0);
    expect(await db.select().from(attendance)).toHaveLength(0);
    expect(await db.select().from(companyDays)).toHaveLength(0);
    expect(await db.select().from(activities)).toHaveLength(0);
    expect(await db.select().from(settings).where(eq(settings.key, 'draw:2026-09-30'))).toHaveLength(0);
    // No draw on the day of the fresh start.
    const { istDay } = await import('@/lib/tasks');
    const [today] = await db.select().from(settings).where(eq(settings.key, `draw:${istDay()}`));
    expect(today?.value).toMatchObject({ wanted: 0, drawn: 0 });
    const [tb] = await db.select().from(leads).where(eq(leads.id, b.id));
    expect(tb).toMatchObject({ status: 'Disqualified', refetchPending: false, ownerId: null });

    // Runs once only: a second pass changes nothing.
    await db.insert(tasks).values({ leadId: a.id, ownerId: 1, kind: 'call', title: 'c', dueDate: '2026-10-05' });
    for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes('freshStartV1'))) await db.execute(sql.raw(s));
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
});

describe('clear everything', () => {
  it('deletes every lead and all that hangs off it, keeping logins, ICPs, clients and settings', async () => {
    const { sql } = await import('drizzle-orm');
    const { tasks, settings, attendance, users, icps } = await import('@/lib/db/schema');
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const [l] = await db.insert(leads).values({ company: 'Acme', status: 'Contacted', ownerId: 1 }).returning();
    await db.insert(people).values({ leadId: l.id, name: 'X', isPrimary: true });
    await db.insert(tasks).values({ leadId: l.id, ownerId: 1, kind: 'call', title: 'c', dueDate: '2026-10-01' });
    await db.insert(attendance).values({ userId: 1, day: '2026-10-01' });
    await db.insert(activities).values({ leadId: l.id, kind: 'note', text: 'x' });
    await db.insert(clients).values({ company: 'Haldex India' });
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await db.insert(runEvents).values({ runId: run.id, message: 'x' });
    await db.insert(opportunities).values({ company: 'New Plant Co', headline: 'h', url: 'u' });
    const before = { users: (await db.select().from(users)).length, icps: (await db.select().from(icps)).length };

    await db.delete(settings).where(eq(settings.key, 'clearAllV1'));
    for (const s of SCHEMA_STATEMENTS.filter((x) => x.includes('clearAllV1'))) await db.execute(sql.raw(s));

    for (const t of [leads, people, tasks, attendance, activities, runs, runEvents, opportunities]) expect(await db.select().from(t)).toHaveLength(0);
    expect((await db.select().from(clients)).map((c) => c.company)).toContain('Haldex India');
    expect((await db.select().from(users)).length).toBe(before.users);
    expect((await db.select().from(icps)).length).toBe(before.icps);
  });
});

describe('new prospects delegated by the admin', () => {
  it('splits them across the team, gives them to one person, or leaves them for the draw', async () => {
    const { delegateProspects } = await import('@/lib/runs');
    const { users } = await import('@/lib/db/schema');
    const team = await db.select().from(users).orderBy(users.id);
    const add = async (n: number) => (await db.insert(leads).values(Array.from({ length: n }, (_, i) => ({ company: `P${Math.random()}${i}` }))).returning()).map((r) => r.id);
    const a = await add(8);
    expect(await delegateProspects(db, a, 'team')).toContain(`${team[0].name} 2`);
    const owners = (await db.select().from(leads)).map((l) => l.ownerId);
    expect(new Set(owners).size).toBe(4);
    const b = await add(3);
    await delegateProspects(db, b, String(team[2].id));
    expect((await db.select().from(leads)).filter((l) => b.includes(l.id)).every((l) => l.ownerId === team[2].id)).toBe(true);
    const c = await add(2);
    expect(await delegateProspects(db, c, '')).toBe('');
    expect((await db.select().from(leads)).filter((l) => c.includes(l.id)).every((l) => l.ownerId === null)).toBe(true);
  });
});

describe('a prospect search that fails', () => {
  it('ends the run as failed with the reason, not as finished', async () => {
    const { run } = await startRun(db, { findProspects: true, trigger: 'test' });
    // A wrong Serper key: every search is refused.
    const svc = { ...services(), keys: { ...services().keys, serper: 'wrong-key' } };
    expect(await executeRun(db, run.id, svc, Number.POSITIVE_INFINITY)).toBe('done');
    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/^Prospect search failed: /);
  });
});

describe('finding contacts again while search is down', () => {
  it('keeps the saved contacts instead of replacing them with nothing, and doesn\'t retry in a loop', async () => {
    const [l] = await db
      .insert(leads)
      .values({ company: 'Acme Forgings', website: 'acmeforgings.in', city: 'Jaipur', segment: 'Manufacturing', status: 'Approved', qualified: true, fitScore: 8, researchSummary: 'Acme forges parts.', contactName: 'Rohan Katara', contactTitle: 'Supply Chain Manager', refetchPending: true })
      .returning();
    await db.insert(people).values({ leadId: l.id, name: 'Rohan Katara', title: 'Supply Chain Manager', isPrimary: true });
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    const svc = { ...services(), keys: { ...services().keys, serper: 'wrong-key' } };
    await executeRun(db, run.id, svc, Number.POSITIVE_INFINITY);
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ contactName: 'Rohan Katara', refetchPending: false });
    expect(await db.select().from(people).where(eq(people.leadId, l.id))).toHaveLength(1);
  });
});

describe('a company with no contact while search is down', () => {
  it('says the search failed and keeps it waiting for a later run, without retrying in a loop', async () => {
    const [l] = await db
      .insert(leads)
      .values({ company: 'Mojj Engineering Systems Limited', website: 'mojjpune.com', city: 'Pune', segment: 'Manufacturing', status: 'Approved', qualified: true, fitScore: 8, researchSummary: 'Mojj makes process equipment.', refetchPending: true })
      .returning();
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    const svc = { ...services(), keys: { ...services().keys, serper: 'wrong-key' } };
    expect(await executeRun(db, run.id, svc, Number.POSITIVE_INFINITY)).toBe('done');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.refetchPending).toBe(true);
    expect(after.lastError).toMatch(/^Contacts not searched: .*Searched again automatically on a later run\.$/);
    expect(after.contactName).toBe('');
  });
});

describe('stopping a run that is finding contacts again', () => {
  it('stops, and drops the rest of the queue so it does not start again by itself', async () => {
    const rows = await db
      .insert(leads)
      .values(Array.from({ length: 4 }, (_, i) => ({ company: `Queued ${i}`, status: 'Approved' as const, contactName: 'Old Contact', refetchPending: true })))
      .returning();
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, run.id));
    expect(await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY)).toBe('done');
    const [stopped] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(stopped.status).toBe('cancelled');
    const after = await db.select().from(leads);
    expect(after.filter((l) => rows.some((r) => r.id === l.id)).every((l) => !l.refetchPending && l.contactName === 'Old Contact')).toBe(true);
  });
});

describe('prospect search remembers what it searched and saw', () => {
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  const ai = (reply: unknown) => ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] });

  it('treats reworded queries as the same search', async () => {
    const { normQuery, tooSimilar } = await import('@/lib/pipeline/query-history');
    expect(normQuery('automotive suppliers Pune')).toBe(normQuery('Pune automotive supplier companies'));
    expect(tooSimilar('Pune automotive supplier companies', ['automotive suppliers Pune'])).toBeTruthy();
    expect(tooSimilar('auto component manufacturer Pune ISO 9001', ['auto component manufacturer Pune'])).toBeTruthy();
    expect(tooSimilar('CA firm Delhi stock audit', ['chartered accountants Delhi stock audit'])).toBeTruthy();
    expect(tooSimilar('auto component manufacturer Chennai', ['auto component manufacturer Pune'])).toBeNull();
    expect(tooSimilar('forging companies Ludhiana', ['casting foundry Kolhapur'])).toBeNull();
  });

  it('never runs a search again across runs, and never re-adds a company an earlier run turned up', async () => {
    const { findProspects } = await import('@/lib/pipeline/prospects');
    const { prospectHistory } = await import('@/lib/runs');
    const { prospectSearches, prospectResults, icps } = await import('@/lib/db/schema');
    const activeIcps = await db.select().from(icps);
    // The planner keeps suggesting the first run's query (reworded) next to new ones.
    const plans = [
      [{ query: 'automotive suppliers Pune', segment: 'Manufacturing', lookalike_of: '' }],
      [{ query: 'Pune automotive supplier companies', segment: 'Manufacturing', lookalike_of: '' }, { query: 'forging companies Ludhiana', segment: 'Manufacturing', lookalike_of: '' }],
    ];
    let plan = 0;
    const searched: string[] = [];
    const pickTexts: string[] = [];
    const fetch = (async (u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(u).includes('deepseek')) {
        const system = body.messages[0].content as string;
        if (system.startsWith('You plan Google searches')) return ai({ queries: plans[Math.min(plan++, plans.length - 1)] });
        pickTexts.push(body.messages[1].content);
        // The AI picks every company it sees (it would pick Pune Auto again if it saw it).
        const companies = [];
        if (body.messages[1].content.includes('puneauto.in')) companies.push({ company: 'Pune Auto Parts', website: 'puneauto.in', city: 'Pune', segment: 'Manufacturing', lookalike_of: '', why: 'plants' });
        if (body.messages[1].content.includes('ludhianaforge.in')) companies.push({ company: 'Ludhiana Forge', website: 'ludhianaforge.in', city: 'Ludhiana', segment: 'Manufacturing', lookalike_of: '', why: 'forgings' });
        return ai({ companies });
      }
      searched.push(body.q);
      const organic = /ludhiana/i.test(body.q)
        ? [{ title: 'Ludhiana Forge | Forgings', link: 'https://ludhianaforge.in/', snippet: 'forging plant Ludhiana' }, { title: 'Pune Auto Parts', link: 'https://puneauto.in/', snippet: 'also here' }]
        : [{ title: 'Pune Auto Parts', link: 'https://puneauto.in/', snippet: 'auto parts plants in Pune' }];
      return ok({ organic });
    }) as unknown as typeof globalThis.fetch;
    const svc = { ...services(), fetch, settings: settingsSchema.parse({ prospectsPerRun: 1 }) };

    const first = await findProspects(svc, activeIcps, [], [], async () => {}, await prospectHistory(db, 1));
    expect(first.map((p) => p.company)).toEqual(['Pune Auto Parts']);
    // The lead list was cleared since: the company is still remembered from the search history.
    searched.length = 0;
    pickTexts.length = 0;
    const logs: string[] = [];
    const second = await findProspects(svc, activeIcps, [], [], async (m) => { logs.push(m); }, await prospectHistory(db, 2));
    expect(second.map((p) => p.company)).toEqual(['Ludhiana Forge']);
    // The reworded repeat was never searched; the company is remembered at its location (the AI is told,
    // and it isn't added again there; its plant in another city would still be new).
    expect(searched.some((q) => /pune/i.test(q))).toBe(false);
    expect(logs.join(' ')).toContain('Skipped 1 search already run before');
    expect(pickTexts.join(' ')).toContain('Pune Auto Parts (Pune)');

    const rows = await db.select().from(prospectSearches).orderBy(prospectSearches.id);
    expect(rows.map((r) => [r.query, r.runId, r.status, r.addedCount])).toEqual([
      ['automotive suppliers Pune', 1, 'ok', 1],
      ['forging companies Ludhiana', 2, 'ok', 1],
    ]);
    const results = await db.select().from(prospectResults);
    expect(results.filter((r) => r.outcome === 'added').map((r) => r.company).sort()).toEqual(['Ludhiana Forge', 'Pune Auto Parts']);
    // Picked again in the second run, at the same location: recorded as a duplicate, not added.
    expect(results.some((r) => r.outcome === 'duplicate' && r.company === 'Pune Auto Parts' && r.city === 'Pune' && r.runId === 2)).toBe(true);
  });
});

describe('research that keeps timing out', () => {
  it('goes back to the queue once, then to Error instead of looping', async () => {
    const { MAX_RESEARCH_ATTEMPTS } = await import('@/lib/runs');
    const long = new Date(Date.now() - 60 * 60 * 1000);
    const [retry, giveUp] = await db
      .insert(leads)
      .values([
        { company: 'Slow Once', status: 'Processing', processingStartedAt: long, researchAttempts: 1 },
        { company: 'Slow Always', status: 'Processing', processingStartedAt: long, researchAttempts: MAX_RESEARCH_ATTEMPTS },
      ])
      .returning();
    const { run } = await startRun(db, { findProspects: false, trigger: 'test' });
    // The first is put back in the queue and researched again (its second attempt); the second has
    // used its attempts and is not.
    await executeRun(db, run.id, services(), Number.POSITIVE_INFINITY);
    const [a] = await db.select().from(leads).where(eq(leads.id, retry.id));
    const [b] = await db.select().from(leads).where(eq(leads.id, giveUp.id));
    expect(a.status).not.toBe('Processing');
    expect(a.researchAttempts).toBe(2);
    expect(b).toMatchObject({ status: 'Error', researchAttempts: MAX_RESEARCH_ATTEMPTS });
    expect(b.lastError).toMatch(/timed out\) 2 times/);
  });
});

describe('"Sales team" means the team entered it', () => {
  it('a contact an earlier research run picked is not kept as the team\'s', async () => {
    const { contactFromTeam } = await import('@/lib/runs');
    const [fresh, researched, edited] = await db
      .insert(leads)
      .values([
        { company: 'Typed In Co', contactName: 'Asha Rao' },
        { company: 'Researched Co', contactName: 'Rohan Katara', researchSummary: 'Makes bearings.' },
        { company: 'Edited Co', contactName: 'Neha Iyer', researchSummary: 'Makes gears.' },
      ])
      .returning();
    await db.insert(activities).values({ leadId: edited.id, kind: 'contact', text: 'Point of contact updated: Neha Iyer' });
    expect(await contactFromTeam(db, fresh)).toBe(true);
    expect(await contactFromTeam(db, researched)).toBe(false);
    expect(await contactFromTeam(db, edited)).toBe(true);
    // An automatic switch (next person after no answer, a better-ranked contact) is not the team's choice.
    const [p1, p2] = await db.insert(people).values([{ leadId: researched.id, name: 'Rohan Katara', isPrimary: true }, { leadId: researched.id, name: 'Pratap Naruka' }]).returning();
    await makePrimary(db, p2.id);
    expect(await contactFromTeam(db, { ...researched, contactName: 'Pratap Naruka' })).toBe(false);
    await makePrimary(db, p1.id, { byTeam: true });
    expect(await contactFromTeam(db, researched)).toBe(true);
  });
});
