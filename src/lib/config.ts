import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { allocationRules, allocationTargets, followupRules, icps, leads, messageTemplates, products, settings, userProducts, users, type Icp, type MessageTemplate, type Product } from './db/schema';
import { MANUFACTURING, LOGISTICS } from './db/seed';
import { normSegment } from './icp-match';
import { PROSPECT_QUERIES_LOGISTICS, PROSPECT_QUERIES_MANUFACTURING } from './pipeline/prompts';
import { CA_FOLLOWUP, DEFAULT_FOLLOWUP, parseOutcomes, validateFollowup, type FollowupRule } from './config-rules';
import { DEFAULT_TEMPLATES, variablesIn } from './config-templates';
import { getSettings } from './settings';

/**
 * Configuration: products, their ICPs, team assignments, allocation, templates and follow-up rules. The initial
 * records are made from what used to be fixed in the code (and the per-person numbers on the Team page), so Inveck
 * behaves exactly as before until someone changes them. Changing anything for a product raises its config version,
 * which runs and leads record (they are never rewritten afterwards).
 */
export const DEFAULT_PRODUCT = 'Inveck';
export const CA_ICP = 'CA Firms';
/** CA firms drawn from the Google Sheet per CA associate each working day (see ca-sheet.ts). */
export const CA_PER_ASSOCIATE_DEFAULT = 10;
const SEED_KEY = 'configSeedV1';

const isCa = (segment: string) => normSegment(segment) === normSegment(CA_ICP);

export async function listProducts(db: Db): Promise<Product[]> {
  return db.select().from(products).orderBy(asc(products.id));
}

/** The product everything belongs to until more exist: Inveck (else the first). */
export async function defaultProduct(db: Db): Promise<Product | null> {
  const all = await listProducts(db);
  return all.find((p) => p.name === DEFAULT_PRODUCT) ?? all[0] ?? null;
}

/** Raises the product's configuration version: runs and leads made from now on record the new one. */
export async function bumpVersion(db: Db, productId: number): Promise<number> {
  const [row] = await db.update(products).set({ configVersion: sql`${products.configVersion} + 1` }).where(eq(products.id, productId)).returning({ v: products.configVersion });
  return row?.v ?? 1;
}

// ─── Products ───

export async function saveProduct(db: Db, input: { id?: number; name: string; description?: string; active?: boolean }): Promise<{ ok: true; product: Product } | { ok: false; error: string }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Give the product a name.' };
  if (name.length > 80) return { ok: false, error: 'The product name is too long.' };
  const all = await listProducts(db);
  if (all.some((p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `${name} already exists.` };
  if (input.id) {
    const current = all.find((p) => p.id === input.id);
    if (!current) return { ok: false, error: 'That product no longer exists.' };
    if (input.active === false && all.filter((p) => p.active && p.id !== input.id).length === 0) return { ok: false, error: 'At least one product must stay active.' };
    const [product] = await db.update(products).set({ name, description: input.description ?? current.description, active: input.active ?? current.active, configVersion: sql`${products.configVersion} + 1` }).where(eq(products.id, input.id)).returning();
    return { ok: true, product };
  }
  const [product] = await db.insert(products).values({ name, description: input.description ?? '', active: input.active ?? true }).returning();
  return { ok: true, product };
}

/** The shared search-planning prompt for a product ('' keeps the built-in one) and its product description. */
export async function saveSearchPrompt(db: Db, productId: number, searchPrompt: string, description: string, searchMode?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (searchPrompt.length > 20000) return { ok: false, error: 'The prompt is too long (20,000 characters at most).' };
  if (searchMode !== undefined && searchMode !== 'people_first' && searchMode !== 'ai_planner') return { ok: false, error: 'Choose how this product searches for prospects.' };
  const rows = await db.update(products).set({ searchPrompt: searchPrompt.trim(), description: description.trim(), ...(searchMode ? { searchMode: searchMode as 'people_first' | 'ai_planner' } : {}) }).where(eq(products.id, productId)).returning({ id: products.id });
  if (!rows.length) return { ok: false, error: 'That product no longer exists.' };
  await bumpVersion(db, productId);
  return { ok: true };
}

// ─── ICPs ───

export type IcpInput = {
  segment: string;
  description?: string;
  industries?: string;
  geography?: string;
  companySize?: string;
  mustHaves?: string;
  dealBreakers?: string;
  searchInstructions?: string;
  targetTitles?: string;
  p2Titles?: string;
  p3Titles?: string;
  avoidTitles?: string;
  pitchAngle?: string;
};
const ICP_TEXT_FIELDS = ['description', 'industries', 'geography', 'companySize', 'mustHaves', 'dealBreakers', 'searchInstructions', 'targetTitles', 'p2Titles', 'p3Titles', 'avoidTitles', 'pitchAngle'] as const;

export async function listIcps(db: Db, productId: number): Promise<Icp[]> {
  return db.select().from(icps).where(eq(icps.productId, productId)).orderBy(asc(icps.id));
}

/** Adds or edits an ICP under a product. Its name is what leads' segments and the allocation use, so it is unique within the product. */
export async function saveIcp(db: Db, productId: number, input: IcpInput & { id?: number }): Promise<{ ok: true; icp: Icp } | { ok: false; error: string }> {
  const segment = input.segment.replace(/\s+/g, ' ').trim();
  if (!segment) return { ok: false, error: 'Give the ICP a name.' };
  if (segment.length > 80) return { ok: false, error: 'The ICP name is too long.' };
  const clean = Object.fromEntries(ICP_TEXT_FIELDS.filter((k) => input[k] !== undefined).map((k) => [k, String(input[k]).trim().slice(0, k === 'searchInstructions' ? 20000 : 4000)]));
  const existing = await listIcps(db, productId);
  // A lead's segment is its ICP's name, so a name is used once across all products.
  const everyIcp = await db.select({ id: icps.id, segment: icps.segment }).from(icps);
  if (everyIcp.some((i) => i.id !== input.id && normSegment(i.segment) === normSegment(segment))) return { ok: false, error: `An ICP called ${segment} already exists. ICP names are used once across products (a lead's segment is its ICP's name).` };
  if (input.id) {
    const current = existing.find((i) => i.id === input.id);
    if (!current) return { ok: false, error: 'That ICP no longer exists.' };
    const [icp] = await db.update(icps).set({ segment, ...clean }).where(eq(icps.id, input.id)).returning();
    await bumpVersion(db, productId);
    return { ok: true, icp };
  }
  const [icp] = await db.insert(icps).values({ segment, productId, active: true, ...clean }).returning();
  await bumpVersion(db, productId);
  return { ok: true, icp };
}

export async function setIcpActive(db: Db, productId: number, id: number, active: boolean): Promise<boolean> {
  const rows = await db.update(icps).set({ active }).where(and(eq(icps.id, id), eq(icps.productId, productId))).returning({ id: icps.id });
  if (rows.length) await bumpVersion(db, productId);
  return rows.length > 0;
}

// ─── Team ───

export type TeamMember = { id: number; name: string; username: string; active: boolean; productIds: number[] };

export async function listTeam(db: Db): Promise<TeamMember[]> {
  const rows = await db.select({ id: users.id, name: users.name, username: users.username, active: users.active }).from(users).where(eq(users.role, 'bda')).orderBy(asc(users.id));
  const links = await db.select().from(userProducts);
  return rows.map((u) => ({ ...u, productIds: links.filter((l) => l.userId === u.id).map((l) => l.productId) }));
}

/** Which products a BDA works on (replaces the list). Only BDAs, only products that exist. */
export async function setUserProducts(db: Db, userId: number, productIds: number[]): Promise<boolean> {
  const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u || u.role !== 'bda') return false;
  const valid = (await listProducts(db)).filter((p) => productIds.includes(p.id)).map((p) => p.id);
  await db.delete(userProducts).where(eq(userProducts.userId, userId));
  if (valid.length) await db.insert(userProducts).values(valid.map((productId) => ({ userId, productId })));
  for (const id of valid) await bumpVersion(db, id);
  return true;
}

// ─── Allocation ───

export type AllocationRow = { userId: number; name: string; total: number; counts: Record<number, number> };

/** The allocation matrix for a product: each BDA assigned to it, their daily total and a count per ICP. */
export async function allocationFor(db: Db, productId: number): Promise<{ icps: Icp[]; rows: AllocationRow[] }> {
  const productIcps = await listIcps(db, productId);
  const team = (await listTeam(db)).filter((t) => t.active && t.productIds.includes(productId));
  const targets = await db.select().from(allocationTargets).where(eq(allocationTargets.productId, productId));
  const rules = await db.select().from(allocationRules).where(eq(allocationRules.productId, productId));
  return {
    icps: productIcps,
    rows: team.map((t) => ({
      userId: t.id,
      name: t.name,
      total: targets.find((x) => x.userId === t.id)?.dailyTotal ?? 0,
      counts: Object.fromEntries(productIcps.map((i) => [i.id, rules.find((r) => r.userId === t.id && r.icpId === i.id)?.dailyCount ?? 0])),
    })),
  };
}

/** Saves one BDA's daily total and per-ICP counts for a product, only when the counts add up to the total. */
export async function saveAllocation(db: Db, productId: number, userId: number, total: number, counts: Record<number, number>): Promise<{ ok: true } | { ok: false; error: string }> {
  const { validateAllocation } = await import('./config-rules');
  const productIcps = await listIcps(db, productId);
  const team = await listTeam(db);
  if (!team.some((t) => t.id === userId && t.productIds.includes(productId))) return { ok: false, error: 'That BDA is not assigned to this product.' };
  const ids = productIcps.map((i) => i.id);
  // An ICP not on the form (switched off) keeps the count it had: saving never zeroes what wasn't shown.
  const existing = await db.select().from(allocationRules).where(and(eq(allocationRules.userId, userId), eq(allocationRules.productId, productId)));
  const list = ids.map((id) => Math.trunc(Number(counts[id] ?? existing.find((r) => r.icpId === id)?.dailyCount ?? 0)));
  const check = validateAllocation(Math.trunc(total), list);
  if (!check.ok) return { ok: false, error: check.message };
  await db.insert(allocationTargets).values({ userId, productId, dailyTotal: Math.trunc(total) }).onConflictDoUpdate({ target: [allocationTargets.userId, allocationTargets.productId], set: { dailyTotal: Math.trunc(total) } });
  for (const [i, id] of ids.entries()) {
    await db.insert(allocationRules).values({ userId, productId, icpId: id, dailyCount: list[i] }).onConflictDoUpdate({ target: [allocationRules.userId, allocationRules.productId, allocationRules.icpId], set: { dailyCount: list[i] } });
  }
  await bumpVersion(db, productId);
  return { ok: true };
}

// ─── Templates ───

export async function listTemplates(db: Db, productId: number): Promise<MessageTemplate[]> {
  return db.select().from(messageTemplates).where(eq(messageTemplates.productId, productId)).orderBy(asc(messageTemplates.icpId), asc(messageTemplates.channel));
}

/** Saves a template for a product, ICP and channel. Unknown variables are refused; the subject is for email only. */
export async function saveTemplate(db: Db, productId: number, icpId: number, channel: 'email' | 'whatsapp', input: { subject: string; body: string; active: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await listIcps(db, productId)).some((i) => i.id === icpId)) return { ok: false, error: 'Choose one of this product\'s ICPs.' };
  const subject = channel === 'email' ? input.subject.trim() : '';
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, error: 'Write the message.' };
  if (channel === 'email' && !subject) return { ok: false, error: 'An email template needs a subject.' };
  if (body.length > 8000 || subject.length > 300) return { ok: false, error: 'The template is too long.' };
  const unknown = [...variablesIn(body).unknown, ...variablesIn(subject).unknown];
  if (unknown.length) return { ok: false, error: `Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}. Use {{contact_name}}, {{first_name}}, {{greeting}}, {{company_name}} or {{bd_name}}.` };
  await db
    .insert(messageTemplates)
    .values({ productId, icpId, channel, subject, body, active: input.active })
    .onConflictDoUpdate({ target: [messageTemplates.productId, messageTemplates.icpId, messageTemplates.channel], set: { subject, body, active: input.active, updatedAt: new Date() } });
  await bumpVersion(db, productId);
  return { ok: true };
}

/** The configured templates for a product, found by the ICP's name (a lead's segment). Active ones only. */
export type TemplateSet = Map<string, { subject: string; body: string }>;
export async function loadTemplateSet(db: Db, productId?: number): Promise<TemplateSet> {
  const pid = productId ?? (await defaultProduct(db))?.id;
  const set: TemplateSet = new Map();
  if (!pid) return set;
  const productIcps = await listIcps(db, pid);
  for (const t of await listTemplates(db, pid)) {
    const icp = productIcps.find((i) => i.id === t.icpId);
    if (icp && t.active) set.set(`${normSegment(icp.segment)}|${t.channel}`, { subject: t.subject, body: t.body });
  }
  return set;
}
/** The template sets for the products of some leads (a lead without a product is the default product's), by product id. */
export async function loadTemplateSets(db: Db, productIds: (number | null | undefined)[]): Promise<Map<number, TemplateSet>> {
  const fallback = (await defaultProduct(db))?.id;
  const ids = [...new Set(productIds.map((p) => p ?? fallback).filter((p): p is number => typeof p === 'number'))];
  return new Map(await Promise.all(ids.map(async (id) => [id, await loadTemplateSet(db, id)] as const)));
}
export const templateKey = (segment: string, channel: 'email' | 'whatsapp') => `${normSegment(segment)}|${channel}`;

// ─── Follow-up rules ───

export async function followupRuleFor(db: Db, productId: number, icpId: number): Promise<{ rule: FollowupRule; own: boolean }> {
  const rows = await db.select().from(followupRules).where(and(eq(followupRules.productId, productId), inArray(followupRules.icpId, [icpId, 0])));
  const row = rows.find((r) => r.icpId === icpId) ?? rows.find((r) => r.icpId === 0);
  return row ? { rule: { rounds: row.rounds, spacingDays: row.spacingDays, outcomes: parseOutcomes(row.outcomes) }, own: row.icpId === icpId } : { rule: DEFAULT_FOLLOWUP, own: false };
}

export async function saveFollowupRule(db: Db, productId: number, icpId: number, rule: FollowupRule): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors = validateFollowup(rule);
  if (errors.length) return { ok: false, error: errors.join(' ') };
  if (icpId !== 0 && !(await listIcps(db, productId)).some((i) => i.id === icpId)) return { ok: false, error: "Choose one of this product's ICPs." };
  const outcomes = rule.outcomes.join(',');
  await db
    .insert(followupRules)
    .values({ productId, icpId, rounds: rule.rounds, spacingDays: rule.spacingDays, outcomes })
    .onConflictDoUpdate({ target: [followupRules.productId, followupRules.icpId], set: { rounds: rule.rounds, spacingDays: rule.spacingDays, outcomes, updatedAt: new Date() } });
  await bumpVersion(db, productId);
  return { ok: true };
}

// ─── The initial configuration ───

/**
 * Makes the Inveck product and its starting configuration from what the app did before: its ICPs (and the two
 * Manufacturing and 3PL search sections as their instructions), every BDA on Inveck, allocation from the Team page's per-person
 * numbers (else the Settings ones) plus the CA firms per CA associate, the templates that were hard-coded, and the
 * follow-up rules (5 every other working day; CA's 3). Runs once; nothing it made is touched again, and nothing
 * existing (leads, assignments, history) is rewritten except filling in which product and ICP they belong to.
 */
export async function seedConfiguration(db: Db): Promise<void> {
  let product = await defaultProduct(db);
  // Inveck runs the way it always has: people-first search. (A product made later starts on the AI planner and its prompts.)
  if (!product) [product] = await db.insert(products).values({ name: DEFAULT_PRODUCT, searchMode: 'people_first' }).returning();
  await db.update(icps).set({ productId: product.id }).where(isNull(icps.productId));
  if ((await db.select().from(settings).where(eq(settings.key, SEED_KEY))).length) return;
  const pid = product.id;
  const productIcps = await listIcps(db, pid);
  const byName = (name: string) => productIcps.find((i) => normSegment(i.segment) === normSegment(name));

  // Search instructions: the sections the planner prompt always had for these two ICPs.
  for (const [name, text] of [[MANUFACTURING, PROSPECT_QUERIES_MANUFACTURING], [LOGISTICS, PROSPECT_QUERIES_LOGISTICS]] as const) {
    const icp = byName(name);
    if (icp && !icp.searchInstructions) await db.update(icps).set({ searchInstructions: text }).where(eq(icps.id, icp.id));
  }

  const bdas = await db.select().from(users).where(eq(users.role, 'bda')).orderBy(asc(users.id));
  const s = await getSettings(db);
  const mfg = byName(MANUFACTURING);
  const log = byName(LOGISTICS);
  const ca = byName(CA_ICP);
  const caNames = ['anchal', 'aanchal', 'puja'];
  for (const u of bdas) {
    await db.insert(userProducts).values({ userId: u.id, productId: pid }).onConflictDoNothing();
    const counts: [number | undefined, number][] = [
      [mfg?.id, u.drawManufacturing ?? s.manufacturingPerAssociate],
      [log?.id, u.drawLogistics ?? s.logisticsPerAssociate],
      [ca?.id, caNames.includes(u.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '') ? CA_PER_ASSOCIATE_DEFAULT : 0],
    ];
    const total = counts.reduce((a, [id, n]) => a + (id ? n : 0), 0);
    await db.insert(allocationTargets).values({ userId: u.id, productId: pid, dailyTotal: total }).onConflictDoNothing();
    for (const [id, n] of counts) if (id) await db.insert(allocationRules).values({ userId: u.id, productId: pid, icpId: id, dailyCount: n }).onConflictDoNothing();
  }

  for (const t of DEFAULT_TEMPLATES) {
    const icp = byName(t.icp);
    if (icp) await db.insert(messageTemplates).values({ productId: pid, icpId: icp.id, channel: t.channel, subject: t.subject, body: t.body }).onConflictDoNothing();
  }

  await db.insert(followupRules).values({ productId: pid, icpId: 0, rounds: DEFAULT_FOLLOWUP.rounds, spacingDays: DEFAULT_FOLLOWUP.spacingDays, outcomes: DEFAULT_FOLLOWUP.outcomes.join(',') }).onConflictDoNothing();
  if (ca) await db.insert(followupRules).values({ productId: pid, icpId: ca.id, rounds: CA_FOLLOWUP.rounds, spacingDays: CA_FOLLOWUP.spacingDays, outcomes: CA_FOLLOWUP.outcomes.join(',') }).onConflictDoNothing();

  // Which product and ICP existing leads belong to (a label only: nothing else on them changes).
  await db.update(leads).set({ productId: pid }).where(isNull(leads.productId));
  for (const i of productIcps) await db.update(leads).set({ icpId: i.id }).where(and(isNull(leads.icpId), sql`btrim(regexp_replace(replace(lower(${leads.segment}), '&', ' and '), '[^a-z0-9]+', ' ', 'g')) = ${normSegment(i.segment)}`));
  await db.insert(settings).values({ key: SEED_KEY, value: { at: new Date().toISOString(), product: pid } }).onConflictDoNothing();
}

export const isCaIcp = isCa;
void or;

/**
 * The Team page's per-person numbers (Manufacturing and 3PL) kept in step with Allocation: they set those two ICPs' counts
 * for the default product, and the BDA's daily total follows (other ICPs' counts, CA firms included, are left as they are).
 */
export async function setTeamQuota(db: Db, userId: number, counts: { manufacturing: number; logistics: number }): Promise<void> {
  const product = await defaultProduct(db);
  if (!product) return;
  const productIcps = await listIcps(db, product.id);
  const byName = (name: string) => productIcps.find((i) => normSegment(i.segment) === normSegment(name));
  for (const [name, n] of [[MANUFACTURING, counts.manufacturing], [LOGISTICS, counts.logistics]] as const) {
    const icp = byName(name);
    if (icp) await db.insert(allocationRules).values({ userId, productId: product.id, icpId: icp.id, dailyCount: n }).onConflictDoUpdate({ target: [allocationRules.userId, allocationRules.productId, allocationRules.icpId], set: { dailyCount: n } });
  }
  const rules = await db.select().from(allocationRules).where(and(eq(allocationRules.userId, userId), eq(allocationRules.productId, product.id)));
  const total = rules.reduce((a, r) => a + r.dailyCount, 0);
  await db.insert(allocationTargets).values({ userId, productId: product.id, dailyTotal: total }).onConflictDoUpdate({ target: [allocationTargets.userId, allocationTargets.productId], set: { dailyTotal: total } });
  await db.insert(userProducts).values({ userId, productId: product.id }).onConflictDoNothing();
}

/** Labels a new lead with its product, ICP (by its segment's name) and the configuration version in force. Nothing else on the lead changes. */
export async function stampNewLead(db: Db, leadId: number): Promise<void> {
  const product = await defaultProduct(db);
  const [lead] = await db.select({ segment: leads.segment }).from(leads).where(eq(leads.id, leadId));
  if (!product || !lead) return;
  const icp = (await listIcps(db, product.id)).find((i) => normSegment(i.segment) === normSegment(lead.segment));
  await db.update(leads).set({ productId: product.id, configVersion: product.configVersion, ...(icp ? { icpId: icp.id } : {}) }).where(eq(leads.id, leadId));
}
