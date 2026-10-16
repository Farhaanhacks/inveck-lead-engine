import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, mailboxes, people, sentEmails, tasks, users } from '@/lib/db/schema';
import { istDay } from '@/lib/tasks';

// Server actions outside Next: the signed-in person and the cache hooks are stand-ins.
const me = { id: 0, role: 'bda' as const, name: 'Puja', username: 'puja@inveck', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

const SECRET = 'test-client-secret-value';
const TOKEN_KEY = 'test-mail-token-key-0123456789-abcdefghij';

type Call = { method: string; url: string; headers: Record<string, string>; body: string };
let calls: Call[];
/** Refresh tokens Microsoft still honours; anything else is revoked. */
let liveRefresh: Set<string>;
let failSend: boolean;

/** Microsoft's sign-in and Graph, as far as sending needs them. */
async function fakeMicrosoft(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
  const method = init.method ?? 'GET';
  calls.push({ method, url, headers, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/oauth2/v2.0/token')) {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') return p.get('code') === 'good-code' ? json({ access_token: 'access-1', refresh_token: 'refresh-1' }) : json({ error: 'invalid_grant' }, 400);
    const rt = p.get('refresh_token') ?? '';
    if (!liveRefresh.has(rt)) return json({ error: 'invalid_grant', error_description: 'AADSTS70000: revoked' }, 400);
    liveRefresh.add('refresh-2');
    return json({ access_token: 'access-2', refresh_token: 'refresh-2' });
  }
  const path = url.replace('https://graph.microsoft.com/v1.0', '');
  if (method === 'GET' && path.startsWith('/me?')) return json({ mail: 'Puja@Inveck.com', displayName: 'Puja Sharma' });
  if (method === 'POST' && path === '/me/messages') return json({ id: 'msg-1', conversationId: 'conv-1' }, 201);
  if (method === 'POST' && path === '/me/messages/msg-1/createReply') return json({ id: 'reply-1', conversationId: 'conv-1' }, 201);
  if (method === 'PATCH' && path === '/me/messages/reply-1') return json({ id: 'reply-1' });
  if (method === 'POST' && /\/send$/.test(path)) return failSend ? json({ error: { message: 'Mailbox quota exceeded' } }, 403) : new Response(null, { status: 202 });
  if (method === 'DELETE' && path.startsWith('/me/messages/')) return new Response(null, { status: 204 });
  return json({ error: { message: `unexpected ${method} ${path}` } }, 404);
}

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  process.env.MS_CLIENT_ID = 'test-client-id';
  process.env.MS_CLIENT_SECRET = SECRET;
  process.env.MS_TENANT_ID = 'inveck-tenant';
  process.env.MAIL_TOKEN_KEY = TOKEN_KEY;
  resetDbForTests();
  db = await getDb();
  me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
  calls = [];
  liveRefresh = new Set(['refresh-1']);
  failSend = false;
  vi.stubGlobal('fetch', vi.fn(fakeMicrosoft));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MAIL_TOKEN_KEY']) delete process.env[k];
});

const form = (v: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, String(x));
  return f;
};
const connect = async () => {
  const { connectMailbox } = await import('@/lib/mail/outlook');
  return connectMailbox(db, me.id, 'good-code', 'https://app.example/api/mail/callback');
};
const lead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
  (
    await db
      .insert(leads)
      .values({
        company: 'Hosur Gears',
        segment: 'Manufacturing',
        status: 'Awaiting Approval',
        ownerId: me.id,
        contactName: 'Ravi Kumar',
        contactTitle: 'Plant Head',
        contactEmail: 'ravi@hosurgears.in',
        emailSubject: 'Stock checks at Hosur Gears',
        emailBody: 'Hi Ravi,\n\nA quick note about your stock counts.\n\nRegards,\nINVECK Sales Team',
        ...extra,
      })
      .returning()
  )[0];
const emailTask = async (leadId: number, step = 'Day 1', ownerId = me.id) =>
  (await db.insert(tasks).values({ leadId, ownerId, kind: 'email', step, title: `${step}: email`, dueDate: istDay(), slot: 'day' }).returning())[0];
const send = async (v: Record<string, string | number>) => {
  const { sendEmailAction } = await import('@/app/mail-actions');
  return sendEmailAction({ error: '' }, form(v));
};
const graphCalls = () => calls.filter((c) => c.url.startsWith('https://graph.microsoft.com'));

describe('connecting Outlook', () => {
  it('signs in at INVECK\'s tenant with mail scopes, and keeps only an encrypted refresh token', async () => {
    const { authorizeUrl, mailConfig } = await import('@/lib/mail/outlook');
    const url = new URL(authorizeUrl(mailConfig()!, 'https://app.example/api/mail/callback', 'state-123'));
    expect(url.pathname).toBe('/inveck-tenant/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('offline_access openid email User.Read Mail.ReadWrite');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/api/mail/callback');
    expect(url.toString()).not.toContain(SECRET);

    const box = await connect();
    expect(box.address).toBe('puja@inveck.com');
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.userId, me.id));
    expect(row.refreshToken).not.toContain('refresh-1');
    expect(row.refreshToken.startsWith('v1.')).toBe(true);
  });

  it('an unreadable or tampered connection asks to reconnect, never crashes', async () => {
    const { mailConfig, seal, unseal, MailError } = await import('@/lib/mail/outlook');
    const c = mailConfig()!;
    const sealed = seal(c, 'refresh-1');
    expect(unseal(c, sealed)).toBe('refresh-1');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => unseal(c, tampered)).toThrow(MailError);
    expect(() => unseal({ ...c, tokenKey: 'another-key' }, sealed)).toThrow(/connect Outlook again/);
  });

  it('is off until the server has the Microsoft app details', async () => {
    delete process.env.MS_CLIENT_SECRET;
    const { mailConfig } = await import('@/lib/mail/outlook');
    expect(mailConfig()).toBeNull();
    const l = await lead();
    const t = await emailTask(l.id);
    expect((await send({ id: t.id })).error).toMatch(/isn't set up/);
  });
});

describe('Send mail on Today', () => {
  it('sends the first email from the person\'s own Outlook, signed by them, and logs the step as sent', async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    calls = [];
    expect(await send({ id: t.id })).toEqual({ error: '', sent: true });

    // A refresh (the client secret goes only to Microsoft's sign-in), then create and send.
    expect(calls[0].url).toContain('/inveck-tenant/oauth2/v2.0/token');
    expect(graphCalls().map((c) => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0', '')}`)).toEqual(['POST /me/messages', 'POST /me/messages/msg-1/send']);
    for (const c of graphCalls()) {
      expect(c.headers.authorization).toBe('Bearer access-2');
      expect(c.headers.prefer).toBe('IdType="ImmutableId"');
      expect(c.body + c.url).not.toContain(SECRET);
    }
    const message = JSON.parse(graphCalls()[0].body);
    expect(message.subject).toBe('Stock checks at Hosur Gears');
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'ravi@hosurgears.in' } }]);
    expect(message.body.content).toContain('Regards,\nPuja');
    expect(message.body.content).not.toContain('INVECK Sales Team');

    const [task] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(task.outcome).toBe('done');
    expect(task.doneAt).not.toBeNull();
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.mailOutcome).toBe('Sent');
    expect(after.status).toBe('Contacted');
    const [record] = await db.select().from(sentEmails).where(eq(sentEmails.taskId, t.id));
    expect(record).toMatchObject({ status: 'sent', fromAddress: 'puja@inveck.com', toAddress: 'ravi@hosurgears.in', graphId: 'msg-1' });
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.startsWith('Email sent from Outlook (puja@inveck.com) to ravi@hosurgears.in'))).toBe(true);
    // Microsoft's new refresh token replaced the old one, still encrypted.
    const { mailConfig, unseal } = await import('@/lib/mail/outlook');
    const [box] = await db.select().from(mailboxes).where(eq(mailboxes.userId, me.id));
    expect(unseal(mailConfig()!, box.refreshToken)).toBe('refresh-2');
  });

  it('sends what was reviewed: another saved address, an edited subject and message', async () => {
    await connect();
    const l = await lead();
    await db.insert(people).values({ leadId: l.id, name: 'Other email', email: 'purchase@hosurgears.in', source: 'Added by the team' });
    const t = await emailTask(l.id);
    calls = [];
    const r = await send({ id: t.id, to: 'purchase@hosurgears.in', subject: 'Stock audits at your Hosur plant', body: 'Hi team,\n\nEdited text.' });
    expect(r.error).toBe('');
    const message = JSON.parse(graphCalls()[0].body);
    expect(message.toRecipients[0].emailAddress.address).toBe('purchase@hosurgears.in');
    expect(message.subject).toBe('Stock audits at your Hosur plant');
    expect(message.body.content).toBe('Hi team,\n\nEdited text.');
    // The lead's draft is what went out.
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].emailSubject).toBe('Stock audits at your Hosur plant');
  });

  it('a follow-up goes as a reply in the same thread, with the earlier email quoted, and uses up the follow-up draft', async () => {
    await connect();
    const l = await lead();
    expect((await send({ id: (await emailTask(l.id)).id })).error).toBe('');
    await db.update(leads).set({ followUpSubject: 'Re: Stock checks at Hosur Gears', followUpBody: 'Hi Ravi,\n\nJust following up.\n\nRegards,\nINVECK Sales Team' }).where(eq(leads.id, l.id));
    const follow = await emailTask(l.id, 'Follow-up 1');
    calls = [];
    expect((await send({ id: follow.id })).error).toBe('');
    expect(graphCalls().map((c) => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0', '')}`)).toEqual([
      'POST /me/messages/msg-1/createReply',
      'PATCH /me/messages/reply-1',
      'POST /me/messages/reply-1/send',
    ]);
    const patch = JSON.parse(graphCalls()[1].body);
    expect(patch.toRecipients).toEqual([{ emailAddress: { address: 'ravi@hosurgears.in' } }]);
    expect(patch.body.content).toMatch(/^Hi Ravi,\n\nJust following up\.\n\nRegards,\nPuja\n\n-----Original message-----\nFrom: puja@inveck\.com/);
    expect(patch.body.content).toContain('Subject: Stock checks at Hosur Gears');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.followUpBody).toBe('');
    expect(after.followUpStep).toBe(1);
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.startsWith('Follow-up sent from Outlook') && x.includes('in the same thread'))).toBe(true);
  });

  it('a follow-up with nothing written asks for one instead of resending the first email', async () => {
    await connect();
    const l = await lead();
    expect((await send({ id: (await emailTask(l.id)).id })).error).toBe('');
    const follow = await emailTask(l.id, 'Follow-up 1');
    calls = [];
    expect((await send({ id: follow.id })).error).toMatch(/No follow-up written yet/);
    expect(graphCalls()).toEqual([]);
  });

  it('refuses, and sends nothing: someone else\'s company, an unsaved address, no mailbox, a step already sent', async () => {
    const l = await lead();
    const t = await emailTask(l.id);
    // Not connected yet.
    expect((await send({ id: t.id })).error).toMatch(/Connect your Outlook/);
    expect(await db.select().from(sentEmails)).toEqual([]);

    await connect();
    calls = [];
    const other = (await db.select().from(users).where(eq(users.role, 'bda')))[1];
    const theirs = await emailTask(l.id, 'Day 1', other.id);
    expect((await send({ id: theirs.id })).error).toMatch(/Only the person this company belongs to/);
    expect((await send({ id: t.id, to: 'someone@else.com', subject: 's', body: 'b' })).error).toMatch(/one of the addresses saved/);

    // Already being sent (another tab): never twice.
    await db.insert(sentEmails).values({ leadId: l.id, taskId: t.id, userId: me.id, toAddress: 'ravi@hosurgears.in' });
    expect((await send({ id: t.id })).error).toMatch(/already being sent/);
    expect(graphCalls()).toEqual([]);
    await db.delete(sentEmails).where(eq(sentEmails.taskId, t.id));

    // Sent and logged: a second click finds the step done.
    expect((await send({ id: t.id })).error).toBe('');
    expect((await send({ id: t.id })).error).toMatch(/already logged/);
  });

  it('when Outlook refuses, the step stays open and the person is told why', async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    failSend = true;
    expect((await send({ id: t.id })).error).toBe("Outlook didn't send it: Mailbox quota exceeded");
    // The unsent draft is removed from their Drafts folder.
    expect(graphCalls().at(-1)).toMatchObject({ method: 'DELETE', url: 'https://graph.microsoft.com/v1.0/me/messages/msg-1' });
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
    expect(await db.select().from(sentEmails).where(eq(sentEmails.taskId, t.id))).toEqual([]);

    // A revoked connection: reconnect, shown on the Account page too.
    failSend = false;
    liveRefresh.clear();
    expect((await send({ id: t.id })).error).toMatch(/connect Outlook again/);
    const [box] = await db.select().from(mailboxes).where(and(eq(mailboxes.userId, me.id)));
    expect(box.lastError).toMatch(/expired/);
  });
});

describe('what the next email is', () => {
  it('first email until they have been emailed; then a follow-up; signed with the sender\'s name', async () => {
    const { planEmail } = await import('@/lib/mail/plan');
    const l = await lead();
    const sign = { from: 'INVECK Sales Team', as: 'Puja' };
    expect(planEmail(l, { step: 'Day 1' }, undefined, sign)).toMatchObject({ followUp: false, subject: 'Stock checks at Hosur Gears', replyTo: '' });
    expect(planEmail(l, { step: 'Day 1' }, undefined, sign).body).toContain('Regards,\nPuja');
    // Emailed by hand on Day 1 (marked sent): Follow-up 1 is a follow-up, as a new email.
    const marked = { ...l, mailOutcome: 'Sent', followUpBody: 'Following up.' };
    expect(planEmail(marked, { step: 'Follow-up 1' }, undefined, sign)).toMatchObject({ followUp: true, subject: 'Re: Stock checks at Hosur Gears', body: 'Following up.', replyTo: '' });
    // No sender name in Settings that matches: the text is left as written.
    expect(planEmail(l, { step: 'Day 1' }, undefined, { from: '', as: 'Puja' }).body).toContain('INVECK Sales Team');
  });
});

describe('saved emails survive a restart', () => {
  it('starting the app again (schema upkeep) never clears the addresses the team saved', async () => {
    const { sql } = await import('drizzle-orm');
    const { SCHEMA_STATEMENTS } = await import('@/lib/db/migrate');
    const l = await lead({ emailStatus: 'entered by the team', emailSource: 'manual' });
    await db.insert(people).values({ leadId: l.id, name: 'Other email', email: 'purchase@hosurgears.in', source: 'Added by the team' });
    for (const statement of SCHEMA_STATEMENTS) await db.execute(sql.raw(statement));
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0]).toMatchObject({ contactEmail: 'ravi@hosurgears.in', emailSource: 'manual' });
    expect((await db.select().from(people).where(eq(people.leadId, l.id)))[0].email).toBe('purchase@hosurgears.in');
  });
});
