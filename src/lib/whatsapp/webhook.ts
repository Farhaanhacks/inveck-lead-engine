import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { leads, tasks, whatsappContacts, whatsappMessages } from '../db/schema';
import { logActivity } from '../activity';
import { moveAfterOutreach } from '../stages';
import { waErrorText, type WaConfig } from './cloud';
import { leadForNumber, THEY_MESSAGED } from './contacts';

/** What Meta posts to the webhook (only the parts used here). */
type Inbound = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  reaction?: { emoji?: string };
};
type Status = { id?: string; status?: string; timestamp?: string; errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[] };
type Change = { field?: string; value?: { metadata?: { phone_number_id?: string }; contacts?: { wa_id?: string; profile?: { name?: string } }[]; messages?: Inbound[]; statuses?: Status[] } };
type Payload = { object?: string; entry?: { changes?: Change[] }[] };

/** "STOP" and the like: they want no more messages. Meta's own "Stop promotions" button counts too. */
const STOP = /^\s*(stop|stop all|stop promotions|stop messages|unsubscribe|opt[\s-]?out)\s*[.!]*\s*$/i;
const START = /^\s*(start|unstop|subscribe)\s*[.!]*\s*$/i;

/** A message that came in, as one line of text for the timeline and the replies list. */
export function inboundText(m: Inbound): string {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? '';
    case 'button':
      return m.button?.text ?? '';
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
    case 'image':
      return `[Photo]${m.image?.caption ? ` ${m.image.caption}` : ''}`;
    case 'video':
      return `[Video]${m.video?.caption ? ` ${m.video.caption}` : ''}`;
    case 'document':
      return `[Document${m.document?.filename ? `: ${m.document.filename}` : ''}]${m.document?.caption ? ` ${m.document.caption}` : ''}`;
    case 'audio':
      return '[Voice message]';
    case 'sticker':
      return '[Sticker]';
    case 'location':
      return '[Location]';
    case 'contacts':
      return '[Contact card]';
    case 'reaction':
      return `[Reacted ${m.reaction?.emoji ?? ''}]`.replace(' ]', ']');
    default:
      return `[${m.type ?? 'message'}]`;
  }
}

const RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };
/** A conversation started: the lead moves to Replied from any stage before it (or back from Lost). */
const REPLY_MOVES = ['Awaiting Approval', 'Approved', 'Contacted', 'Lost'];

/**
 * Handles one webhook call from Meta for INVECK's number: messages that came in (kept, matched to their
 * lead, on its timeline; STOP stops everything to them, any other message counts as agreeing to hear
 * from INVECK) and delivery updates for messages sent. A message delivered twice is kept once.
 */
export async function handleWebhook(db: Db, c: WaConfig, payload: unknown): Promise<{ received: number; updated: number }> {
  const out = { received: 0, updated: 0 };
  const p = (payload ?? {}) as Payload;
  if (p.object !== 'whatsapp_business_account') return out;
  for (const change of (p.entry ?? []).flatMap((e) => e.changes ?? [])) {
    const v = change.value;
    // Only INVECK's number: an account can hold others.
    if (change.field !== 'messages' || !v || v.metadata?.phone_number_id !== c.phoneNumberId) continue;
    const names = new Map((v.contacts ?? []).map((x) => [String(x.wa_id ?? ''), x.profile?.name?.trim() ?? '']));
    for (const m of v.messages ?? []) if (await received(db, m, names)) out.received++;
    for (const s of v.statuses ?? []) if (await statusUpdate(db, s)) out.updated++;
  }
  return out;
}

async function received(db: Db, m: Inbound, names: Map<string, string>): Promise<boolean> {
  const waId = String(m.from ?? '').replace(/\D/g, '');
  if (!waId || !m.id) return false;
  const at = m.timestamp && Number(m.timestamp) > 0 ? new Date(Number(m.timestamp) * 1000) : new Date();
  const text = inboundText(m).slice(0, 4096);
  const reaction = m.type === 'reaction';
  const leadId = await leadForNumber(db, waId);
  const [row] = await db
    .insert(whatsappMessages)
    // A reaction needs no answer.
    .values({ waId, leadId, direction: 'in', kind: m.type ?? 'text', body: text, wamid: m.id, status: 'received', at, handledAt: reaction ? at : null })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });
  if (!row) return false;

  const name = names.get(waId) ?? '';
  const [before] = await db.select().from(whatsappContacts).where(eq(whatsappContacts.waId, waId));
  const stop = STOP.test(text);
  const start = START.test(text);
  const now = new Date();
  const set: Partial<typeof whatsappContacts.$inferInsert> = { updatedAt: now };
  if (name) set.profileName = name;
  if (leadId && !before?.leadId) set.leadId = leadId;
  if (!before?.lastInboundAt || before.lastInboundAt < at) set.lastInboundAt = at;
  if (stop) Object.assign(set, { optedOutAt: at, consentAt: null, consentBy: null, consentHow: '', consentTaskId: null });
  // Writing to INVECK is agreeing to hear back; after a STOP, only START (or a new agreement) undoes it.
  else if (start || (!reaction && !before?.optedOutAt && !before?.consentAt)) {
    Object.assign(set, { consentAt: at, consentBy: null, consentHow: start ? 'They sent START on WhatsApp' : THEY_MESSAGED, consentTaskId: null, optedOutAt: null });
  }
  await db.insert(whatsappContacts).values({ waId, ...set }).onConflictDoUpdate({ target: whatsappContacts.waId, set });

  if (!leadId) return true;
  const who = name || `+${waId}`;
  if (stop) {
    await logActivity(db, leadId, 'note', `WhatsApp from ${who}: “${text}”. They asked not to get WhatsApp messages from INVECK: none will go to +${waId}.`);
    // Nothing more on WhatsApp for them, from INVECK's number or by hand.
    await db
      .update(tasks)
      .set({ doneAt: now, outcome: 'closed', note: 'Asked not to get WhatsApp messages (STOP)' })
      .where(and(eq(tasks.leadId, leadId), eq(tasks.kind, 'whatsapp'), isNull(tasks.doneAt)));
    return true;
  }
  await logActivity(db, leadId, 'note', `WhatsApp from ${who}: “${text}”`);
  if (!reaction) {
    const [lead] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, leadId));
    if (lead && REPLY_MOVES.includes(lead.status)) await moveAfterOutreach(db, leadId, 'Replied', at);
  }
  return true;
}

async function statusUpdate(db: Db, s: Status): Promise<boolean> {
  if (!s.id || !s.status) return false;
  const [msg] = await db.select().from(whatsappMessages).where(and(eq(whatsappMessages.wamid, s.id), eq(whatsappMessages.direction, 'out')));
  if (!msg || msg.status === 'failed') return false;
  const at = s.timestamp && Number(s.timestamp) > 0 ? new Date(Number(s.timestamp) * 1000) : new Date();
  if (s.status === 'failed') {
    const e = s.errors?.[0];
    const error = waErrorText(e?.code, e?.error_data?.details || e?.message || e?.title || 'no reason given');
    await db.update(whatsappMessages).set({ status: 'failed', error, statusAt: at }).where(eq(whatsappMessages.id, msg.id));
    if (msg.leadId) await logActivity(db, msg.leadId, 'error', `WhatsApp to +${msg.waId} not delivered: ${error}`);
    return true;
  }
  // Updates can arrive out of order: only ever forward (sent, delivered, read).
  if ((RANK[s.status] ?? -1) <= (RANK[msg.status] ?? 0)) return false;
  await db.update(whatsappMessages).set({ status: s.status, statusAt: at }).where(eq(whatsappMessages.id, msg.id));
  return true;
}
