'use server';

import { after } from 'next/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { clients, icps, leads, runs, type LeadStatus } from '@/lib/db/schema';
import { appPassword, SESSION_COOKIE, sessionToken } from '@/lib/auth';
import { driveRun } from '@/lib/run-driver';
import { startRun } from '@/lib/runs';
import { DEFAULT_MODELS, getSettings, saveSettings, settingsSchema } from '@/lib/settings';
import { domainOf, normCompany } from '@/lib/pipeline/text';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

// ─── Login ────────────────────────────────────────────────────────────────

export async function login(_prev: { error: string } | undefined, form: FormData) {
  const password = appPassword();
  if (!password) return { error: 'APP_PASSWORD is not set on the server.' };
  if (str(form, 'password') !== password) return { error: 'Wrong password.' };
  (await cookies()).set(SESSION_COOKIE, await sessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  const next = str(form, 'next');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

// ─── Runs ─────────────────────────────────────────────────────────────────

export async function startRunAction(form: FormData) {
  const db = await getDb();
  const { run, created } = await startRun(db, { findProspects: str(form, 'findProspects') === 'yes', trigger: 'manual' });
  if (created) {
    const h = await headers();
    const origin = `${h.get('x-forwarded-proto') || 'http'}://${h.get('host')}`;
    after(() => driveRun(run.id, origin));
  }
  redirect(`/runs?id=${run.id}`);
}

export async function stopRunAction(form: FormData) {
  const db = await getDb();
  await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, Number(str(form, 'id'))));
  revalidatePath('/runs');
}

// ─── Leads ────────────────────────────────────────────────────────────────

/** Existing leads and clients, for skipping duplicates when adding companies. */
async function knownCompanies() {
  const db = await getDb();
  const rows = [
    ...(await db.select({ company: leads.company, website: leads.website }).from(leads)),
    ...(await db.select({ company: clients.company, website: clients.website }).from(clients)),
  ];
  return {
    names: new Set(rows.map((r) => normCompany(r.company)).filter(Boolean)),
    domains: new Set(rows.map((r) => domainOf(r.website)).filter(Boolean)),
  };
}

async function matchSegment(segment: string) {
  const db = await getDb();
  const names = (await db.select({ segment: icps.segment }).from(icps)).map((r) => r.segment);
  return names.find((n) => n.toLowerCase() === segment.toLowerCase()) || segment;
}

export async function addLeadAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  const company = str(form, 'company');
  if (!company) return { ok: false, message: 'Company name is required.' };
  const known = await knownCompanies();
  const website = domainOf(str(form, 'website'));
  if (known.names.has(normCompany(company)) || (website && known.domains.has(website))) {
    return { ok: false, message: `${company} is already a lead or a client.` };
  }
  const db = await getDb();
  await db.insert(leads).values({
    company,
    website,
    city: str(form, 'city'),
    segment: await matchSegment(str(form, 'segment')),
    source: 'Added by hand',
    contactName: str(form, 'contactName'),
    contactTitle: str(form, 'contactTitle'),
    contactEmail: str(form, 'contactEmail'),
    contactPhone: str(form, 'contactPhone'),
    contactLinkedin: str(form, 'contactLinkedin'),
  });
  revalidatePath('/leads');
  revalidatePath('/');
  return { ok: true, message: `Added ${company}. It will be researched on the next run.` };
}

/** Bulk add: one company per line, "Company, website, city, segment" (comma or tab separated). */
export async function addLeadsBulkAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  const lines = str(form, 'bulk').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const known = await knownCompanies();
  const toAdd: (typeof leads.$inferInsert)[] = [];
  let skipped = 0;
  for (const line of lines) {
    const [company = '', website = '', city = '', segment = ''] = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!company || /^company$/i.test(company)) continue;
    const domain = domainOf(website);
    if (known.names.has(normCompany(company)) || (domain && known.domains.has(domain))) {
      skipped++;
      continue;
    }
    known.names.add(normCompany(company));
    if (domain) known.domains.add(domain);
    toAdd.push({ company, website: domain, city, segment: await matchSegment(segment), source: 'Added by hand' });
  }
  if (toAdd.length) await (await getDb()).insert(leads).values(toAdd);
  revalidatePath('/leads');
  revalidatePath('/');
  return {
    ok: toAdd.length > 0,
    message: `Added ${toAdd.length} ${toAdd.length === 1 ? 'company' : 'companies'}${skipped ? `, skipped ${skipped} already a lead or a client` : ''}.`,
  };
}

export async function updateLeadAction(form: FormData) {
  const id = Number(str(form, 'id'));
  const db = await getDb();
  await db
    .update(leads)
    .set({
      company: str(form, 'company'),
      website: domainOf(str(form, 'website')),
      city: str(form, 'city'),
      segment: str(form, 'segment'),
      contactName: str(form, 'contactName'),
      contactTitle: str(form, 'contactTitle'),
      contactEmail: str(form, 'contactEmail'),
      contactPhone: str(form, 'contactPhone'),
      companyPhone: str(form, 'companyPhone'),
      contactLinkedin: str(form, 'contactLinkedin'),
      emailSubject: str(form, 'emailSubject'),
      emailBody: String(form.get('emailBody') ?? ''),
      linkedinMessage: String(form.get('linkedinMessage') ?? ''),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
  revalidatePath(`/leads/${id}`);
}

const STATUS_ACTIONS: Record<string, LeadStatus> = {
  approve: 'Approved',
  sent: 'Contacted',
  reject: 'Rejected',
  requeue: 'New',
};

export async function setLeadStatusAction(form: FormData) {
  const id = Number(str(form, 'id'));
  const status = STATUS_ACTIONS[str(form, 'action')];
  if (!status) return;
  const db = await getDb();
  await db
    .update(leads)
    .set({ status, updatedAt: new Date(), ...(status === 'Contacted' ? { sentAt: new Date() } : {}), ...(status === 'New' ? { lastError: '' } : {}) })
    .where(eq(leads.id, id));
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/');
}

export async function bulkLeadAction(form: FormData) {
  const ids = form.getAll('ids').map(Number).filter(Boolean);
  const action = str(form, 'action');
  if (!ids.length) return;
  const db = await getDb();
  if (action === 'delete') await db.delete(leads).where(inArray(leads.id, ids));
  else if (STATUS_ACTIONS[action]) await db.update(leads).set({ status: STATUS_ACTIONS[action], updatedAt: new Date() }).where(inArray(leads.id, ids));
  revalidatePath('/leads');
  revalidatePath('/');
}

export async function deleteLeadAction(form: FormData) {
  const db = await getDb();
  await db.delete(leads).where(eq(leads.id, Number(str(form, 'id'))));
  revalidatePath('/leads');
  redirect('/leads');
}

// ─── ICPs & clients ───────────────────────────────────────────────────────

function icpFields(form: FormData) {
  return {
    segment: str(form, 'segment'),
    active: form.get('active') === 'on',
    description: str(form, 'description'),
    industries: str(form, 'industries'),
    companySize: str(form, 'companySize'),
    geography: str(form, 'geography'),
    mustHaves: str(form, 'mustHaves'),
    dealBreakers: str(form, 'dealBreakers'),
    targetTitles: str(form, 'targetTitles'),
    pitchAngle: str(form, 'pitchAngle'),
  };
}

export async function saveIcpAction(form: FormData) {
  const db = await getDb();
  const id = Number(str(form, 'id'));
  const fields = icpFields(form);
  if (!fields.segment) return;
  if (id) await db.update(icps).set(fields).where(eq(icps.id, id));
  else await db.insert(icps).values(fields);
  revalidatePath('/targets');
}

export async function deleteIcpAction(form: FormData) {
  const db = await getDb();
  await db.delete(icps).where(eq(icps.id, Number(str(form, 'id'))));
  revalidatePath('/targets');
}

export async function addClientsAction(_prev: { message: string } | undefined, form: FormData) {
  const db = await getDb();
  const existing = await db.select().from(clients);
  const names = new Set(existing.map((c) => normCompany(c.company)));
  const rows: (typeof clients.$inferInsert)[] = [];
  const add = (company: string, website: string, industry: string, whyBought: string) => {
    if (!company || /^company$/i.test(company) || names.has(normCompany(company))) return;
    names.add(normCompany(company));
    rows.push({ company, website: domainOf(website), industry, whyBought });
  };
  // One client from the form fields…
  add(str(form, 'company'), str(form, 'website'), str(form, 'industry'), str(form, 'whyBought'));
  // …and/or many pasted as lines.
  for (const line of str(form, 'bulk').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [company = '', website = '', industry = '', ...why] = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
    add(company, website, industry, why.join(', '));
  }
  if (rows.length) {
    await db.insert(clients).values(rows);
    // Clients already sitting in the lead list are marked so nobody cold-emails them.
    const allLeads = await db.select({ id: leads.id, company: leads.company, website: leads.website, status: leads.status }).from(leads);
    const clientNames = new Set(rows.map((r) => normCompany(r.company)));
    const clientDomains = new Set(rows.map((r) => r.website).filter(Boolean));
    const clash = allLeads.filter(
      (l) => l.status !== 'Contacted' && (clientNames.has(normCompany(l.company)) || (l.website && clientDomains.has(domainOf(l.website)))),
    );
    if (clash.length) await db.update(leads).set({ status: 'Existing Client' }).where(inArray(leads.id, clash.map((l) => l.id)));
  }
  revalidatePath('/targets');
  return { message: rows.length ? `Added ${rows.length} ${rows.length === 1 ? 'client' : 'clients'}.` : 'Nothing new to add.' };
}

export async function updateClientAction(form: FormData) {
  const db = await getDb();
  await db
    .update(clients)
    .set({ website: domainOf(str(form, 'website')), industry: str(form, 'industry'), whyBought: str(form, 'whyBought') })
    .where(eq(clients.id, Number(str(form, 'id'))));
  revalidatePath('/targets');
}

export async function deleteClientAction(form: FormData) {
  const db = await getDb();
  await db.delete(clients).where(eq(clients.id, Number(str(form, 'id'))));
  revalidatePath('/targets');
}

// ─── Settings ─────────────────────────────────────────────────────────────

export async function saveSettingsAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  const db = await getDb();
  const current = await getSettings(db);
  const provider = str(form, 'aiProvider') as 'deepseek' | 'anthropic';
  let model = str(form, 'aiModel');
  // Switching provider without touching the model: use that provider's default model.
  if (provider !== current.aiProvider && model === current.aiModel) model = DEFAULT_MODELS[provider] ?? model;
  const parsed = settingsSchema.safeParse({
    dailyLimit: str(form, 'dailyLimit'),
    minScore: str(form, 'minScore'),
    maxEmailGuesses: str(form, 'maxEmailGuesses'),
    prospectsPerRun: str(form, 'prospectsPerRun'),
    prospectDay: str(form, 'prospectDay'),
    aiProvider: provider,
    aiModel: model,
    aiEffort: str(form, 'aiEffort'),
    senderName: str(form, 'senderName'),
    senderTitle: str(form, 'senderTitle'),
    senderCompany: str(form, 'senderCompany'),
    demoLink: str(form, 'demoLink'),
    productDescription: str(form, 'productDescription'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue.path.join('.')}: ${issue.message}` };
  }
  await saveSettings(db, parsed.data);
  revalidatePath('/settings');
  return { ok: true, message: 'Saved.' };
}
