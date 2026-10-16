import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, tasks, users, whatsappContacts, whatsappMessages } from '@/lib/db/schema';
import { istDay } from '@/lib/tasks';

// Server actions outside Next: the signed-in person and the cache hooks are stand-ins.
const me = { id: 0, role: 'bda' as const, name: 'Puja', username: 'puja@inveck', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

const PHONE_ID = '1098765432';
const TOKEN = 'test-system-user-token';
const APP_SECRET = 'test-app-secret-0123456789';
const RAVI = '919845012345';
const TEMPLATE = 'Hi {{1}}, this is {{2}} from INVECK, as promised on our call. Would a short demo for {{3}} help? Reply STOP to stop these messages.';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[];
/** Meta's answer to the next send: an error code, or a message id. */
let failWith: { code: number; message: string; details?: string } | null;
let n: number;

async function fakeMeta(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
  calls.push({ url, headers, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url !== `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`) return json({ error: { message: `unexpected ${url}` } }, 404);
  if (failWith) return json({ error: { code: failWith.code, message: failWith.message, error_data: { details: failWith.details ?? failWith.message } } }, 400);
  return json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out-${++n}` }] });
}

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  process.env.WHATSAPP_PHONE_NUMBER_ID = PHONE_ID;
  process.env.WHATSAPP_TOKEN = TOKEN;
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me-123';
  resetDbForTests();
  db = await getDb();
  me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
  calls = [];
  failWith = null;
  n = 0;
  vi.stubGlobal('fetch', vi.fn(fakeMeta));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) delete process.env[k];
});

const form = (v: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, String(x));
  return f;
};
const lead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
  (
    await db
      .insert(leads)
      .values({ company: 'Hosur Gears', segment: 'Manufacturing', status: 'Contacted', ownerId: me.id, contactName: 'Ravi Kumar', contactTitle: 'Plant Head', contactPhone: '+91 98450 12345', ...extra })
      .returning()
  )[0];
const task = async (leadId: number, kind: 'call' | 'whatsapp', step = 'Day 1') =>
  (await db.insert(tasks).values({ leadId, ownerId: me.id, kind, step, title: `${step}: ${kind}`, dueDate: istDay(), slot: 'day' }).returning())[0];
const useTemplate = async () => {
  const { getSettings, saveSettings } = await import('@/lib/settings');
  await saveSettings(db, { ...(await getSettings(db)), waTemplateName: 'inveck_details', waTemplateLanguage: 'en', waTemplateText: TEMPLATE });
};
const agree = async (leadId: number) => {
  const { recordConsent, ON_A_CALL } = await import('@/lib/whatsapp/contacts');
  await recordConsent(db, { waId: RAVI, leadId, how: ON_A_CALL, by: { id: me.id, name: me.name } });
};
const sendStep = async (v: Record<string, string | number>) => (await import('@/app/whatsapp-actions')).sendWhatsAppAction({ error: '' }, form(v));
const sendFromPage = async (v: Record<string, string | number>) => (await import('@/app/whatsapp-actions')).sendWhatsAppMessageAction({ error: '' }, form(v));

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const post = async (payload: unknown, signature?: string) => {
  const { POST } = await import('@/app/api/whatsapp/webhook/route');
  const body = JSON.stringify(payload);
  return POST(new Request('https://app.example/api/whatsapp/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) } }));
};
const change = (value: Record<string, unknown>, phoneId = PHONE_ID) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '912200000000', phone_number_id: phoneId }, ...value } }] }],
});
const inbound = (text: string, id: string, opts: { from?: string; at?: Date; phoneId?: string } = {}) =>
  change(
    {
      contacts: [{ profile: { name: 'Ravi K' }, wa_id: opts.from ?? RAVI }],
      messages: [{ from: opts.from ?? RAVI, id, timestamp: String(Math.floor((opts.at ?? new Date()).getTime() / 1000)), type: 'text', text: { body: text } }],
    },
    opts.phoneId,
  );
const status = (id: string, s: string, errors?: unknown[]) =>
  change({ statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: RAVI, ...(errors ? { errors } : {}) }] });
const contact = async () => (await db.select().from(whatsappContacts).where(eq(whatsappContacts.waId, RAVI)))[0];

describe('numbers and setup', () => {
  it('turns a saved number into the form WhatsApp uses, Indian numbers without +91 included', async () => {
    const { waNumber } = await import('@/lib/phones');
    expect(waNumber('98450 12345')).toBe(RAVI);
    expect(waNumber('+91 98450-12345, 080 2222 3333')).toBe(RAVI);
    expect(waNumber('0091 98450 12345')).toBe(RAVI);
    expect(waNumber('098450 12345')).toBe(RAVI);
    expect(waNumber('12345')).toBe('');
    expect(waNumber('')).toBe('');
  });

  it('is off until the server has the WhatsApp details', async () => {
    delete process.env.WHATSAPP_TOKEN;
    const { waConfig } = await import('@/lib/whatsapp/cloud');
    expect(waConfig()).toBeNull();
    const l = await lead();
    await agree(l.id);
    await useTemplate();
    const t = await task(l.id, 'whatsapp');
    expect((await sendStep({ id: t.id })).error).toMatch(/isn't set up/);
    expect(calls).toHaveLength(0);
  });

  it('only {{1}} {{2}} {{3}} can be in the template, and its name is as Meta writes it', async () => {
    const { settingsSchema } = await import('@/lib/settings');
    expect(settingsSchema.safeParse({ waTemplateText: 'Hi {{1}}, from {{2}} at {{3}}' }).success).toBe(true);
    expect(settingsSchema.safeParse({ waTemplateText: 'Hi {{1}} {{4}}' }).success).toBe(false);
    expect(settingsSchema.safeParse({ waTemplateName: 'Inveck Details' }).success).toBe(false);
  });
});

describe('agreeing on a call', () => {
  it('records it with the call, adds a WhatsApp step for today, and undoing the call takes both back', async () => {
    const l = await lead();
    const call = await task(l.id, 'call');
    const { completeTaskAction, undoTaskAction } = await import('@/app/team-actions');
    await completeTaskAction(form({ id: call.id, outcome: 'connected', note: 'Asked for details on WhatsApp', feedback: 'Send details on email / WhatsApp', waConsent: 'on' }));

    const c = await contact();
    expect(c.consentAt).toBeTruthy();
    expect(c.consentHow).toBe('On a call');
    expect(c.consentBy).toBe(me.id);
    expect(c.consentTaskId).toBe(call.id);
    expect(c.leadId).toBe(l.id);
    const wa = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), eq(tasks.kind, 'whatsapp')));
    expect(wa.map((t) => [t.step, t.dueDate, t.doneAt])).toEqual([['WhatsApp details', istDay(), null]]);
    const log = await db.select().from(activities).where(eq(activities.leadId, l.id));
    expect(log.some((a) => a.text.includes(`Agreed to WhatsApp messages from INVECK on +${RAVI}`) && a.text.includes('logged by Puja'))).toBe(true);

    await undoTaskAction(form({ id: call.id }));
    expect((await contact()).consentAt).toBeNull();
    expect(await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), eq(tasks.kind, 'whatsapp')))).toHaveLength(0);
  });

  it('nothing is recorded when the box is left unticked, or when they were not interested', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const a = await lead();
    await completeTaskAction(form({ id: (await task(a.id, 'call')).id, outcome: 'connected', note: 'Spoke briefly', feedback: 'Send details on email / WhatsApp' }));
    const b = await lead({ company: 'Nashik Castings', contactPhone: '98220 11111' });
    await completeTaskAction(form({ id: (await task(b.id, 'call')).id, outcome: 'connected', note: 'No need', feedback: 'Not interested', waConsent: 'on' }));
    expect(await db.select().from(whatsappContacts)).toHaveLength(0);
  });
});

describe('Send WhatsApp on Today', () => {
  it('only to someone who agreed', async () => {
    await useTemplate();
    const l = await lead();
    const t = await task(l.id, 'whatsapp');
    expect((await sendStep({ id: t.id })).error).toMatch(/haven't agreed/);
    expect(calls).toHaveLength(0);
  });

  it('needs the approved template in Settings', async () => {
    const l = await lead();
    await agree(l.id);
    const t = await task(l.id, 'whatsapp');
    expect((await sendStep({ id: t.id })).error).toMatch(/No approved WhatsApp template/);
    expect(calls).toHaveLength(0);
  });

  it('sends the approved template from INVECK\'s number, filled in, logs the step as sent, and never twice', async () => {
    await useTemplate();
    const l = await lead();
    await agree(l.id);
    const t = await task(l.id, 'whatsapp');
    expect(await sendStep({ id: t.id })).toEqual({ error: '', sent: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: RAVI,
      type: 'template',
      template: {
        name: 'inveck_details',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: 'Puja' }, { type: 'text', text: 'Hosur Gears' }] }],
      },
    });
    const [msg] = await db.select().from(whatsappMessages);
    expect(msg).toMatchObject({ direction: 'out', kind: 'template', status: 'sent', wamid: 'wamid.out-1', taskId: t.id, userId: me.id, leadId: l.id });
    expect(msg.body).toBe('Hi Ravi, this is Puja from INVECK, as promised on our call. Would a short demo for Hosur Gears help? Reply STOP to stop these messages.');
    const [done] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(done.outcome).toBe('sent');

    expect((await sendStep({ id: t.id })).error).toMatch(/already logged/);
    expect(calls).toHaveLength(1);

    // Undone since: it went, so it is only to be logged.
    const { undoTaskAction } = await import('@/app/team-actions');
    await undoTaskAction(form({ id: t.id }));
    expect((await sendStep({ id: t.id })).error).toMatch(/^This WhatsApp already went from INVECK's number \(.+\): click Mark sent to log it\.$/);
    expect(calls).toHaveLength(1);
  });

  it('a refusal from WhatsApp is shown in plain words, and the step stays open', async () => {
    await useTemplate();
    const l = await lead();
    await agree(l.id);
    const t = await task(l.id, 'whatsapp');
    failWith = { code: 132001, message: 'Template name does not exist in the translation' };
    expect((await sendStep({ id: t.id })).error).toMatch(/doesn't match the one Meta approved/);
    expect(await db.select().from(whatsappMessages)).toHaveLength(0);
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
    failWith = null;
    expect((await sendStep({ id: t.id })).error).toBe('');
  });

  it("only the company's owner sends its step", async () => {
    await useTemplate();
    const [other] = (await db.select().from(users).where(eq(users.role, 'bda'))).filter((u) => u.id !== me.id);
    const l = await lead({ ownerId: other.id });
    await agree(l.id);
    const [t] = await db.insert(tasks).values({ leadId: l.id, ownerId: other.id, kind: 'whatsapp', step: 'Day 1', title: 'Day 1: WhatsApp', dueDate: istDay() }).returning();
    expect((await sendStep({ id: t.id })).error).toMatch(/Only the person this company belongs to/);
    expect(calls).toHaveLength(0);
  });
});

describe('the webhook', () => {
  it('answers Meta\'s check only with the verify token', async () => {
    const { GET } = await import('@/app/api/whatsapp/webhook/route');
    const ok = await GET(new Request('https://app.example/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=4242'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('4242');
    expect((await GET(new Request('https://app.example/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242'))).status).toBe(403);
  });

  it('reads only calls signed with the app secret', async () => {
    const l = await lead();
    expect((await post(inbound('hello', 'wamid.in-1'), sign('{}'))).status).toBe(401);
    expect((await post(inbound('hello', 'wamid.in-1'), sign(JSON.stringify(inbound('hello', 'wamid.in-1')), 'another-secret'))).status).toBe(401);
    expect((await post(inbound('hello', 'wamid.in-1'), 'not-a-signature')).status).toBe(401);
    expect(await db.select().from(whatsappMessages)).toHaveLength(0);
    expect((await post(inbound('hello', 'wamid.in-1'))).status).toBe(200);
    expect((await db.select().from(whatsappMessages))[0].leadId).toBe(l.id);
  });

  it('a reply is kept once, matched to the lead by its number, moves it to Replied, and opens 24 hours of free text', async () => {
    await useTemplate();
    const l = await lead({ contactPhone: '098450-12345' });
    await post(inbound('Yes, please share a demo slot', 'wamid.in-1'));
    await post(inbound('Yes, please share a demo slot', 'wamid.in-1'));

    const msgs = await db.select().from(whatsappMessages);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'in', leadId: l.id, body: 'Yes, please share a demo slot', status: 'received', handledAt: null });
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].status).toBe('Replied');
    const c = await contact();
    expect(c.profileName).toBe('Ravi K');
    // Writing to INVECK is agreeing to hear back.
    expect(c.consentHow).toBe('They messaged INVECK on WhatsApp');
    expect(c.lastInboundAt).toBeTruthy();
    const log = await db.select().from(activities).where(eq(activities.leadId, l.id));
    expect(log.some((a) => a.text === 'WhatsApp from Ravi K: “Yes, please share a demo slot”')).toBe(true);

    // Within 24 hours: free text, and the reply counts as answered.
    expect(await sendFromPage({ leadId: l.id, body: 'Thanks Ravi, does Thursday 11 am work?' })).toEqual({ error: '', sent: true });
    expect(calls.at(-1)!.body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: RAVI, type: 'text', text: { preview_url: false, body: 'Thanks Ravi, does Thursday 11 am work?' } });
    expect((await db.select().from(whatsappMessages).where(eq(whatsappMessages.direction, 'in')))[0].handledAt).toBeTruthy();
  });

  it('after 24 hours only the template goes, whatever was typed', async () => {
    await useTemplate();
    const l = await lead();
    await post(inbound('Hi', 'wamid.in-old', { at: new Date(Date.now() - 25 * 60 * 60 * 1000) }));
    expect(await sendFromPage({ leadId: l.id, body: 'Free text that may not go' })).toEqual({ error: '', sent: true });
    expect(calls.at(-1)!.body.type).toBe('template');
  });

  it('STOP stops everything to them, open WhatsApp steps included, until they agree again', async () => {
    await useTemplate();
    const l = await lead();
    await agree(l.id);
    const t = await task(l.id, 'whatsapp');
    await post(inbound('STOP', 'wamid.in-stop'));

    const c = await contact();
    expect(c.optedOutAt).toBeTruthy();
    expect(c.consentAt).toBeNull();
    const [closed] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(closed.outcome).toBe('closed');
    expect((await sendFromPage({ leadId: l.id })).error).toMatch(/asked not to get WhatsApp messages/);
    // Any other message later doesn't undo a STOP; START does.
    await post(inbound('ok', 'wamid.in-2'));
    expect((await contact()).optedOutAt).toBeTruthy();
    await post(inbound('START', 'wamid.in-3'));
    expect((await contact()).optedOutAt).toBeNull();
    expect((await contact()).consentAt).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('delivery updates only move forward; a failure is explained on the timeline', async () => {
    await useTemplate();
    const l = await lead();
    await agree(l.id);
    await sendFromPage({ leadId: l.id });
    const status1 = async () => (await db.select().from(whatsappMessages))[0];
    await post(status('wamid.out-1', 'delivered'));
    await post(status('wamid.out-1', 'read'));
    await post(status('wamid.out-1', 'delivered'));
    expect((await status1()).status).toBe('read');

    // A week later (the template doesn't go again sooner without a reply).
    await db.update(whatsappContacts).set({ lastTemplateAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(whatsappContacts.waId, RAVI));
    expect((await sendFromPage({ leadId: l.id })).error).toBe('');
    await post(status('wamid.out-2', 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
    const [failed] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.wamid, 'wamid.out-2'));
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/number may not be on WhatsApp/);
    const log = await db.select().from(activities).where(and(eq(activities.leadId, l.id), eq(activities.kind, 'error')));
    expect(log.map((a) => a.text)).toEqual([`WhatsApp to +${RAVI} not delivered: ${failed.error}`]);
  });

  it('keeps messages from numbers on no company, and ignores other numbers of the account', async () => {
    await post(inbound('Who is this?', 'wamid.in-x', { from: '447700900123' }));
    await post(inbound('Not ours', 'wamid.in-y', { phoneId: '999' }));
    const msgs = await db.select().from(whatsappMessages);
    expect(msgs.map((m) => [m.waId, m.leadId])).toEqual([['447700900123', null]]);
  });

  it('replies wait on Today for the owner (numbers on no company for administrators) until answered or marked done', async () => {
    const l = await lead();
    await post(inbound('Will get back next week', 'wamid.in-1'));
    await post(inbound('Is this INVECK?', 'wamid.in-2', { from: '447700900123' }));
    const { waitingReplies } = await import('@/lib/whatsapp/contacts');
    const waiting = await waitingReplies(db, me.id, false);
    expect(waiting.replies.map((r) => [r.company, r.m.body])).toEqual([['Hosur Gears', 'Will get back next week']]);
    expect(waiting.strangers).toEqual([]);
    expect((await waitingReplies(db, me.id, true)).strangers.map((m) => m.waId)).toEqual(['447700900123']);
    // Two weeks on, it has dropped off.
    expect((await waitingReplies(db, me.id, false, new Date(Date.now() + 15 * 24 * 60 * 60 * 1000))).replies).toEqual([]);

    const [m] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.wamid, 'wamid.in-1'));
    const { dismissWhatsAppReplyAction } = await import('@/app/whatsapp-actions');
    await dismissWhatsAppReplyAction(form({ id: m.id }));
    expect((await waitingReplies(db, me.id, false)).replies).toEqual([]);
    expect((await db.select().from(whatsappMessages).where(eq(whatsappMessages.id, m.id)))[0]).toMatchObject({ leadId: l.id, handledAt: expect.any(Date) });
  });
});

describe('found in review', () => {
  it("a deleted company no longer claims its number: a later message goes to the company that has it now", async () => {
    const old = await lead();
    await agree(old.id);
    const { leadForNumber } = await import('@/lib/whatsapp/contacts');
    expect(await leadForNumber(db, RAVI)).toBe(old.id);
    const { deleteLeadAction } = await import('@/app/actions');
    await deleteLeadAction(form({ id: old.id })).catch(() => {}); // it redirects to the list
    expect((await contact()).leadId).toBeNull();
    const now = await lead({ company: 'Hosur Gears (Unit 2)' });
    await post(inbound('Hello again', 'wamid.in-9'));
    expect((await db.select().from(whatsappMessages))[0].leadId).toBe(now.id);
    expect((await contact()).leadId).toBe(now.id);

    // A company removed some other way (or before this was fixed) still links the number: ignored.
    await db.delete(leads).where(eq(leads.id, now.id));
    expect((await contact()).leadId).toBe(now.id);
    expect(await leadForNumber(db, RAVI)).toBeNull();
  });

  it("STOP ticks off the company's day when WhatsApp was all that was left", async () => {
    const l = await lead();
    await agree(l.id);
    await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'call', step: 'Day 1', title: 'Day 1: call', dueDate: istDay(), doneAt: new Date(), outcome: 'no_answer' });
    await task(l.id, 'whatsapp');
    const { companyDays } = await import('@/lib/db/schema');
    expect(await db.select().from(companyDays)).toHaveLength(0);
    await post(inbound('Stop', 'wamid.in-stop'));
    expect((await db.select().from(companyDays)).map((d) => d.leadId)).toEqual([l.id]);
  });

  it("WhatsApp's own notices (a changed number) need no answer, and are not agreeing to anything", async () => {
    await lead();
    await post(change({ messages: [{ from: RAVI, id: 'wamid.sys', timestamp: String(Math.floor(Date.now() / 1000)), type: 'system', system: { body: 'User changed number' } }] }));
    const [m] = await db.select().from(whatsappMessages);
    expect(m).toMatchObject({ body: '[User changed number]', handledAt: expect.any(Date) });
    const c = await contact();
    expect(c?.consentAt ?? null).toBeNull();
    expect(c?.lastInboundAt ?? null).toBeNull();
  });

  it("no answer from WhatsApp: says it may have gone, rather than inviting a second copy", async () => {
    await useTemplate();
    const l = await lead();
    await agree(l.id);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    expect((await sendFromPage({ leadId: l.id })).error).toMatch(/may or may not have gone/);
    expect(await db.select().from(whatsappMessages)).toHaveLength(0);
  });
});

describe('protecting the number', () => {
  it("the template doesn't go again to someone who hasn't replied, for a week; a reply (or a week) allows it", async () => {
    await useTemplate();
    const l = await lead();
    await agree(l.id);
    expect((await sendFromPage({ leadId: l.id })).error).toBe('');
    // Again, no reply yet: refused, and nothing goes.
    expect((await sendFromPage({ leadId: l.id })).error).toMatch(/already went .+ and they haven't replied/);
    const t = await task(l.id, 'whatsapp', 'Promised callback');
    expect((await sendStep({ id: t.id })).error).toMatch(/haven't replied/);
    expect(calls).toHaveLength(1);
    // A week on: one more is allowed.
    const { planWhatsApp, waContacts } = await import('@/lib/whatsapp/contacts');
    const { getSettings } = await import('@/lib/settings');
    const c = (await waContacts(db, [RAVI])).get(RAVI);
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(planWhatsApp(l, 'Puja', await getSettings(db), c, later).problem).toBe('');
    // They reply: free text now, and the template again once the 24 hours are over.
    await post(inbound('Thanks, will check', 'wamid.in-r', { at: new Date(Date.now() + 60_000) }));
    expect((await sendFromPage({ leadId: l.id, body: 'Great, speak soon.' })).error).toBe('');
    const after = (await waContacts(db, [RAVI])).get(RAVI);
    expect(planWhatsApp(l, 'Puja', await getSettings(db), after, new Date(Date.now() + 25 * 60 * 60 * 1000)).problem).toBe('');
  });

  it('a STOP is not a reply waiting for an answer', async () => {
    await lead();
    await post(inbound('STOP', 'wamid.in-stop'));
    const { waitingReplies } = await import('@/lib/whatsapp/contacts');
    expect((await waitingReplies(db, me.id, true)).replies).toEqual([]);
    expect((await db.select().from(whatsappMessages))[0].handledAt).toBeTruthy();
  });
});

describe('marking agreement on the company page', () => {
  it('records how they agreed, and a mark made by mistake can be taken back', async () => {
    const l = await lead();
    const { setWhatsAppConsentAction } = await import('@/app/whatsapp-actions');
    await setWhatsAppConsentAction(form({ leadId: l.id, agree: '1', how: 'By email' }));
    expect((await contact()).consentHow).toBe('By email');
    await setWhatsAppConsentAction(form({ leadId: l.id, agree: '0' }));
    expect((await contact()).consentAt).toBeNull();
  });
});
