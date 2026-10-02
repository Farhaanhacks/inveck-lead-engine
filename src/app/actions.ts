'use server';

import { after } from 'next/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { activities, clients, icps, leads, opportunities, people, PIPELINE_STAGES, runs, type LeadStatus, type PipelineStage } from '@/lib/db/schema';
import { addOpportunityAsLead, scanRadar } from '@/lib/pipeline/radar';
import { applyStage } from '@/lib/stages';
import { makePrimary } from '@/lib/people';
import { logActivity } from '@/lib/activity';
import { draftFollowUp, FOLLOW_UP_DAYS, nextFollowUpAt } from '@/lib/pipeline/follow-ups';
import { findSignals } from '@/lib/pipeline/signals';
import { appPassword, createSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';
import { assignUnowned } from '@/lib/assign';
import { recordPresence } from '@/lib/attendance';
import { getCurrentUser, verifyLogin } from '@/lib/users';
import { mayActOn, ownedIds, requireAdmin } from '@/lib/access';
import { driveRun, liveServices } from '@/lib/run-driver';
import { KnownBranches } from '@/lib/branches';
import { newContactNamed } from '@/lib/escalate';
import { redraftForContact } from '@/lib/pipeline/redraft';
import { startRun } from '@/lib/runs';
import { DEFAULT_MODELS, getSettings, saveSettings, settingsSchema } from '@/lib/settings';
import { domainOf } from '@/lib/pipeline/text';
import { CLIENT_FIELDS, describeImport, importClients, markClientLeads, rowsToClients, type ClientField } from '@/lib/clients';
import { parseCsv } from '@/lib/csv';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

// ─── Login ────────────────────────────────────────────────────────────────

/**
 * Team members log in with name@inveck and their own password. A blank username (or "admin")
 * with the shared APP_PASSWORD is the admin login, which sees everything.
 */
export async function login(_prev: { error: string } | undefined, form: FormData) {
  const username = str(form, 'username');
  const password = String(form.get('password') ?? '');
  let subject = '';
  if (!username || username.toLowerCase() === 'admin') {
    if (!appPassword()) return { error: 'APP_PASSWORD is not set on the server.' };
    if (password === appPassword()) subject = 'admin';
  } else {
    const db = await getDb();
    const user = await verifyLogin(db, username, password);
    if (user) {
      subject = `u${user.id}`;
      await recordPresence(db, user.id);
    }
  }
  if (!subject) return { error: 'Wrong username or password.' };
  (await cookies()).set(SESSION_COOKIE, await createSession(subject), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  // Team members start on their list for the day, unless they were sent to a page before logging in.
  const next = str(form, 'next');
  const wanted = next.startsWith('/') && !next.startsWith('//') && next !== '/' ? next : '';
  redirect(wanted || (subject === 'admin' ? '/' : '/today'));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

// ─── Runs ─────────────────────────────────────────────────────────────────

/**
 * Researches new companies right away: starts a run in the background (or lets the one
 * already running pick them up). Nobody has to press a button for it.
 */
async function researchNow() {
  const db = await getDb();
  const { run, created } = await startRun(db, { findProspects: false, trigger: 'auto' });
  if (created) {
    const h = await headers();
    const origin = `${h.get('x-forwarded-proto') || 'http'}://${h.get('host')}`;
    after(() => driveRun(run.id, origin));
  }
}

export async function startRunAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  // Who gets what the search finds: the whole team ('team'), one person (their id), or nobody yet ('').
  const to = str(form, 'prospectsTo');
  const prospectsTo = to === 'team' || /^\d+$/.test(to) ? to : '';
  const { run, created } = await startRun(db, { findProspects: str(form, 'findProspects') === 'yes', trigger: 'manual', prospectsTo });
  if (created) {
    const h = await headers();
    const origin = `${h.get('x-forwarded-proto') || 'http'}://${h.get('host')}`;
    after(() => driveRun(run.id, origin));
  }
  redirect(`/?run=${run.id}#activity`);
}

export async function stopRunAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  await db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, Number(str(form, 'id'))));
  revalidatePath('/');
}

// ─── Leads ────────────────────────────────────────────────────────────────

/** Existing leads and clients, for skipping duplicates when adding companies. */
/** Leads and clients already in the system; the same company at another city is a separate branch. */
async function knownCompanies() {
  const db = await getDb();
  return new KnownBranches(
    await db.select({ company: leads.company, website: leads.website, city: leads.city }).from(leads),
    await db.select({ company: clients.company, website: clients.website }).from(clients),
  );
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
  const city = str(form, 'city');
  const dup = known.has(company, website, city);
  if (dup === 'client') return { ok: false, message: `${company} is already a client.` };
  if (dup === 'lead') {
    return { ok: false, message: city ? `${company} in ${city} is already a lead.` : `${company} is already a lead. To add another branch, give its city.` };
  }
  const db = await getDb();
  const inbound = str(form, 'inbound') === 'yes';
  const me = await getCurrentUser();
  const [row] = await db.insert(leads).values({
    // A team member who adds a company works it; inbound leads are shared out in turn.
    ownerId: me?.role === 'bda' && !inbound ? me.id : null,
    inbound,
    company,
    website,
    city,
    segment: await matchSegment(str(form, 'segment')),
    source: inbound ? 'Inbound lead' : 'Added by hand',
    contactName: str(form, 'contactName'),
    contactTitle: str(form, 'contactTitle'),
    contactEmail: str(form, 'contactEmail'),
    contactPhone: str(form, 'contactPhone'),
    contactLinkedin: str(form, 'contactLinkedin'),
  }).returning({ id: leads.id });
  await logActivity(db, row.id, 'added', inbound ? 'Inbound lead' : 'Added by hand');
  await assignUnowned(db);
  revalidatePath('/leads');
  revalidatePath('/');
  await researchNow();
  const later = !inbound && me?.role !== 'bda';
  return {
    ok: true,
    message: later
      ? `Added ${company}. Researching it now; give it an owner on its page or in Leads.`
      : `Added ${company}. Researching it now; its calls, WhatsApp and email show on Today when it's ready.`,
  };
}

/** Bulk add: one company per line, "Company, website, city, segment" (comma or tab separated). */
export async function addLeadsBulkAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  const lines = str(form, 'bulk').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const inbound = str(form, 'inbound') === 'yes';
  const me = await getCurrentUser();
  const ownerId = me?.role === 'bda' && !inbound ? me.id : null;
  const known = await knownCompanies();
  const toAdd: (typeof leads.$inferInsert)[] = [];
  let skipped = 0;
  for (const line of lines) {
    const [company = '', website = '', city = '', segment = ''] = line.split(/\t|,/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (!company || /^company$/i.test(company)) continue;
    const domain = domainOf(website);
    if (known.has(company, domain, city)) {
      skipped++;
      continue;
    }
    known.add(company, domain, city);
    toAdd.push({ company, website: domain, city, segment: await matchSegment(segment), source: inbound ? 'Inbound lead' : 'Added by hand', inbound, ownerId });
  }
  if (toAdd.length) {
    const db = await getDb();
    const rows = await db.insert(leads).values(toAdd).returning({ id: leads.id });
    for (const r of rows) await logActivity(db, r.id, 'added', inbound ? 'Inbound lead (bulk)' : 'Added by hand (bulk)');
    await assignUnowned(db);
    await researchNow();
  }
  revalidatePath('/leads');
  revalidatePath('/');
  return {
    ok: toAdd.length > 0,
    message: `Added ${toAdd.length} ${toAdd.length === 1 ? 'company' : 'companies'}${skipped ? `, skipped ${skipped} already a lead or a client` : ''}.${toAdd.length ? ' Researching now; progress is on the dashboard.' : ''}`,
  };
}

export async function updateLeadAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
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
  replied: 'Replied',
  meeting: 'Meeting Booked',
  won: 'Won',
  lost: 'Lost',
};

function refreshLeadPages(id?: number) {
  if (id) revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/pipeline');
  revalidatePath('/');
}

export async function setLeadStatusAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const status = STATUS_ACTIONS[str(form, 'action')];
  if (!id || !status) return;
  await applyStage(await getDb(), [id], status);
  if (status === 'New') await researchNow();
  refreshLeadPages(id);
}

export async function bulkLeadAction(form: FormData) {
  const ids = await ownedIds(form.getAll('ids').map(Number).filter(Boolean));
  const action = str(form, 'action');
  if (!ids.length) return;
  const db = await getDb();
  if (action === 'delete') {
    await db.delete(leads).where(inArray(leads.id, ids));
    await db.delete(activities).where(inArray(activities.leadId, ids));
    await db.delete(people).where(inArray(people.leadId, ids));
  } else if (STATUS_ACTIONS[action]) {
    await applyStage(db, ids, STATUS_ACTIONS[action]);
    if (STATUS_ACTIONS[action] === 'New') await researchNow();
  }
  refreshLeadPages();
}

/** Won: moves the lead to Won and adds the company to the current-clients sheet. */
export async function addLeadAsClientAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  if (!id) return;
  await applyStage(await getDb(), [id], 'Won', str(form, 'whyBought'));
  refreshLeadPages(id);
  revalidatePath('/targets');
}

/** Scans the news for new plants and warehouses right now. */
export async function scanRadarAction() {
  await requireAdmin();
  const r = await scanRadar(await getDb(), await liveServices(), undefined, { force: true });
  revalidatePath('/');
  return r.error ? { ok: false, message: `The news scan failed: ${r.error}` } : { ok: true, message: r.added ? `Found ${r.added} new opening${r.added === 1 ? '' : 's'}.` : 'No new openings since the last scan.' };
}

/** A new facility from the news becomes a lead, with the article as its buying signal. */
export async function addOpportunityAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  const leadId = await addOpportunityAsLead(db, Number(str(form, 'id')));
  if (leadId) {
    await assignUnowned(db);
    await researchNow();
  }
  refreshLeadPages();
}

export async function dismissOpportunityAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  await db.update(opportunities).set({ status: 'dismissed' }).where(eq(opportunities.id, Number(str(form, 'id'))));
  revalidatePath('/');
}

/** Makes someone else at the company the lead's main contact. */
export async function makePrimaryAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const db = await getDb();
  const leadId = await makePrimary(db, Number(str(form, 'personId')));
  if (leadId) {
    // A new point of contact: the tier is worked out again, calls count afresh, and the email is rewritten for them.
    await db.update(leads).set({ contactTier: '' }).where(eq(leads.id, leadId));
    await newContactNamed(db, leadId);
    after(async () => redraftForContact(await getDb(), await liveServices(), leadId));
    refreshLeadPages(leadId);
    revalidatePath('/today');
  }
  revalidatePath('/contacts');
}

/** Drag and drop on the pipeline board. */
export async function moveLeadStageAction(id: number, stage: PipelineStage) {
  if (!(await mayActOn(id))) return { ok: false };
  if (!Number.isInteger(id) || !PIPELINE_STAGES.includes(stage)) return { ok: false };
  await applyStage(await getDb(), [id], stage);
  refreshLeadPages(id);
  if (stage === 'Won') revalidatePath('/targets');
  return { ok: true };
}

/** A note, call or meeting logged by the team on the lead's timeline. */
export async function addActivityAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const kind = str(form, 'kind');
  const text = str(form, 'text');
  if (!id || !text || !['note', 'call', 'meeting'].includes(kind)) return;
  await logActivity(await getDb(), id, kind as 'note' | 'call' | 'meeting', text);
  refreshLeadPages(id);
}

/** Writes the next follow-up now instead of waiting for the next run. */
export async function writeFollowUpAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead || lead.status !== 'Contacted' || lead.followUpStep >= FOLLOW_UP_DAYS.length) return;
  const r = await draftFollowUp(db, await liveServices(), lead);
  if (!r.ok) await logActivity(db, id, 'error', `Couldn't draft the follow-up: ${r.error}`);
  refreshLeadPages(id);
}

/** The follow-up (as edited) has been sent: schedule the next one, if any. */
export async function sendFollowUpAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const skip = str(form, 'skip') === '1';
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead || lead.status !== 'Contacted') return;
  const step = lead.followUpStep + 1;
  const subject = str(form, 'followUpSubject') || lead.followUpSubject;
  await db
    .update(leads)
    .set({
      followUpStep: step,
      nextFollowUpAt: lead.sentAt ? nextFollowUpAt(lead.sentAt, step) : null,
      followUpSubject: '',
      followUpBody: '',
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
  await logActivity(db, id, skip ? 'note' : 'follow_up_sent', skip ? `Follow-up ${step} skipped` : `Follow-up ${step} sent${subject ? `: “${subject}”` : ''}`);
  refreshLeadPages(id);
}

/** Looks for fresh buying signals for one lead. */
export async function refreshSignalsAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) return;
  const { signals, error } = await findSignals(await liveServices(), lead.company);
  if (error) await logActivity(db, id, 'error', `News search failed: ${error}`);
  else {
    const known = new Set(lead.signals.map((s) => s.url));
    for (const s of signals) if (!known.has(s.url)) await logActivity(db, id, 'signal', `${s.headline}${s.source ? ` (${s.source}${s.date ? `, ${s.date}` : ''})` : ''}`);
    await db.update(leads).set({ signals, signalsCheckedAt: new Date() }).where(eq(leads.id, id));
  }
  refreshLeadPages(id);
}

export async function deleteLeadAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const db = await getDb();
  const id = Number(str(form, 'id'));
  await db.delete(leads).where(eq(leads.id, id));
  await db.delete(activities).where(eq(activities.leadId, id));
  await db.delete(people).where(eq(people.leadId, id));
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
    p2Titles: str(form, 'p2Titles'),
    p3Titles: str(form, 'p3Titles'),
    avoidTitles: str(form, 'avoidTitles'),
    pitchAngle: str(form, 'pitchAngle'),
  };
}

export async function saveIcpAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  const id = Number(str(form, 'id'));
  const fields = icpFields(form);
  if (!fields.segment) return;
  if (id) await db.update(icps).set(fields).where(eq(icps.id, id));
  else await db.insert(icps).values(fields);
  revalidatePath('/targets');
}

export async function deleteIcpAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  await db.delete(icps).where(eq(icps.id, Number(str(form, 'id'))));
  revalidatePath('/targets');
}

/** The last row of the client grid: one client typed in by hand. */
export async function addClientsAction(_prev: { message: string } | undefined, form: FormData) {
  await requireAdmin();
  const records = rowsToClients([[str(form, 'company'), str(form, 'website'), str(form, 'industry'), str(form, 'whyBought')]], { header: false });
  if (!records.length) return { message: 'Type a company name first.' };
  const result = await importClients(await getDb(), records);
  revalidatePath('/targets');
  return { message: describeImport(result) };
}

/** Rows pasted from Excel or Google Sheets (tab separated), or any CSV text. */
export async function importClientsTextAction(text: string) {
  await requireAdmin();
  const rows = parseCsv(String(text ?? '').slice(0, 2_000_000));
  if (!rows.length) return { ok: false, message: 'Nothing to import.' };
  const result = await importClients(await getDb(), rowsToClients(rows));
  revalidatePath('/targets');
  return { ok: true, message: describeImport(result) };
}

/** A CSV file exported from Excel, Google Sheets, Airtable or a CRM. */
export async function importClientsFileAction(form: FormData) {
  await requireAdmin();
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Choose a CSV file.' };
  if (file.size > 2_000_000) return { ok: false, message: 'That file is over 2 MB. Split it into smaller files.' };
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  // .xlsx files are zip archives ("PK…"); old .xls files start with D0 CF.
  if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    return { ok: false, message: 'That’s an Excel file. In Excel choose File → Save As → CSV (UTF-8), then upload the CSV.' };
  }
  return importClientsTextAction(await file.text());
}

/** One cell edited in the client grid. */
export async function updateClientFieldAction(id: number, field: ClientField, value: string) {
  await requireAdmin();
  if (!Number.isInteger(id) || !CLIENT_FIELDS.includes(field)) return { ok: false, value: '', message: 'Unknown cell.' };
  let v = String(value ?? '').trim().slice(0, 1000);
  if (field === 'website') v = domainOf(v);
  if (field === 'company' && !v) return { ok: false, value: '', message: 'Company can’t be empty.' };
  const db = await getDb();
  const [row] = await db.update(clients).set({ [field]: v }).where(eq(clients.id, id)).returning();
  if (!row) return { ok: false, value: '', message: 'That client no longer exists. Reload the page.' };
  // A new name or website can match a lead that must not be cold-emailed.
  if (field === 'company' || field === 'website') await markClientLeads(db, [row]);
  return { ok: true, value: v };
}

export async function removeClientAction(id: number) {
  await requireAdmin();
  if (!Number.isInteger(id)) return;
  const db = await getDb();
  await db.delete(clients).where(eq(clients.id, id));
  revalidatePath('/targets');
}

// ─── Settings ─────────────────────────────────────────────────────────────

export async function saveSettingsAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  await requireAdmin();
  const db = await getDb();
  const current = await getSettings(db);
  const provider = str(form, 'aiProvider') as 'deepseek' | 'anthropic';
  let model = str(form, 'aiModel');
  // Switching provider without touching the model: use that provider's default model.
  if (provider !== current.aiProvider && model === current.aiModel) model = DEFAULT_MODELS[provider] ?? model;
  const parsed = settingsSchema.safeParse({
    maxEmailGuesses: str(form, 'maxEmailGuesses'),
    useCompanyFormat: form.get('useCompanyFormat') === 'on',
    radarEnabled: form.get('radarEnabled') === 'on',
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
