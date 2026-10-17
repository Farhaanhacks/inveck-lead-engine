import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { leads, people, whatsappContacts, whatsappMessages, type Lead, type WhatsappContact, type WhatsappMessage } from '../db/schema';
import { logActivity } from '../activity';
import { formatDate } from '../dates';
import { waNumber } from '../phones';
import type { Settings } from '../settings';
import { firstName } from '../talk';
import { sendWhatsApp, WaError, type WaConfig } from './cloud';

/** After someone's last message, WhatsApp lets a business write freely for 24 hours; otherwise only an approved template. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * The template goes again to someone who hasn't replied only after this long: the same message again
 * and again gets INVECK's number blocked and reported, and Meta then limits or bans it.
 */
export const TEMPLATE_AGAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** How someone can agree, as the team logs it on the company page. */
export const CONSENT_WAYS = ['On a call', 'By email', 'In person or at an event', 'On a form', 'Other'] as const;
export const ON_A_CALL = 'On a call';
export const THEY_MESSAGED = 'They messaged INVECK on WhatsApp';
/** The Today step a call adds when they agree: the details go on WhatsApp that day. */
export const WA_DETAILS_STEP = 'WhatsApp details';

type ConsentState = Pick<WhatsappContact, 'consentAt' | 'optedOutAt'>;
/** INVECK's number may message them: they agreed and haven't asked to stop. */
export const canMessage = (c: ConsentState | null | undefined): boolean => !!c?.consentAt && !c.optedOutAt;

/** Until when a free-text message may go (24 hours after their last message), or null. */
export function freeUntil(c: Pick<WhatsappContact, 'lastInboundAt'> | null | undefined, now = new Date()): Date | null {
  if (!c?.lastInboundAt) return null;
  const until = new Date(c.lastInboundAt.getTime() + WINDOW_MS);
  return until > now ? until : null;
}

export async function waContacts(db: Db, waIds: string[]): Promise<Map<string, WhatsappContact>> {
  const ids = [...new Set(waIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(whatsappContacts).where(inArray(whatsappContacts.waId, ids));
  return new Map(rows.map((r) => [r.waId, r]));
}

/** They agreed to hear from INVECK on WhatsApp: kept with when, how and who logged it. Agreeing again lifts a STOP. */
export async function recordConsent(
  db: Db,
  a: { waId: string; leadId: number | null; how: string; by: { id: number; name: string } | null; taskId?: number; at?: Date },
): Promise<void> {
  const at = a.at ?? new Date();
  const set = { consentAt: at, consentBy: a.by?.id ?? null, consentHow: a.how, consentTaskId: a.taskId ?? null, optedOutAt: null, updatedAt: at, ...(a.leadId ? { leadId: a.leadId } : {}) };
  await db.insert(whatsappContacts).values({ waId: a.waId, ...set }).onConflictDoUpdate({ target: whatsappContacts.waId, set });
  if (a.leadId) await logActivity(db, a.leadId, 'note', `Agreed to WhatsApp messages from INVECK on +${a.waId} (${a.how.toLowerCase()}${a.by ? `, logged by ${a.by.name}` : ''})`);
}

/** A mark made in error: INVECK's number stops messaging them until they agree again. */
export async function removeConsent(db: Db, waId: string, leadId: number, byName: string): Promise<void> {
  await db.update(whatsappContacts).set({ consentAt: null, consentBy: null, consentHow: '', consentTaskId: null, updatedAt: new Date() }).where(eq(whatsappContacts.waId, waId));
  await logActivity(db, leadId, 'note', `WhatsApp agreement for +${waId} removed by ${byName}`);
}

/** Undoing a call takes back the agreement logged on it. */
export async function undoCallConsent(db: Db, taskId: number): Promise<void> {
  await db
    .update(whatsappContacts)
    .set({ consentAt: null, consentBy: null, consentHow: '', consentTaskId: null, updatedAt: new Date() })
    .where(eq(whatsappContacts.consentTaskId, taskId));
}

/**
 * The lead a WhatsApp number belongs to: the one it was last used with, else the latest lead or person
 * saved with that number (compared on its last ten digits, however it was written).
 */
export async function leadForNumber(db: Db, waId: string): Promise<number | null> {
  // The lead it was last used with, if that company still exists.
  const [known] = await db.select({ leadId: leads.id }).from(whatsappContacts).innerJoin(leads, eq(leads.id, whatsappContacts.leadId)).where(eq(whatsappContacts.waId, waId));
  if (known) return known.leadId;
  const last10 = waId.slice(-10);
  if (last10.length < 10) return null;
  const like = `%${last10}%`;
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(sql`regexp_replace(${leads.contactPhone}, '[^0-9]', '', 'g') LIKE ${like}`)
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  if (lead) return lead.id;
  const [person] = await db
    .select({ leadId: people.leadId })
    .from(people)
    .where(sql`regexp_replace(${people.phone}, '[^0-9]', '', 'g') LIKE ${like}`)
    .orderBy(desc(people.id))
    .limit(1);
  return person?.leadId ?? null;
}

/** How far back the replies list on Today looks. */
const REPLIES_FOR_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Messages to INVECK's number waiting for an answer (the last two weeks, newest first): those on an
 * owner's companies, and, for administrators, those from numbers on no company.
 */
export async function waitingReplies(
  db: Db,
  ownerId: number,
  withStrangers: boolean,
  now = new Date(),
): Promise<{ replies: { m: WhatsappMessage; company: string; contactName: string }[]; strangers: WhatsappMessage[] }> {
  const since = new Date(now.getTime() - REPLIES_FOR_MS);
  const waiting = and(eq(whatsappMessages.direction, 'in'), isNull(whatsappMessages.handledAt), gte(whatsappMessages.at, since));
  const [replies, strangers] = await Promise.all([
    ownerId
      ? db
          .select({ m: whatsappMessages, company: leads.company, contactName: leads.contactName })
          .from(whatsappMessages)
          .innerJoin(leads, eq(leads.id, whatsappMessages.leadId))
          .where(and(waiting, eq(leads.ownerId, ownerId)))
          .orderBy(desc(whatsappMessages.at))
          .limit(40)
      : [],
    withStrangers ? db.select().from(whatsappMessages).where(and(waiting, isNull(whatsappMessages.leadId))).orderBy(desc(whatsappMessages.at)).limit(20) : [],
  ]);
  return { replies, strangers };
}

// ─── What goes out ────────────────────────────────────────────────────────

const FIELD = /\{\{\s*(\d+)\s*\}\}/g;

/** The highest {{n}} in a template's text: how many values Meta expects with it. */
export const templateFieldCount = (text: string) => Math.max(0, ...[...text.matchAll(FIELD)].map((m) => Number(m[1])));
export const fillTemplate = (text: string, values: string[]) => text.replace(FIELD, (m, n) => values[Number(n) - 1] ?? m);
export const templateReady = (s: Pick<Settings, 'waTemplateName' | 'waTemplateText'>) => !!s.waTemplateName && !!s.waTemplateText;

/** {{1}} the contact's first name, {{2}} the sender's, {{3}} the company (tidied as WhatsApp wants: one line, no runs of spaces). */
export function templateValues(lead: Pick<Lead, 'contactName' | 'company'>, sender: string, count: number): string[] {
  const one = (v: string, fallback: string) => v.replace(/\s+/g, ' ').trim() || fallback;
  return [one(firstName(lead.contactName), 'there'), one(sender, 'INVECK'), one(lead.company, 'your team')].slice(0, count);
}

export type WaPlan = {
  /** The number it goes to, '' when there is none. */
  to: string;
  /** Why nothing can go from INVECK's number now ('' when it can). */
  problem: string;
  /** The approved template (true) or free text, while they wrote in the last 24 hours (until `freeUntil`). */
  template: boolean;
  freeUntil: Date | null;
  /** The message as it will read: the template filled in, or a starting point for free text. */
  text: string;
};

/** What INVECK's number can send the lead's contact now. */
export function planWhatsApp(lead: Pick<Lead, 'contactName' | 'company' | 'contactPhone'>, sender: string, s: Settings, contact: WhatsappContact | null | undefined, now = new Date()): WaPlan {
  const to = waNumber(lead.contactPhone);
  const until = freeUntil(contact, now);
  const filled = templateReady(s) ? fillTemplate(s.waTemplateText, templateValues(lead, sender, templateFieldCount(s.waTemplateText))) : '';
  const plan: WaPlan = { to, problem: '', template: !until, freeUntil: until, text: filled };
  if (!to) plan.problem = 'No WhatsApp number is saved for this contact.';
  else if (contact?.optedOutAt) plan.problem = `They asked not to get WhatsApp messages from INVECK (${formatDate(contact.optedOutAt)}).`;
  else if (!canMessage(contact)) plan.problem = "They haven't agreed to WhatsApp messages from INVECK yet.";
  else if (plan.template && !templateReady(s)) plan.problem = 'No approved WhatsApp template is set in Settings yet.';
  else if (plan.template && contact?.lastTemplateAt && !(contact.lastInboundAt && contact.lastInboundAt > contact.lastTemplateAt)) {
    const again = new Date(contact.lastTemplateAt.getTime() + TEMPLATE_AGAIN_MS);
    if (again > now) plan.problem = `The details already went on ${formatDate(contact.lastTemplateAt)} and they haven't replied. To keep INVECK's number in good standing, the template can go again from ${formatDate(again)}; until then, follow up by call or from your own phone.`;
  }
  return plan;
}

/**
 * Sends the lead's contact a WhatsApp from INVECK's number: the approved template, or (within 24 hours
 * of their last message) the text given. Only to someone who agreed; a Today step (`taskId`) never
 * goes twice. Their messages waiting for an answer count as answered.
 */
export async function sendFromInveck(
  db: Db,
  c: WaConfig,
  a: { lead: Lead; user: { id: number; name: string }; settings: Settings; taskId?: number; text?: string; sender?: string },
): Promise<{ error: string; body?: string }> {
  // The name the template is signed with: the sender's, or the lead's owner's when an administrator sends.
  const sender = a.sender || a.user.name;
  const to = waNumber(a.lead.contactPhone);
  const contact = to ? (await waContacts(db, [to])).get(to) : undefined;
  const plan = planWhatsApp(a.lead, sender, a.settings, contact);
  if (plan.problem) return { error: plan.problem };
  const body = (plan.template ? plan.text : (a.text ?? plan.text)).trim();
  if (!body) return { error: 'Write the message first.' };
  if (body.length > 4096) return { error: 'WhatsApp messages can be 4,096 characters at most.' };

  const [claim] = await db
    .insert(whatsappMessages)
    .values({ waId: to, leadId: a.lead.id, taskId: a.taskId ?? null, userId: a.user.id, direction: 'out', kind: plan.template ? 'template' : 'text', template: plan.template ? a.settings.waTemplateName : '', body })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });
  if (!claim) return { error: 'This WhatsApp is already being sent, or was sent. Refresh the page.' };
  try {
    const sent = await sendWhatsApp(
      c,
      plan.template
        ? { to, template: { name: a.settings.waTemplateName, language: a.settings.waTemplateLanguage, params: templateValues(a.lead, sender, templateFieldCount(a.settings.waTemplateText)) } }
        : { to, text: body },
    );
    const now = new Date();
    await db.update(whatsappMessages).set({ wamid: sent.wamid, status: 'sent', statusAt: now }).where(eq(whatsappMessages.id, claim.id));
    await db.update(whatsappMessages).set({ handledAt: now }).where(and(eq(whatsappMessages.waId, to), eq(whatsappMessages.direction, 'in'), isNull(whatsappMessages.handledAt)));
    await db
      .update(whatsappContacts)
      .set({ leadId: a.lead.id, updatedAt: now, ...(plan.template ? { lastTemplateAt: now } : {}) })
      .where(eq(whatsappContacts.waId, to));
  } catch (e) {
    await db.delete(whatsappMessages).where(eq(whatsappMessages.id, claim.id));
    if (!(e instanceof WaError)) console.error('[whatsapp] send failed:', e);
    return { error: e instanceof WaError ? e.message : `Couldn't send: ${e instanceof Error ? e.message : String(e)}` };
  }
  await logActivity(db, a.lead.id, 'note', `WhatsApp sent from INVECK's number to +${to} by ${a.user.name}${plan.template ? ` (template ${a.settings.waTemplateName})` : ''}: “${body.slice(0, 1000)}”`);
  return { error: '', body };
}
