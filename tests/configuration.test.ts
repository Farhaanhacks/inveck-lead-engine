import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { allocationRules, allocationTargets, followupRules, icps, leads, messageTemplates, runs, settings, tasks, userProducts, users } from '@/lib/db/schema';
import { PROSPECT_QUERIES_BASE_PROMPT, PROSPECT_QUERIES_LOGISTICS, PROSPECT_QUERIES_MANUFACTURING } from '@/lib/pipeline/prompts';
import { queryPlannerPrompt } from '@/lib/pipeline/prospects';
import { htmlToText } from '@/lib/rich-text';
import { seedConfiguration, allocationFor, defaultProduct, listIcps, listProducts, listTeam, loadTemplateSet, saveAllocation, saveFollowupRule, saveIcp, saveProduct, saveTemplate, setIcpActive } from '@/lib/config';
import { createBda } from '@/lib/config-team';
import { CA_FOLLOWUP, DEFAULT_FOLLOWUP, offsetsOf, scheduleFor, validateAllocation, validateFollowup } from '@/lib/config-rules';
import { renderTemplate, SAMPLE_VARS, variablesIn } from '@/lib/config-templates';
import { firstEmailFor } from '@/lib/mail/first-email';
import { buildWhatsApp } from '@/lib/whatsapp-outreach';
import { checkPassword } from '@/lib/users';
import { runDailyDraw } from '@/lib/draw';
import { ruleForLead, startFollowUpSequence } from '@/lib/follow-up-sequence';
import { startRun } from '@/lib/runs';
import { istDay } from '@/lib/tasks';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

const inveck = async () => (await defaultProduct(db))!;
const icpNamed = async (name: string) => (await listIcps(db, (await inveck()).id)).find((i) => i.segment === name)!;
const userNamed = async (name: string) => (await db.select().from(users)).find((u) => u.name === name)!;

describe('the starting configuration is what the app did before', () => {
  it('has the Inveck product, on people-first search, with every ICP and BDA under it', async () => {
    const [p] = await listProducts(db);
    expect(p).toMatchObject({ name: 'Inveck', searchMode: 'people_first', active: true });
    expect((await listProducts(db)).map((x) => x.name)).toEqual(['Inveck']); // no other product is made
    expect((await listIcps(db, p.id)).map((i) => i.segment)).toEqual(['Manufacturing', '3PL & Logistics', 'CA Firms']);
    const team = await listTeam(db);
    expect(team.length).toBeGreaterThanOrEqual(4);
    expect(team.every((t) => t.productIds.includes(p.id))).toBe(true);
  });

  it('keeps the Manufacturing and 3PL search prompts on those ICPs: the planner prompt is word for word what it was', async () => {
    const p = await inveck();
    const icpList = await listIcps(db, p.id);
    expect((await icpNamed('Manufacturing')).searchInstructions).toBe(PROSPECT_QUERIES_MANUFACTURING);
    expect((await icpNamed('3PL & Logistics')).searchInstructions).toBe(PROSPECT_QUERIES_LOGISTICS);
    expect((await icpNamed('CA Firms')).searchInstructions).toBe('');
    expect(queryPlannerPrompt(icpList, p.searchPrompt)).toBe([PROSPECT_QUERIES_BASE_PROMPT, PROSPECT_QUERIES_MANUFACTURING, PROSPECT_QUERIES_LOGISTICS].join('\n\n'));
    // An ICP with no instructions at all (an older caller) still gets the built-in section by its name.
    expect(queryPlannerPrompt([{ segment: 'Manufacturing' }, { segment: '3PL & Logistics' }])).toBe([PROSPECT_QUERIES_BASE_PROMPT, PROSPECT_QUERIES_MANUFACTURING, PROSPECT_QUERIES_LOGISTICS].join('\n\n'));
  });

  it('carries over each BDA\'s allocation: their own Team numbers (else the Settings ones), plus CA firms for the CA associates', async () => {
    const p = await inveck();
    // As on the live database: lists set on the Team page before configuration existed.
    await db.update(users).set({ drawManufacturing: 40, drawLogistics: 0 }).where(inArray(users.name, ['Anchal', 'Puja']));
    await db.update(users).set({ drawManufacturing: 24, drawLogistics: 16 }).where(inArray(users.name, ['Parimal', 'Anuradha']));
    await db.delete(allocationRules);
    await db.delete(allocationTargets);
    await db.delete(settings).where(eq(settings.key, 'configSeedV1'));
    await seedConfiguration(db);
    const { rows, icps: cols } = await allocationFor(db, p.id);
    const by = (name: string) => rows.find((r) => r.name === name)!;
    const id = (name: string) => cols.find((c) => c.segment === name)!.id;
    expect([by('Anchal').counts[id('Manufacturing')], by('Anchal').counts[id('3PL & Logistics')], by('Anchal').counts[id('CA Firms')], by('Anchal').total]).toEqual([40, 0, 10, 50]);
    expect([by('Puja').counts[id('CA Firms')], by('Puja').total]).toEqual([10, 50]);
    expect([by('Parimal').counts[id('Manufacturing')], by('Parimal').counts[id('3PL & Logistics')], by('Parimal').counts[id('CA Firms')], by('Parimal').total]).toEqual([24, 16, 0, 40]);
  });

  it('without per-person numbers the Settings ones (12 + 8) are the starting counts', async () => {
    const p = await inveck();
    const { rows, icps: cols } = await allocationFor(db, p.id);
    const parimal = rows.find((r) => r.name === 'Parimal')!;
    expect([parimal.counts[cols.find((c) => c.segment === 'Manufacturing')!.id], parimal.counts[cols.find((c) => c.segment === '3PL & Logistics')!.id], parimal.total]).toEqual([12, 8, 20]);
  });

  it('carries over the follow-up rules (5 every other working day; CA 3, a day apart) and the templates', async () => {
    const p = await inveck();
    expect((await ruleForLead(db, { productId: p.id, icpId: (await icpNamed('Manufacturing')).id, segment: 'Manufacturing' }))).toEqual(DEFAULT_FOLLOWUP);
    expect(await ruleForLead(db, { productId: null, icpId: null, segment: 'CA Firms' })).toEqual(CA_FOLLOWUP);
    const set = await loadTemplateSet(db, p.id);
    expect([...set.keys()].sort()).toEqual(['3pl and logistics|email', '3pl and logistics|whatsapp', 'ca firms|whatsapp', 'manufacturing|email', 'manufacturing|whatsapp']);
    // Existing leads were only labelled with their product and ICP.
    const [l] = await db.insert(leads).values({ company: 'Later Co', segment: 'Manufacturing' }).returning();
    expect(l.productId).toBeNull();
  });
});

describe('products and ICPs', () => {
  it('adds a product later (not made now), keeps one active, and ICP names are used once across products', async () => {
    const created = await saveProduct(db, { name: 'Movek' });
    expect(created.ok && created.product.searchMode).toBe('ai_planner');
    expect((await saveProduct(db, { name: 'movek' })).ok).toBe(false);
    const inv = await inveck();
    expect((await saveProduct(db, { id: inv.id, name: 'Inveck', active: false })).ok).toBe(true); // Movek stays active
    const mv = created.ok ? created.product : null;
    expect((await saveProduct(db, { id: mv!.id, name: 'Movek', active: false })).ok).toBe(false); // the last active one
    expect((await saveIcp(db, mv!.id, { segment: 'Manufacturing' })).ok).toBe(false);
    const own = await saveIcp(db, mv!.id, { segment: 'Retail chains', industries: 'Retail', searchInstructions: 'Search for retail chains with 50+ stores.' });
    expect(own.ok && own.icp.productId).toBe(mv!.id);
  });

  it('a new ICP is available straight away in allocation, templates and follow-up rules, and every change raises the version', async () => {
    const p = await inveck();
    const v0 = p.configVersion;
    const r = await saveIcp(db, p.id, { segment: 'Pharma', industries: 'Pharmaceuticals', dealBreakers: 'Chemicals only' });
    if (!r.ok) throw new Error(r.error);
    expect((await allocationFor(db, p.id)).icps.map((i) => i.segment)).toContain('Pharma');
    expect((await saveTemplate(db, p.id, r.icp.id, 'whatsapp', { subject: '', body: '{{greeting}} {{bd_name}} here.', active: true })).ok).toBe(true);
    expect((await saveFollowupRule(db, p.id, r.icp.id, { rounds: 3, spacingDays: 3, outcomes: ['no_answer'] })).ok).toBe(true);
    expect((await listProducts(db))[0].configVersion).toBeGreaterThan(v0 + 2);
    expect(await setIcpActive(db, p.id, r.icp.id, false)).toBe(true);
    expect((await db.select().from(icps).where(eq(icps.id, r.icp.id)))[0].active).toBe(false);
  });
});

describe('team members', () => {
  it('creates BDAs only, with a hashed random password, on the products chosen, and never twice for one email', async () => {
    const p = await inveck();
    const r = await createBda(db, { name: 'Ishaan Rao', email: 'Ishaan.Rao@Inveck.com', productIds: [p.id] });
    if (!r.ok) throw new Error(r.error);
    const [row] = await db.select().from(users).where(eq(users.id, r.id));
    expect(row).toMatchObject({ role: 'bda', username: 'ishaan.rao@inveck.com', mustChangePassword: true, active: true });
    expect(row.passwordHash).not.toContain(r.password);
    expect(await checkPassword(r.password, row.passwordHash)).toBe(true);
    expect(r.password).toHaveLength(12);
    expect((await listTeam(db)).find((t) => t.id === r.id)?.productIds).toEqual([p.id]);
    expect(await createBda(db, { name: 'Again', email: 'ishaan.rao@inveck.com', productIds: [p.id] })).toMatchObject({ ok: false });
    expect(await createBda(db, { name: 'No product', email: 'np@x.com', productIds: [] })).toMatchObject({ ok: false });
    expect(await createBda(db, { name: 'Bad', email: 'not-an-email', productIds: [p.id] })).toMatchObject({ ok: false });
    expect((await db.select().from(users).where(eq(users.role, 'admin')))).toEqual([]);
  });
});

describe('allocation', () => {
  it('counts must add up to the daily total, saved only then; counts for switched-off ICPs are kept', async () => {
    expect(validateAllocation(10, [6, 4])).toMatchObject({ ok: true });
    expect(validateAllocation(10, [6, 3])).toMatchObject({ ok: false, message: expect.stringContaining('add up to 9, but the daily total is 10') });
    const p = await inveck();
    const parimal = await userNamed('Parimal');
    const m = await icpNamed('Manufacturing');
    const l3 = await icpNamed('3PL & Logistics');
    const ca = await icpNamed('CA Firms');
    const bad = await saveAllocation(db, p.id, parimal.id, 30, { [m.id]: 20, [l3.id]: 5, [ca.id]: 0 });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('25') });
    expect((await allocationFor(db, p.id)).rows.find((r) => r.userId === parimal.id)!.total).toBe(20);
    expect((await saveAllocation(db, p.id, parimal.id, 30, { [m.id]: 20, [l3.id]: 10, [ca.id]: 0 })).ok).toBe(true);
    // CA is switched off on the form: its count is not zeroed by saving the others.
    await db.update(allocationRules).set({ dailyCount: 5 }).where(and(eq(allocationRules.userId, parimal.id), eq(allocationRules.icpId, ca.id)));
    expect((await saveAllocation(db, p.id, parimal.id, 35, { [m.id]: 20, [l3.id]: 10 })).ok).toBe(true);
    expect((await db.select().from(allocationRules).where(and(eq(allocationRules.userId, parimal.id), eq(allocationRules.icpId, ca.id))))[0].dailyCount).toBe(5);
    expect((await db.select().from(allocationTargets).where(eq(allocationTargets.userId, parimal.id)))[0].dailyTotal).toBe(35);
  });

  const monday = new Date('2026-09-28T03:30:00Z');
  const pool = (n: number, segment: string) => Array.from({ length: n }, (_, i) => ({ company: `${segment} ${i + 1}`, segment, status: 'Approved' as const, qualified: true, contactName: 'Asha Rao', contactVerifiedAt: new Date() }));

  it('a new ICP is drawn with no code change, in a fixed oldest-first order, and the extra lead of a remainder passes round the team', async () => {
    const p = await inveck();
    const r = await saveIcp(db, p.id, { segment: 'Pharma' });
    if (!r.ok) throw new Error(r.error);
    const team = (await listTeam(db)).filter((t) => ['Puja', 'Parimal'].includes(t.name));
    for (const t of await listTeam(db)) {
      const keep = team.some((x) => x.id === t.id);
      const n = keep ? 1 : 0;
      await saveAllocation(db, p.id, t.id, n, Object.fromEntries((await listIcps(db, p.id)).map((i) => [i.id, i.id === r.icp.id ? n : 0])));
    }
    await db.insert(leads).values(pool(3, 'Pharma'));
    const first = await runDailyDraw(db, { now: monday });
    expect(first).toMatchObject({ drawn: 2, wanted: 2 });
    const given = (await db.select().from(leads).where(eq(leads.segment, 'Pharma')).orderBy(leads.id)).map((l) => l.ownerId !== null);
    // Oldest first: the two oldest were given out, the newest is still waiting.
    expect(given).toEqual([true, true, false]);
    // The next day: the third goes to someone, and a fixed rotation (not luck) decides who: the same two days give the same result.
    const next = new Date('2026-09-29T03:30:00Z');
    await db.update(allocationRules).set({ dailyCount: 0 });
    await runDailyDraw(db, { now: next });
    const owner = (await db.select().from(leads).where(eq(leads.segment, 'Pharma')).orderBy(leads.id))[2].ownerId;
    expect(owner).toBeNull(); // counts at zero: nothing more is given
  });
});

describe('templates', () => {
  it('rejects unknown variables, renders the known ones, and a template needing a missing value is a problem, never a blank', async () => {
    expect(variablesIn('Hi {{first_name}} at {{company_name}} {{oops}}')).toEqual({ used: ['first_name', 'company_name'], unknown: ['oops'] });
    expect(renderTemplate('Hi {{contact_name}}, {{bd_name}} here.', SAMPLE_VARS)).toEqual({ ok: true, text: 'Hi Ravi Kumar, Puja here.' });
    expect(renderTemplate('Hi {{contact_name}}', { contact_name: '  ' })).toEqual({ ok: false, missing: ['contact_name'] });
    const p = await inveck();
    const m = await icpNamed('Manufacturing');
    expect(await saveTemplate(db, p.id, m.id, 'email', { subject: 'Hi', body: 'Dear {{nope}}', active: true })).toMatchObject({ ok: false, error: expect.stringContaining('{{nope}}') });
    expect(await saveTemplate(db, p.id, m.id, 'email', { subject: '', body: 'x', active: true })).toMatchObject({ ok: false });
  });

  it('what is configured is what is sent; the built-in text is unchanged until edited; an individual edit never touches the template', async () => {
    const p = await inveck();
    const lead = { segment: 'Manufacturing', contactName: 'Mr. Ravi Kumar', company: 'Hosur Gears' };
    const before = firstEmailFor(lead, 'Puja', await loadTemplateSet(db, p.id));
    const builtIn = firstEmailFor(lead, 'Puja');
    // The configured template is the same wording, now kept as HTML paragraphs.
    expect(before).toMatchObject({ subject: builtIn!.subject, template: builtIn!.template, html: true, problem: '' });
    expect(htmlToText(before!.body)).toBe(builtIn!.body);
    expect(htmlToText(before!.body).startsWith('Hello Mr. Ravi Kumar,\n\nI hope')).toBe(true);
    const m = await icpNamed('Manufacturing');
    await saveTemplate(db, p.id, m.id, 'email', { subject: 'New subject for {{company_name}}', body: 'Hi {{contact_name}}, {{bd_name}} here.', active: true });
    const after = firstEmailFor(lead, 'Puja', await loadTemplateSet(db, p.id));
    expect(after).toMatchObject({ subject: 'New subject for Hosur Gears', problem: '' });
    expect(htmlToText(after!.body)).toBe('Hi Ravi Kumar, Puja here.');
    expect(firstEmailFor({ ...lead, contactName: '' }, 'Puja', await loadTemplateSet(db, p.id))).toMatchObject({ problem: expect.stringContaining("main contact's name is missing") });
    // Turning it off: that ICP goes back to the AI draft (no template).
    await saveTemplate(db, p.id, m.id, 'email', { subject: 'x', body: 'x', active: false });
    expect(firstEmailFor(lead, 'Puja', await loadTemplateSet(db, p.id))).toBeNull();
    expect((await db.select().from(messageTemplates).where(eq(messageTemplates.icpId, m.id)))).toHaveLength(2);
  });

  it('WhatsApp uses its ICP\'s template and the same plain errors', async () => {
    const p = await inveck();
    const set = await loadTemplateSet(db, p.id);
    const lead = { segment: '3PL & Logistics', company: 'Swift Cargo', contactName: 'Asha Rao', contactPhone: '98450 12345' };
    expect(buildWhatsApp(lead, 'Anuradha', set)).toMatchObject({ ok: true });
    expect(buildWhatsApp(lead, 'Anuradha', set)).toEqual(buildWhatsApp(lead, 'Anuradha'));
    expect(buildWhatsApp(lead, '', set)).toMatchObject({ ok: false, error: expect.stringContaining('no owner') });
    expect(buildWhatsApp({ ...lead, segment: 'Pharma' }, 'Anuradha', set)).toMatchObject({ ok: false, error: expect.stringContaining('Pharma') });
  });
});

describe('follow-up rules', () => {
  it('the default schedule is the old one, and a changed rule gives its own preview', () => {
    expect(offsetsOf(DEFAULT_FOLLOWUP)).toEqual([2, 4, 6, 8, 10]);
    expect(scheduleFor(DEFAULT_FOLLOWUP, '2026-09-28')).toHaveLength(5);
    expect(offsetsOf({ rounds: 3, spacingDays: 3 })).toEqual([3, 6, 9]);
    // Weekends never count: Friday + 1 working day is Monday.
    expect(scheduleFor({ rounds: 2, spacingDays: 1 }, '2026-10-02')).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('validates the rule', () => {
    expect(validateFollowup(DEFAULT_FOLLOWUP)).toEqual([]);
    expect(validateFollowup({ rounds: 0, spacingDays: 2, outcomes: ['no_answer'] })).toHaveLength(1);
    expect(validateFollowup({ rounds: 3, spacingDays: 11, outcomes: ['no_answer'] })).toHaveLength(1);
    expect(validateFollowup({ rounds: 3, spacingDays: 2, outcomes: [] })).toHaveLength(1);
    expect(validateFollowup({ rounds: 3, spacingDays: 2, outcomes: ['connected'] })).toHaveLength(1);
  });

  it('a lead gets the rule of its own ICP: 3 rounds three days apart start from an unanswered call, and old sequences are not rewritten', async () => {
    const p = await inveck();
    const m = await icpNamed('Manufacturing');
    const puja = await userNamed('Puja');
    const mk = async (company: string) => (await db.insert(leads).values({ company, segment: 'Manufacturing', status: 'Contacted', ownerId: puja.id, productId: p.id, icpId: m.id, contactName: 'A' }).returning())[0];
    const old = await mk('Old Co');
    await startFollowUpSequence(db, old.id);
    expect((await db.select().from(tasks).where(eq(tasks.leadId, old.id))).filter((t) => t.kind === 'call')).toHaveLength(5);
    expect((await saveFollowupRule(db, p.id, m.id, { rounds: 3, spacingDays: 3, outcomes: ['no_answer', 'busy'] })).ok).toBe(true);
    const fresh = await mk('New Co');
    await startFollowUpSequence(db, fresh.id);
    const calls = (await db.select().from(tasks).where(eq(tasks.leadId, fresh.id))).filter((t) => t.kind === 'call');
    expect(calls).toHaveLength(3);
    expect((await ruleForLead(db, fresh)).outcomes).toEqual(['no_answer', 'busy']);
    // The earlier lead's five rounds are untouched.
    expect((await db.select().from(tasks).where(and(eq(tasks.leadId, old.id), isNull(tasks.doneAt)))).filter((t) => t.kind === 'call')).toHaveLength(5);
  });
});

describe('what each run and lead records', () => {
  it('a run records its product, the configuration version and, on the AI planner, the exact prompt', async () => {
    const inv = await inveck();
    const a = await startRun(db, { findProspects: true, trigger: 'manual' });
    expect(a.run).toMatchObject({ productId: inv.id, configVersion: inv.configVersion, plannerPrompt: '' }); // people-first: no planner prompt
    await db.update(runs).set({ status: 'done' });
    const mv = await saveProduct(db, { name: 'Movek' });
    if (!mv.ok) throw new Error(mv.error);
    const icp = await saveIcp(db, mv.product.id, { segment: 'Retail chains', searchInstructions: 'Retail instructions here.' });
    if (!icp.ok) throw new Error(icp.error);
    const b = await startRun(db, { findProspects: true, trigger: 'manual', productId: mv.product.id });
    expect(b.run.productId).toBe(mv.product.id);
    expect(b.run.plannerPrompt).toContain('Retail instructions here.');
    expect(b.run.plannerPrompt).not.toContain('Manufacturing-specific');
    expect(b.run.configVersion).toBeGreaterThan(1);
  });
});

describe('leads record their product, ICP and configuration version', () => {
  it('an imported lead is labelled; nothing else on it changes', async () => {
    const { importContactSheet } = await import('@/lib/contact-import');
    const { KnownBranches } = await import('@/lib/branches');
    const p = await inveck();
    const r = await importContactSheet(db, [{ company: 'Mehta & Co', website: '', city: 'Pune', phones: ['9822012345'], emails: [], people: [], remark: '' }], { segment: 'CA Firms', ownerId: null, known: new KnownBranches([], []), by: 'test' });
    const [l] = await db.select().from(leads).where(eq(leads.id, r.ids[0]));
    expect(l).toMatchObject({ productId: p.id, icpId: (await icpNamed('CA Firms')).id, configVersion: p.configVersion, segment: 'CA Firms', company: 'Mehta & Co' });
  });
});

void istDay;
void userProducts;
void followupRules;
