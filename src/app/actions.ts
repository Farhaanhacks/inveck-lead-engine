'use server';

import { after } from 'next/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { activities, clients, icps, knownCompanies as ownLeadList, leads, opportunities, people, tasks, PIPELINE_STAGES, runs, type LeadStatus, type PipelineStage, whatsappContacts } from '@/lib/db/schema';
import { addOpportunityAsLead, scanRadar } from '@/lib/pipeline/radar';
import { applyStage } from '@/lib/stages';
import { makePrimary } from '@/lib/people';
import { logActivity } from '@/lib/activity';
import { draftFollowUp } from '@/lib/pipeline/follow-ups';
import { junkIfComplete, nextEmailRound, rescheduleFollowUps, restoreLead } from '@/lib/follow-up-sequence';
import { getHolidays, saveHolidays, validDay } from '@/lib/holidays';
import { markCompanyDay } from '@/lib/tasks';
import { findSignals } from '@/lib/pipeline/signals';
import { appPassword, createSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';
import { assignUnowned } from '@/lib/assign';
import { recordPresence } from '@/lib/attendance';
import { getCurrentUser, listBdas, requireUser, verifyLogin } from '@/lib/users';
import { importContactSheet, parseContactSheet } from '@/lib/contact-import';
import { cleanPhone } from '@/lib/tracker';
import { mayActOn, ownedIds, requireAdmin } from '@/lib/access';
import { driveRun, liveServices } from '@/lib/run-driver';
import { KnownBranches } from '@/lib/branches';
import { escalate, newContactNamed } from '@/lib/escalate';
import { redraftForContact } from '@/lib/pipeline/redraft';
import { startRun } from '@/lib/runs';
import { DEFAULT_MODELS, getSettings, saveSettings, settingsSchema } from '@/lib/settings';
import { domainOf } from '@/lib/pipeline/text';
import { CLIENT_FIELDS, describeImport, importClients, markClientLeads, rowsToClients, type ClientField } from '@/lib/clients';
import { parseCsv } from '@/lib/csv';
import { describeKnownImport, importKnownCompanies, setAsideOwnLeads } from '@/lib/known-companies';
import { OWN_LEAD_REASON } from '@/lib/pipeline/process-lead';
import { canonicalSegment, normSegment } from '@/lib/icp-match';
import { confirmFit, markNotFit, reassessLeads, recordAssessments } from '@/lib/reassess';
import { cleanContact, contactFields, saveContactEdit } from '@/lib/contact-edit';

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
  // Who gets what the search finds: the morning draw (''), the whole team now ('team') or one person (their id).
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

/** The ICP's own spelling of a segment typed in; one no ICP has is kept as typed and flagged for review at research. */
async function matchSegment(segment: string) {
  const db = await getDb();
  const names = (await db.select({ segment: icps.segment }).from(icps)).map((r) => r.segment);
  return canonicalSegment(segment, names);
}

/** Who did something, for the timeline. */
async function actorName(): Promise<string> {
  return (await getCurrentUser())?.name || 'someone';
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
    contactPhone: str(form, 'contactPhone'),
    contactLinkedin: str(form, 'contactLinkedin'),
    // P1, P2 or P3 when the team chose one; else worked out from the title.
    contactTier: chosenTier(str(form, 'contactTier')),
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
      ? `Added ${company} to the list. Researching it now; it goes to someone in a morning draw.`
      : `Added ${company}. Researching it now; its calls, WhatsApp and email show on Today when it's ready.`,
  };
}

const chosenTier = (v: string) => (['P1', 'P2', 'P3'].includes(v) ? v : '');

/** Bulk add: one company per line, "Company, website, city, segment" (comma or tab separated). */
export async function addLeadsBulkAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  const lines = str(form, 'bulk').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const inbound = str(form, 'inbound') === 'yes';
  // Lines that name no segment use the one chosen for the whole paste.
  const fallbackSegment = str(form, 'segment');
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
    toAdd.push({ company, website: domain, city, segment: await matchSegment(segment || fallbackSegment), source: inbound ? 'Inbound lead' : 'Added by hand', inbound, ownerId });
  }
  const db = await getDb();
  const names = (await db.select({ segment: icps.segment, active: icps.active }).from(icps)).filter((i) => i.active).map((i) => normSegment(i.segment));
  const unmatched = [...new Set(toAdd.map((l) => l.segment ?? '').filter((s) => !names.includes(normSegment(s))))];
  if (toAdd.length) {
    const rows = await db.insert(leads).values(toAdd).returning({ id: leads.id });
    for (const r of rows) await logActivity(db, r.id, 'added', inbound ? 'Inbound lead (bulk)' : 'Added by hand (bulk)');
    await assignUnowned(db);
    await researchNow();
  }
  revalidatePath('/leads');
  revalidatePath('/');
  return {
    ok: toAdd.length > 0,
    message:
      `Added ${toAdd.length} ${toAdd.length === 1 ? 'company' : 'companies'}${skipped ? `, skipped ${skipped} already a lead or a client` : ''}.${toAdd.length ? ' Researching now; progress is on the dashboard.' : ''}` +
      (unmatched.length && toAdd.length
        ? ` Segment ${unmatched.map((s) => `"${s || 'none'}"`).join(', ')} matches no active ICP: those companies wait in Needs Review until a segment is chosen.`
        : ''),
  };
}

/**
 * A CSV of companies with their points of contact (the team's researched list: firm, phone, email,
 * partners and their LinkedIn profiles). Each becomes a lead with every point of contact; the owner is
 * the morning draw's, everyone in turn now, or one person.
 */
export async function importContactSheetAction(_prev: { message: string; ok: boolean } | undefined, form: FormData) {
  const me = await requireUser();
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Choose a CSV file.' };
  if (file.size > 5_000_000) return { ok: false, message: 'That file is over 5 MB. Split it into smaller files.' };
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    return { ok: false, message: 'That’s an Excel file. In Excel choose File → Save As → CSV (UTF-8), then upload the CSV.' };
  }
  const segment = await matchSegment(str(form, 'segment'));
  if (!segment) return { ok: false, message: 'Choose the segment these companies belong to.' };
  const parsed = parseContactSheet(parseCsv(await file.text()));
  if (parsed.error) return { ok: false, message: parsed.error };
  const db = await getDb();
  const team = await listBdas(db);
  const assign = str(form, 'assign');
  // A team member's own import is theirs unless they choose otherwise.
  const one = Number(assign) || (assign === '' && me.role === 'bda' ? me.id : 0);
  const known = await knownCompanies();
  let turn = 0;
  let added = 0;
  const skipped: string[] = [];
  for (const row of parsed.rows) {
    const ownerId = one ? (team.some((b) => b.id === one) || one === me.id ? one : null) : assign === 'split' && team.length ? team[turn % team.length].id : null;
    const r = await importContactSheet(db, [row], { segment, ownerId, known, by: me.name });
    added += r.added;
    skipped.push(...r.skipped);
    if (r.added) turn++;
  }
  if (added) {
    await researchNow();
    revalidatePath('/today');
  }
  revalidatePath('/leads');
  revalidatePath('/tracker');
  revalidatePath('/');
  const who = one ? `for ${team.find((b) => b.id === one)?.name ?? me.name}` : assign === 'split' ? 'shared out between the team' : 'for the morning draw';
  return {
    ok: added > 0,
    message:
      `Added ${added} ${added === 1 ? 'company' : 'companies'} with their points of contact, ${who}.` +
      (skipped.length ? ` Skipped ${skipped.length} already a lead or a client: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}.` : '') +
      (added ? ' Their emails are being written now; they show on Today once ready.' : ''),
  };
}

/** Another point of contact at the company: someone else, another number, another email or LinkedIn. */
export async function addPointOfContactAction(form: FormData) {
  const leadId = Number(str(form, 'id'));
  if (!(await mayActOn(leadId))) return;
  const name = str(form, 'name').slice(0, 200);
  const phone = cleanPhone(str(form, 'phone'));
  const email = str(form, 'email').slice(0, 200);
  const linkedinRaw = str(form, 'linkedin').slice(0, 500);
  const linkedin = linkedinRaw && !/^https?:\/\//i.test(linkedinRaw) ? `https://${linkedinRaw.replace(/^\/+/, '')}` : linkedinRaw;
  if (phone === null) return;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  if (linkedin && !/linkedin\.com\//i.test(linkedin)) return;
  if (!name && !phone && !email && !linkedin) return;
  const db = await getDb();
  const [lead] = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId));
  if (!lead) return;
  const label = name || (phone ? 'Other number' : email ? 'Other email' : 'LinkedIn profile');
  await db.insert(people).values({ leadId, name: label, title: str(form, 'title').slice(0, 200), tier: chosenTier(str(form, 'tier')), phone, email, linkedin, source: 'Added by the team', evidence: 'Added by the team' });
  await logActivity(db, leadId, 'note', `Point of contact added by ${await actorName()}: ${[label, phone, email, linkedin].filter(Boolean).join(' · ')}`);
  refreshLeadPages(leadId);
  revalidatePath('/today');
}

export async function updateLeadAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!id || !(await mayActOn(id))) return;
  const company = str(form, 'company');
  const contact = cleanContact(contactFields(form));
  // Nothing is saved from a form with no company name or an email that isn't one.
  if (!company || !contact) return;
  const db = await getDb();
  const [before] = await db.select({ emailBody: leads.emailBody, company: leads.company, nameAsFound: leads.nameAsFound, fitDecision: leads.fitDecision }).from(leads).where(eq(leads.id, id));
  if (!before) return;
  const emailBody = String(form.get('emailBody') ?? '');
  await db
    .update(leads)
    .set({
      company,
      // A name the team typed in is theirs: research keeps it (the earlier one is kept as an alias).
      ...(company !== before.company ? { nameEvidence: 'set by the team', nameAsFound: before.nameAsFound || before.company } : {}),
      // Saved unchanged while the name was in question: the team confirms it.
      ...(company === before.company && before.fitDecision.includes("company name isn't confirmed") ? { nameEvidence: 'set by the team' } : {}),
      website: domainOf(str(form, 'website')),
      city: str(form, 'city'),
      segment: str(form, 'segment'),
      emailSubject: str(form, 'emailSubject'),
      emailBody,
      linkedinMessage: String(form.get('linkedinMessage') ?? ''),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
  // The contact goes through the same path as Today's contact form: people list, confirmation,
  // timeline. A new person gets an email written to them, unless the draft was edited in this save.
  const saved = await saveContactEdit(db, id, contact);
  if (saved?.newPerson && emailBody === before.emailBody) after(async () => redraftForContact(await getDb(), await liveServices(), id));
  refreshLeadPages(id);
  revalidatePath('/today');
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
  // Research again keeps what the fit was judged before on the timeline.
  if (status === 'New') await recordAssessments(await getDb(), [id], await actorName());
  await applyStage(await getDb(), [id], status);
  // Research again: a fresh set of attempts.
  if (status === 'New') await (await getDb()).update(leads).set({ researchAttempts: 0 }).where(eq(leads.id, id));
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
    // Their planned calls and messages go too: nothing is due for a company that's gone.
    await db.delete(tasks).where(inArray(tasks.leadId, ids));
  } else if (action === 'restore') {
    for (const id of ids) await restoreLead(db, id, await actorName());
  } else if (action === 'reassess') {
    if (await reassessLeads(db, ids, await actorName())) await researchNow();
  } else if (STATUS_ACTIONS[action]) {
    if (STATUS_ACTIONS[action] === 'New') await recordAssessments(db, ids, await actorName());
    await applyStage(db, ids, STATUS_ACTIONS[action]);
    if (STATUS_ACTIONS[action] === 'New') await db.update(leads).set({ researchAttempts: 0 }).where(inArray(leads.id, ids));
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

/**
 * Reassess fit: a company ruled out or waiting on review is researched again under the evidence
 * rules. Its earlier assessment stays on the timeline; nothing else about the lead is reset.
 */
export async function reassessFitAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!(await mayActOn(id))) return;
  if (await reassessLeads(await getDb(), [id], await actorName())) await researchNow();
  refreshLeadPages(id);
}

/** A person confirms the company fits: contacts are found and drafts written, keeping their call. */
export async function confirmFitAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!(await mayActOn(id))) return;
  if (await confirmFit(await getDb(), id, await actorName(), str(form, 'note').slice(0, 500))) await researchNow();
  refreshLeadPages(id);
}

/** A person decides a company waiting on review isn't a fit. */
export async function markNotFitAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!(await mayActOn(id))) return;
  await markNotFit(await getDb(), id, await actorName(), str(form, 'note').slice(0, 500));
  refreshLeadPages(id);
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
  const leadId = await makePrimary(db, Number(str(form, 'personId')), { byTeam: true });
  if (leadId) {
    // A new point of contact: their tier comes with them (the one the team chose, else worked out from
    // the title, see makePrimary), calls count afresh, and the email is rewritten for them.
    await newContactNamed(db, leadId);
    after(async () => redraftForContact(await getDb(), await liveServices(), leadId));
    refreshLeadPages(leadId);
    revalidatePath('/today');
  }
  revalidatePath('/contacts');
}

/**
 * The team found that someone no longer works at the company (their LinkedIn shows an end date
 * Google hadn't picked up). They are removed; if they were the main contact, the next confirmed
 * person at the company takes over and the email is rewritten for them.
 */
export async function markLeftAction(form: FormData) {
  const leadId = Number(str(form, 'id'));
  if (!(await mayActOn(leadId))) return;
  const db = await getDb();
  const [person] = await db.select().from(people).where(eq(people.id, Number(str(form, 'personId'))));
  if (!person || person.leadId !== leadId) return;
  if (person.isPrimary) {
    const r = await escalate(db, leadId, 'left', new Date(), 'marked by the team');
    if (r.switched) after(async () => redraftForContact(await getDb(), await liveServices(), leadId));
  } else {
    await db.delete(people).where(eq(people.id, person.id));
    await logActivity(db, leadId, 'note', `${person.name} no longer works at the company (marked by the team); removed from the people to contact.`);
  }
  refreshLeadPages(leadId);
  revalidatePath('/today');
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

/** Writes the draft for the lead's next follow-up email now instead of waiting for the next run. */
export async function writeFollowUpAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead || lead.status === 'Deleted' || !(await nextEmailRound(db, id))) return;
  const r = await draftFollowUp(db, await liveServices(), lead);
  if (!r.ok) await logActivity(db, id, 'error', `Couldn't draft the follow-up: ${r.error}`);
  refreshLeadPages(id);
}

/**
 * The next follow-up email (as edited) has been sent by hand, or is skipped: its step is logged as done
 * and the draft is used up. Nothing is ever sent from here.
 */
export async function sendFollowUpAction(form: FormData) {
  if (!(await mayActOn(Number(str(form, 'id'))))) return;
  const id = Number(str(form, 'id'));
  const skip = str(form, 'skip') === '1';
  const db = await getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  const task = lead && lead.status !== 'Deleted' ? await nextEmailRound(db, id) : null;
  if (!lead || !task) return;
  const subject = str(form, 'followUpSubject') || lead.followUpSubject;
  const now = new Date();
  await db
    .update(tasks)
    .set({ doneAt: now, outcome: skip ? 'skipped' : 'done', followUpFrom: skip ? '' : JSON.stringify({ subject: lead.followUpSubject, body: lead.followUpBody, step: lead.followUpStep }) })
    .where(and(eq(tasks.id, task.id), isNull(tasks.doneAt)));
  await db
    .update(leads)
    .set({ followUpSubject: '', followUpBody: '', ...(skip ? {} : { followUpStep: task.followUpRound, mailOutcome: ['', 'Not sent'].includes(lead.mailOutcome) ? 'Sent' : lead.mailOutcome }), updatedAt: now })
    .where(eq(leads.id, id));
  await logActivity(db, id, skip ? 'note' : 'follow_up_sent', skip ? `Follow-up ${task.followUpRound} skipped` : `Follow-up ${task.followUpRound} sent${subject ? `: “${subject}”` : ''}`);
  await junkIfComplete(db, id, now);
  await markCompanyDay(db, id, task.ownerId);
  refreshLeadPages(id);
  revalidatePath('/today');
  revalidatePath('/followups');
}

/** Puts a Deleted lead back at the stage it was in (its history was never removed). */
export async function restoreLeadAction(form: FormData) {
  const id = Number(str(form, 'id'));
  if (!(await mayActOn(id))) return;
  await restoreLead(await getDb(), id, await actorName());
  refreshLeadPages(id);
  revalidatePath('/followups');
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
  await db.delete(tasks).where(eq(tasks.leadId, id));
  // Its WhatsApp number is no longer this company's: a message from it is matched afresh.
  await db.update(whatsappContacts).set({ leadId: null }).where(eq(whatsappContacts.leadId, id));
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

/** Leads whose segment is this ICP's name (ignoring case, spacing and punctuation). */
async function leadsOfSegment(segment: string): Promise<number[]> {
  const db = await getDb();
  const want = normSegment(segment);
  const rows = await db.select({ id: leads.id, segment: leads.segment }).from(leads);
  return rows.filter((r) => normSegment(r.segment) === want).map((r) => r.id);
}

export async function saveIcpAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  const id = Number(str(form, 'id'));
  const fields = icpFields(form);
  if (!fields.segment) return;
  // Each segment name belongs to one ICP: leads are checked against the ICP their segment names.
  const all = await db.select({ id: icps.id, segment: icps.segment }).from(icps);
  const clash = all.find((i) => i.id !== id && normSegment(i.segment) === normSegment(fields.segment));
  if (clash) redirect(`/targets?icpError=${encodeURIComponent(`Another ICP is already called "${clash.segment}". Give each ICP its own name.`)}`);
  const before = all.find((i) => i.id === id);
  if (id) await db.update(icps).set(fields).where(eq(icps.id, id));
  else await db.insert(icps).values(fields);
  // Renamed: its leads keep it (their segment is its name).
  if (before && before.segment !== fields.segment) {
    const moved = await leadsOfSegment(before.segment);
    for (let i = 0; i < moved.length; i += 500) await db.update(leads).set({ segment: fields.segment }).where(inArray(leads.id, moved.slice(i, i + 500)));
  }
  revalidatePath('/targets');
  revalidatePath('/leads');
}

export async function deleteIcpAction(form: FormData) {
  await requireAdmin();
  const db = await getDb();
  const id = Number(str(form, 'id'));
  const [icp] = await db.select().from(icps).where(eq(icps.id, id));
  if (!icp) return;
  // Its leads would be left with a segment no ICP has: switching it off keeps them readable.
  const using = await leadsOfSegment(icp.segment);
  if (using.length) {
    redirect(`/targets?icpError=${encodeURIComponent(`${using.length} lead${using.length === 1 ? ' uses' : 's use'} the "${icp.segment}" ICP. Switch it off (untick Active) instead of deleting it.`)}`);
  }
  await db.delete(icps).where(eq(icps.id, id));
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

/** A CSV of the companies already in INVECK's own lead lists: the prospect search and radar skip them. */
export async function importKnownCompaniesAction(form: FormData) {
  await requireAdmin();
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) return { ok: false, message: 'Choose a CSV file.' };
  if (file.size > 5_000_000) return { ok: false, message: 'That file is over 5 MB. Split it into smaller files.' };
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    return { ok: false, message: 'That’s an Excel file. In Excel choose File → Save As → CSV (UTF-8), then upload the CSV.' };
  }
  // Blank rows kept: in the team's sheet a blank row ends a company's list of plants (merged cells).
  const text = (await file.text()).slice(0, 5_000_000);
  const rows = parseCsv(text, undefined, { keepBlank: true });
  if (rows.length < 2) return { ok: false, message: 'Nothing to import: the file needs a header row and at least one company.' };
  const db = await getDb();
  const result = await importKnownCompanies(db, rows);
  // Leads already found that turn out to be theirs (not contacted yet) are set aside.
  const setAside = await setAsideOwnLeads(db, OWN_LEAD_REASON);
  revalidatePath('/targets');
  revalidatePath('/leads');
  revalidatePath('/');
  const also = setAside.length ? ` ${setAside.length} lead${setAside.length === 1 ? '' : 's'} already found ${setAside.length === 1 ? 'is' : 'are'} on it and set aside: ${setAside.slice(0, 5).join(', ')}${setAside.length > 5 ? '…' : ''}.` : '';
  return { ok: true, message: describeKnownImport(result) + also };
}

/** Empties the list of companies from INVECK's own lead lists. */
export async function clearKnownCompaniesAction() {
  await requireAdmin();
  await (await getDb()).delete(ownLeadList);
  revalidatePath('/targets');
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
    manufacturingPerAssociate: str(form, 'manufacturingPerAssociate'),
    logisticsPerAssociate: str(form, 'logisticsPerAssociate'),
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
    waTemplateName: str(form, 'waTemplateName'),
    waTemplateLanguage: str(form, 'waTemplateLanguage') || 'en',
    waTemplateText: str(form, 'waTemplateText'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue.path.join('.')}: ${issue.message}` };
  }
  await saveSettings(db, parsed.data);
  revalidatePath('/settings');
  return { ok: true, message: 'Saved.' };
}

/**
 * Marks a date as a holiday: like a weekend, it never counts as a follow-up day. Follow-ups already
 * planned are moved on to the next working days (steps already done stay where they are).
 */
export async function addHolidayAction(form: FormData) {
  await requireAdmin();
  const day = str(form, 'day');
  if (!validDay(day)) return;
  const db = await getDb();
  await saveHolidays(db, [...(await getHolidays(db)), day]);
  await rescheduleFollowUps(db);
  for (const p of ['/settings', '/today', '/followups']) revalidatePath(p);
}

/** Takes a holiday off the list: follow-ups planned around it go back to counting that day. */
export async function removeHolidayAction(form: FormData) {
  await requireAdmin();
  const day = str(form, 'day');
  const db = await getDb();
  const days = await getHolidays(db);
  days.delete(day);
  await saveHolidays(db, days);
  await rescheduleFollowUps(db);
  for (const p of ['/settings', '/today', '/followups']) revalidatePath(p);
}
