import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { allocationRules, allocationTargets, emailTemplateSteps, emailTemplates, followupRules, icps, leads, messageTemplates, products, settings, userProducts, users, type EmailTemplate, type Icp, type MessageTemplate, type Product } from './db/schema';
import { MANUFACTURING, LOGISTICS } from './db/seed';
import { normSegment } from './icp-match';
import { PROSPECT_QUERIES_LOGISTICS, PROSPECT_QUERIES_MANUFACTURING } from './pipeline/prompts';
import { CA_FOLLOWUP, DEFAULT_FOLLOWUP, parseOutcomes, validateFollowup, type FollowupRule } from './config-rules';
import { DEFAULT_TEMPLATES, variablesIn } from './config-templates';
import { getSettings } from './settings';
import { htmlToText, plainToHtml } from './rich-text';
import { sanitizeEmailHtml } from './mail/sanitize';

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
  // Templates are per step now (see below): this is the first-contact one, as it always was.
  return saveFirstContact(db, channel, productId, icpId, input);
}

/** Keyed `<icp>|<channel>` (first contact) and `<icp>|<channel>|<n>` (follow-up n). `html`: the body is sanitized HTML (every email template is). Only what is assigned to a step is here. */
export type TemplateSet = Map<string, { subject: string; body: string; html?: boolean }>;
export async function loadTemplateSet(db: Db, productId?: number): Promise<TemplateSet> {
  const pid = productId ?? (await defaultProduct(db))?.id;
  const set: TemplateSet = new Map();
  if (!pid) return set;
  const productIcps = await listIcps(db, pid);
  for (const channel of ['email', 'whatsapp'] as const) {
    const byId = new Map((await listStepTemplates(db, pid, channel)).map((t) => [t.id, t]));
    for (const a of await listStepAssignments(db, pid, channel)) {
      const icp = productIcps.find((i) => i.id === a.icpId);
      const t = byId.get(a.templateId);
      if (icp && t) set.set(templateKey(icp.segment, channel, a.step), { subject: t.subject, body: t.body, ...(channel === 'email' ? { html: true } : {}) });
    }
  }
  return set;
}
/** The template sets for the products of some leads (a lead without a product is the default product's), by product id. */
export async function loadTemplateSets(db: Db, productIds: (number | null | undefined)[]): Promise<Map<number, TemplateSet>> {
  const fallback = (await defaultProduct(db))?.id;
  const ids = [...new Set(productIds.map((p) => p ?? fallback).filter((p): p is number => typeof p === 'number'))];
  return new Map(await Promise.all(ids.map(async (id) => [id, await loadTemplateSet(db, id)] as const)));
}
export const templateKey = (segment: string, channel: 'email' | 'whatsapp', step = 0) => `${normSegment(segment)}|${channel}${step > 0 ? `|${step}` : ''}`;

// ─── Templates per step (email and WhatsApp) ───

export type Channel = 'email' | 'whatsapp';
export const FIRST_CONTACT = 'First contact';
/** The templates written for a product's ICPs on one channel (email bodies are sanitized HTML, WhatsApp texts plain). */
export async function listStepTemplates(db: Db, productId: number, channel: Channel): Promise<EmailTemplate[]> {
  return db.select().from(emailTemplates).where(and(eq(emailTemplates.productId, productId), eq(emailTemplates.channel, channel))).orderBy(asc(emailTemplates.icpId), asc(emailTemplates.id));
}
export async function listStepAssignments(db: Db, productId: number, channel: Channel) {
  return db.select().from(emailTemplateSteps).where(and(eq(emailTemplateSteps.productId, productId), eq(emailTemplateSteps.channel, channel)));
}
export const listEmailTemplates = (db: Db, productId: number) => listStepTemplates(db, productId, 'email');
export const listEmailAssignments = (db: Db, productId: number) => listStepAssignments(db, productId, 'email');

/** The steps an ICP's messages go through: the first contact, then one per follow-up of its follow-up rule (so a changed rule changes this list). */
export async function emailStepsFor(db: Db, productId: number, icpId: number): Promise<{ step: number; label: string }[]> {
  const { rule } = await followupRuleFor(db, productId, icpId);
  return [{ step: 0, label: FIRST_CONTACT }, ...Array.from({ length: rule.rounds }, (_, i) => ({ step: i + 1, label: `Follow-up ${i + 1}` }))];
}
export const stepsFor = emailStepsFor;

/** Checks and cleans a template: an email's HTML is sanitized and it needs a subject; a WhatsApp text is plain. Only known variables are used. */
function cleanStepTemplate(channel: Channel, input: { name: string; subject: string; body: string }): { ok: true; name: string; subject: string; body: string } | { ok: false; error: string } {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const email = channel === 'email';
  const subject = email ? input.subject.replace(/\s+/g, ' ').trim() : '';
  const body = email ? sanitizeEmailHtml(input.body) : input.body.replace(/\r\n?/g, '\n').trim();
  if (!name) return { ok: false, error: 'Give the template a name.' };
  if (name.length > 80) return { ok: false, error: 'The template name is too long.' };
  if (email && !subject) return { ok: false, error: 'An email template needs a subject.' };
  const text = email ? htmlToText(body) : body;
  if (!text) return { ok: false, error: 'Write the message.' };
  if (email ? body.length > 20000 || subject.length > 300 : body.length > 4000) return { ok: false, error: 'The template is too long.' };
  const unknown = [...variablesIn(text).unknown, ...variablesIn(subject).unknown];
  if (unknown.length) return { ok: false, error: `Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}. Use {{contact_name}}, {{first_name}}, {{greeting}}, {{company_name}} or {{bd_name}}.` };
  return { ok: true, name, subject, body };
}

/** Creates (no id) or edits one of an ICP's templates. Steps using it send the new text from now on; messages already sent are unchanged. */
export async function saveStepTemplate(db: Db, channel: Channel, productId: number, icpId: number, input: { id?: number; name: string; subject: string; body: string }): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (!(await listIcps(db, productId)).some((i) => i.id === icpId)) return { ok: false, error: "Choose one of this product's ICPs." };
  const clean = cleanStepTemplate(channel, input);
  if (!clean.ok) return clean;
  const mine = (await listStepTemplates(db, productId, channel)).filter((t) => t.icpId === icpId);
  if (mine.some((t) => t.id !== input.id && t.name.toLowerCase() === clean.name.toLowerCase())) return { ok: false, error: `This ICP already has a template called ${clean.name}.` };
  let id = input.id;
  if (id) {
    if (!mine.some((t) => t.id === id)) return { ok: false, error: "That template is not one of this ICP's." };
    await db.update(emailTemplates).set({ name: clean.name, subject: clean.subject, body: clean.body, updatedAt: new Date() }).where(eq(emailTemplates.id, id));
  } else {
    [{ id }] = await db.insert(emailTemplates).values({ productId, icpId, channel, name: clean.name, subject: clean.subject, body: clean.body }).returning({ id: emailTemplates.id });
  }
  await bumpVersion(db, productId);
  return { ok: true, id: id! };
}
export const saveEmailTemplate = (db: Db, productId: number, icpId: number, input: { id?: number; name: string; subject: string; body: string }) => saveStepTemplate(db, 'email', productId, icpId, input);

/** Deletes a template; the steps that used it are left without one (flagged on the page: nothing is sent for them until one is assigned). */
export async function deleteStepTemplate(db: Db, productId: number, id: number): Promise<void> {
  await db.delete(emailTemplateSteps).where(and(eq(emailTemplateSteps.productId, productId), eq(emailTemplateSteps.templateId, id)));
  await db.delete(emailTemplates).where(and(eq(emailTemplates.productId, productId), eq(emailTemplates.id, id)));
  await bumpVersion(db, productId);
}
export const deleteEmailTemplate = deleteStepTemplate;

/** Chooses the template a step uses (null: none, so that step sends nothing and is flagged as missing). */
export async function assignStepTemplate(db: Db, channel: Channel, productId: number, icpId: number, step: number, templateId: number | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await stepsFor(db, productId, icpId)).some((s) => s.step === step)) return { ok: false, error: "That step is not in this ICP's follow-up sequence." };
  if (templateId === null) {
    await db.delete(emailTemplateSteps).where(and(eq(emailTemplateSteps.productId, productId), eq(emailTemplateSteps.icpId, icpId), eq(emailTemplateSteps.channel, channel), eq(emailTemplateSteps.step, step)));
  } else {
    const [t] = await db.select().from(emailTemplates).where(and(eq(emailTemplates.id, templateId), eq(emailTemplates.productId, productId), eq(emailTemplates.icpId, icpId), eq(emailTemplates.channel, channel)));
    if (!t) return { ok: false, error: "Choose one of this ICP's templates." };
    await db
      .insert(emailTemplateSteps)
      .values({ productId, icpId, channel, step, templateId })
      .onConflictDoUpdate({ target: [emailTemplateSteps.productId, emailTemplateSteps.icpId, emailTemplateSteps.channel, emailTemplateSteps.step], set: { templateId } });
  }
  await bumpVersion(db, productId);
  return { ok: true };
}
export const assignEmailTemplate = (db: Db, productId: number, icpId: number, step: number, templateId: number | null) => assignStepTemplate(db, 'email', productId, icpId, step, templateId);

/** The first-contact message as the earlier single template: edits the template the first-contact step uses (or makes one); off unassigns the step. */
async function saveFirstContact(db: Db, channel: Channel, productId: number, icpId: number, input: { subject: string; body: string; active: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
  const [step0] = await db.select().from(emailTemplateSteps).where(and(eq(emailTemplateSteps.productId, productId), eq(emailTemplateSteps.icpId, icpId), eq(emailTemplateSteps.channel, channel), eq(emailTemplateSteps.step, 0)));
  const named = (await listStepTemplates(db, productId, channel)).find((t) => t.icpId === icpId && t.name === FIRST_CONTACT);
  const id = step0?.templateId ?? named?.id;
  const body = channel === 'email' && !/<(p|br|strong|b|em|ul|ol|li|a)\b/i.test(input.body) ? plainToHtml(input.body.replace(/\r\n/g, '\n')) : input.body;
  const r = await saveStepTemplate(db, channel, productId, icpId, { id, name: FIRST_CONTACT, subject: input.subject, body });
  if (!r.ok) return r;
  return assignStepTemplate(db, channel, productId, icpId, 0, input.active ? r.id : null);
}

/**
 * Once each: the single email and WhatsApp templates saved before steps existed (one per ICP) become that ICP's "First contact"
 * template, assigned to the first-contact step, with the same wording (an email as HTML paragraphs). The old rows stay as they were.
 */
export async function migrateEmailTemplatesOnce(db: Db): Promise<void> {
  for (const [key, channel] of [['emailTemplatesStepsV1', 'email'], ['whatsappTemplatesStepsV1', 'whatsapp']] as const) {
    if ((await db.select().from(settings).where(eq(settings.key, key))).length) continue;
    const old = await db.select().from(messageTemplates).where(eq(messageTemplates.channel, channel));
    let moved = 0;
    for (const t of old) {
      const [has] = await db.select({ id: emailTemplates.id }).from(emailTemplates).where(and(eq(emailTemplates.productId, t.productId), eq(emailTemplates.icpId, t.icpId), eq(emailTemplates.channel, channel), eq(emailTemplates.name, FIRST_CONTACT)));
      if (has) continue;
      const body = channel === 'email' ? sanitizeEmailHtml(plainToHtml(t.body)) : t.body;
      const [made] = await db.insert(emailTemplates).values({ productId: t.productId, icpId: t.icpId, channel, name: FIRST_CONTACT, subject: t.subject, body }).returning({ id: emailTemplates.id });
      if (t.active) await db.insert(emailTemplateSteps).values({ productId: t.productId, icpId: t.icpId, channel, step: 0, templateId: made.id }).onConflictDoNothing();
      moved++;
    }
    await db.insert(settings).values({ key, value: { at: new Date().toISOString(), moved } }).onConflictDoNothing();
  }
}

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
