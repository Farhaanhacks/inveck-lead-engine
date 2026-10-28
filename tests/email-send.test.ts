import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, mailboxes, people, sentEmails, tasks, users } from '@/lib/db/schema';
import { istDay } from '@/lib/tasks';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Server actions outside Next: the signed-in person and the cache hooks are stand-ins.
const me = { id: 0, role: 'bda' as const, name: 'Puja', username: 'puja@inveck', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

// The real profile PDFs live in assets/; tests read small stand-ins from a temp folder instead.
const assets = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/mail/profile-pdf', async (orig) => {
  const m = await orig<typeof import('@/lib/mail/profile-pdf')>();
  return { ...m, loadProfilePdf: (segment: string, dir?: string) => m.loadProfilePdf(segment, dir ?? assets.dir) };
});

const SECRET = 'test-client-secret-value';
const TOKEN_KEY = 'test-mail-token-key-0123456789-abcdefghij';

type Call = { method: string; url: string; headers: Record<string, string>; body: string };
let calls: Call[];
/** Refresh tokens Microsoft still honours; anything else is revoked. */
let liveRefresh: Set<string>;
let failSend: boolean;
/** A Microsoft address that doesn't answer (network down, timed out). */
let hang: string | null;

/** Microsoft's sign-in and Graph, as far as sending needs them. */
async function fakeMicrosoft(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
  const method = init.method ?? 'GET';
  calls.push({ method, url, headers, body });
  if (hang && url.includes(hang)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
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
  if (method === 'POST' && path === '/me/sendMail') return failSend ? json({ error: { message: 'Mailbox quota exceeded' } }, 403) : new Response(null, { status: 202, headers: { 'request-id': 'req-123' } });
  return json({ error: { message: `unexpected ${method} ${path}` } }, 404);
}

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  process.env.MICROSOFT_CLIENT_ID = 'test-client-id';
  process.env.MICROSOFT_CLIENT_SECRET = SECRET;
  process.env.MICROSOFT_TENANT_ID = 'inveck-tenant';
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = TOKEN_KEY;
  process.env.MICROSOFT_REDIRECT_URI = 'https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback';
  resetDbForTests();
  db = await getDb();
  me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
  calls = [];
  liveRefresh = new Set(['refresh-1']);
  failSend = false;
  hang = null;
  vi.stubGlobal('fetch', vi.fn(fakeMicrosoft));
  assets.dir = await mkdtemp(join(tmpdir(), 'assets-'));
  await writeFile(join(assets.dir, 'inveck-profile-manufacturing.pdf'), Buffer.from('%PDF-1.4 manufacturing'));
  await writeFile(join(assets.dir, 'inveck-profile-3pl.pdf'), Buffer.from('%PDF-1.4 3pl'));
  // An ICP called Other with a first-contact template and a Follow-up 1 template (Follow-up 2 and later have none).
  const { defaultProduct, saveIcp, saveEmailTemplate, assignEmailTemplate } = await import('@/lib/config');
  const product = (await defaultProduct(db))!;
  const other = await saveIcp(db, product.id, { segment: 'Other' });
  if (!other.ok) throw new Error(other.error);
  const first = await saveEmailTemplate(db, product.id, other.icp.id, { name: 'First contact', subject: 'Stock checks at {{company_name}}', body: '<p>Hi Ravi,</p><p>A quick note about your stock counts.</p>' });
  const again = await saveEmailTemplate(db, product.id, other.icp.id, { name: 'Follow-up 1', subject: 'Re: Stock checks at {{company_name}}', body: '<p>Hi Ravi,</p><p>Just following up.</p>' });
  if (!first.ok || !again.ok) throw new Error('template');
  await assignEmailTemplate(db, product.id, other.icp.id, 0, first.id);
  await assignEmailTemplate(db, product.id, other.icp.id, 1, again.id);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'MICROSOFT_TOKEN_ENCRYPTION_KEY', 'MICROSOFT_REDIRECT_URI']) delete process.env[k];
});

const form = (v: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, String(x));
  return f;
};
const connect = async () => {
  const { connectMailbox } = await import('@/lib/mail/outlook');
  return connectMailbox(db, me.id, 'good-code', 'https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback');
};
const lead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
  (
    await db
      .insert(leads)
      .values({
        company: 'Hosur Gears',
        segment: 'Other',
        status: 'Approved',
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
    const url = new URL(authorizeUrl(mailConfig()!, 'https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback', 'state-123'));
    expect(url.pathname).toBe('/inveck-tenant/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('offline_access openid email User.Read Mail.Send Calendars.ReadWrite');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback');
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
    delete process.env.MICROSOFT_CLIENT_SECRET;
    const { mailConfig } = await import('@/lib/mail/outlook');
    expect(mailConfig()).toBeNull();
    const l = await lead();
    const t = await emailTask(l.id);
    expect((await send({ id: t.id })).error).toMatch(/isn't set up/);
  });
});

/** The email as text: tags gone, line breaks kept. `written` is only what the person wrote, before the signature. */
const plain = (html: string) => html.replace(/<br\s*\/?>/g, '\n').replace(/<\/p>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const written = (html: string) => plain(html.split('Thanks &amp; Regards,')[0]).trim();

describe('Send mail on Today', () => {
  it('sends the first email from the person\'s own Outlook, signed by them, and logs the step as sent', async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    calls = [];
    expect(await send({ id: t.id })).toEqual({ error: '', sent: true });

    // A refresh (the client secret goes only to Microsoft's sign-in), then one sendMail.
    expect(calls[0].url).toContain('/inveck-tenant/oauth2/v2.0/token');
    expect(graphCalls().map((c) => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0', '')}`)).toEqual(['POST /me/sendMail']);
    const c0 = graphCalls()[0];
    expect(c0.headers.authorization).toBe('Bearer access-2');
    expect(c0.body + c0.url).not.toContain(SECRET);
    const { message, saveToSentItems } = JSON.parse(c0.body);
    expect(saveToSentItems).toBe(true);
    expect(message.subject).toBe('Stock checks at Hosur Gears');
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'ravi@hosurgears.in' } }]);
    // The template's text, then the signature, which carries the sender's full name.
    expect(message.body.contentType).toBe('HTML');
    expect(written(message.body.content)).toBe('Hi Ravi,\n\nA quick note about your stock counts.');
    expect(plain(message.body.content)).toMatch(/ \| Inveck India\s+Business Development/);
    expect(message.body.content).not.toContain('INVECK Sales Team');

    const [task] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(task.outcome).toBe('done');
    expect(task.doneAt).not.toBeNull();
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.mailOutcome).toBe('Sent');
    expect(after.status).toBe('Contacted');
    const [record] = await db.select().from(sentEmails).where(eq(sentEmails.taskId, t.id));
    expect(record).toMatchObject({ status: 'sent', fromAddress: 'puja@inveck.com', toAddress: 'ravi@hosurgears.in', graphId: 'req-123' });
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.startsWith('Email sent from Outlook (puja@inveck.com) to ravi@hosurgears.in: “Stock checks at Hosur Gears” at ') && x.includes('Graph accepted it (HTTP 202, request req-123)'))).toBe(true);
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
    const message = JSON.parse(graphCalls()[0].body).message;
    expect(message.toRecipients[0].emailAddress.address).toBe('purchase@hosurgears.in');
    expect(message.subject).toBe('Stock audits at your Hosur plant');
    expect(written(message.body.content)).toBe('Hi team,\n\nEdited text.');
    // An edit is for this email only: the lead's saved draft stays as it was (the edited text is on the sent record).
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].emailSubject).toBe('Stock checks at Hosur Gears');
    expect((await db.select().from(sentEmails).where(eq(sentEmails.taskId, t.id)))[0].subject).toBe('Stock audits at your Hosur plant');
  });

  it('a follow-up goes as a new "Re:" email with the earlier one quoted, and uses up the follow-up draft', async () => {
    await connect();
    const l = await lead();
    expect((await send({ id: (await emailTask(l.id)).id })).error).toBe('');
    const follow = await emailTask(l.id, 'Follow-up 1');
    calls = [];
    expect((await send({ id: follow.id })).error).toBe('');
    expect(graphCalls().map((c) => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0', '')}`)).toEqual(['POST /me/sendMail']);
    const { message } = JSON.parse(graphCalls()[0].body);
    expect(message.subject).toBe('Re: Stock checks at Hosur Gears');
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'ravi@hosurgears.in' } }]);
    expect(written(message.body.content)).toBe('Hi Ravi,\n\nJust following up.');
    // The earlier email stays quoted, under the signature.
    expect(message.body.content.indexOf('Original message')).toBeGreaterThan(message.body.content.indexOf('Inveck India'));
    expect(plain(message.body.content)).toContain('From: puja@inveck.com');
    expect(message.body.content).toContain('Subject: Stock checks at Hosur Gears');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.followUpBody).toBe('');
    expect(after.followUpStep).toBe(1);
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.startsWith('Follow-up sent from Outlook'))).toBe(true);
  });

  it('a follow-up step with no template sends nothing (no AI draft), and says which step is missing', async () => {
    await connect();
    const l = await lead({ followUpSubject: 'Re: x', followUpBody: 'An AI-written draft that must never be sent.' });
    expect((await send({ id: (await emailTask(l.id)).id })).error).toBe('');
    const follow = await emailTask(l.id, 'Follow-up 2');
    await db.update(tasks).set({ followUpRound: 2 }).where(eq(tasks.id, follow.id));
    calls = [];
    expect((await send({ id: follow.id })).error).toMatch(/No email template is assigned to Follow-up 2 for Other/);
    expect(graphCalls()).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, follow.id)))[0].doneAt).toBeNull();
  });

  it('refuses, and sends nothing: someone else\'s company, an unsaved address, no mailbox, a step already sent', async () => {
    const l = await lead();
    const t = await emailTask(l.id);
    // Not connected yet.
    expect((await send({ id: t.id })).error).toMatch(/Connect your Outlook/);
    expect(graphCalls()).toEqual([]);
    expect(await db.select().from(sentEmails)).toEqual([]);

    await connect();
    calls = [];
    const other = (await db.select().from(users).where(eq(users.role, 'bda')))[1];
    const theirs = await emailTask(l.id, 'Day 1', other.id);
    expect((await send({ id: theirs.id })).error).toMatch(/Only the person this company belongs to/);
    expect((await send({ id: t.id, to: 'someone@else.com', subject: 's', body: 'b' })).error).toMatch(/one of the addresses saved/);

    // Already being sent (another tab): never twice.
    await db.insert(sentEmails).values({ leadId: l.id, taskId: t.id, userId: me.id, toAddress: 'ravi@hosurgears.in' });
    expect((await send({ id: t.id })).error).toBe('This email is already being sent. Refresh the page.');
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

describe('Microsoft not answering', () => {
  it("a send that isn't confirmed is held (it may have gone): no second send for ten minutes, and the person is told to check Sent Items", async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    hang = '/sendMail';
    expect((await send({ id: t.id })).error).toMatch(/didn't confirm the email went\. Check your Sent Items/);
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
    expect((await db.select().from(sentEmails))[0].status).toBe('unconfirmed');
    // Not sent again straight away, even though Microsoft is back.
    hang = null;
    calls = [];
    expect((await send({ id: t.id })).error).toMatch(/may have gone/);
    expect(graphCalls()).toEqual([]);
    // Ten minutes on, it can be tried again.
    await db.update(sentEmails).set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(sentEmails.taskId, t.id));
    expect((await send({ id: t.id })).error).toBe('');
    expect(graphCalls().filter((c) => c.url.endsWith('/me/sendMail'))).toHaveLength(1);
  });

  it('a sign-in that gets no answer says so in plain words', async () => {
    await connect();
    const l = await lead();
    hang = '/oauth2/v2.0/token';
    expect((await send({ id: (await emailTask(l.id)).id })).error).toBe("Microsoft didn't answer. Try again in a minute.");
  });

  it('comparing the sign-in state never fails on unusual text', async () => {
    const { safeEqual } = await import('@/lib/safe-equal');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('é', 'ab')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('emails sent by hand (Mark sent)', () => {
  const { completeTaskAction, undoTaskAction } = { completeTaskAction: async (f: FormData) => (await import('@/app/team-actions')).completeTaskAction(f), undoTaskAction: async (f: FormData) => (await import('@/app/team-actions')).undoTaskAction(f) };

  it('after the first email is marked sent, a later email step (Call again) is a follow-up from its own template, never the first email again', async () => {
    await connect();
    const l = await lead();
    await completeTaskAction(form({ id: (await emailTask(l.id)).id, outcome: 'done' }));
    const again = await emailTask(l.id, 'Call again');
    calls = [];
    expect((await send({ id: again.id })).error).toBe('');
    const m = JSON.parse(graphCalls().find((c) => c.url.endsWith('/me/sendMail'))!.body).message;
    expect(m.subject).toBe('Re: Stock checks at Hosur Gears');
    expect(written(m.body.content)).toBe('Hi Ravi,\n\nJust following up.');
  });

  it('a follow-up marked sent uses up its draft (the next round asks for a new one), and Undo puts it back', async () => {
    const { planEmail } = await import('@/lib/mail/plan');
    const sentAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const l = await lead({ mailOutcome: 'Sent', sentAt, status: 'Contacted', followUpSubject: 'Re: Stock checks', followUpBody: 'Hi Ravi, following up.' });
    const t = await emailTask(l.id, 'Follow-up 1');
    await completeTaskAction(form({ id: t.id, outcome: 'done' }));
    let [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ followUpBody: '', followUpSubject: '', followUpStep: 1 });
    expect(planEmail(after, undefined, { from: 'INVECK Sales Team', as: 'Puja' }).body).toBe('');

    await undoTaskAction(form({ id: t.id }));
    [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after).toMatchObject({ followUpBody: 'Hi Ravi, following up.', followUpSubject: 'Re: Stock checks', followUpStep: 0, mailOutcome: 'Sent' });
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].followUpFrom).toBe('');
  });

  it('Undo of the first email marked sent: it is the first email again', async () => {
    const { planEmail } = await import('@/lib/mail/plan');
    const l = await lead();
    const t = await emailTask(l.id);
    await completeTaskAction(form({ id: t.id, outcome: 'done' }));
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].mailOutcome).toBe('Sent');
    await undoTaskAction(form({ id: t.id }));
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.mailOutcome).toBe('');
    expect(planEmail(after, undefined, { from: 'INVECK Sales Team', as: 'Puja' }).followUp).toBe(false);
  });

  it('an email sent from Outlook stays sent when its step is undone', async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    expect((await send({ id: t.id })).error).toBe('');
    await undoTaskAction(form({ id: t.id }));
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].mailOutcome).toBe('Sent');
    // And it can't go twice: it is only to be logged.
    calls = [];
    expect((await send({ id: t.id })).error).toMatch(/^This email already went from Outlook \(.+\): click Mark sent to log it\.$/);
    expect(graphCalls()).toEqual([]);
  });
});

describe('what the next email is', () => {
  it('the template of the step: first contact until they have been emailed, then follow-up n; a step with none is a problem, never a draft', async () => {
    const { planEmail } = await import('@/lib/mail/plan');
    const { loadTemplateSet } = await import('@/lib/config');
    const templates = await loadTemplateSet(db);
    const l = await lead({ emailBody: 'An AI draft that must never be used.', followUpBody: 'Neither this one.' });
    expect(planEmail(l, undefined, { templates, owner: 'Puja' })).toMatchObject({ followUp: false, subject: 'Stock checks at Hosur Gears', html: true, problem: '' });
    // Emailed by hand on Day 1 (marked sent): Follow-up 1 is a follow-up, as a new email, from its own template.
    const marked = { ...l, mailOutcome: 'Sent' };
    expect(planEmail(marked, undefined, { templates, owner: 'Puja', step: 1 })).toMatchObject({ followUp: true, subject: 'Re: Stock checks at Hosur Gears', problem: '' });
    // Follow-up 2 has no template: nothing is written for it.
    const two = planEmail(marked, undefined, { templates, owner: 'Puja', step: 2 });
    expect(two).toMatchObject({ followUp: true, subject: '', body: '' });
    expect(two.problem).toMatch(/No email template is assigned to Follow-up 2 for Other/);
    // No configured templates at all: the same, for any ICP without a built-in one.
    expect(planEmail(l, undefined, { owner: 'Puja' }).problem).toMatch(/first contact/);
    // Any email marked as gone counts, on any step; a bounce never arrived.
    expect(planEmail({ ...l, mailOutcome: 'No reply' }, undefined, { templates }).followUp).toBe(true);
    expect(planEmail({ ...l, mailOutcome: 'Bounced' }, undefined, { templates }).followUp).toBe(false);
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

describe('Microsoft 365 rules', () => {
  it("sends only from the lead owner's mailbox: a company owned by someone else is refused, nothing goes", async () => {
    await connect();
    const other = (await db.select().from(users).where(eq(users.role, 'bda')))[1];
    const l = await lead({ ownerId: other.id });
    const t = await emailTask(l.id); // the step is the signed-in person's, the company is not
    calls = [];
    expect((await send({ id: t.id })).error).toMatch(/Only the person this company belongs to/);
    expect(graphCalls()).toEqual([]);
    expect(await db.select().from(sentEmails)).toEqual([]);
  });

  it('one mailbox links to one CRM user only', async () => {
    await connect();
    const { connectMailbox } = await import('@/lib/mail/outlook');
    const other = (await db.select().from(users).where(eq(users.role, 'bda')))[1];
    await expect(connectMailbox(db, other.id, 'good-code', 'https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback')).rejects.toThrow(/already connected to another team member/);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.userId, other.id))).toEqual([]);
  });

  it('the redirect address is exactly the registered one, and a short encryption key keeps Outlook off', async () => {
    const { mailConfig, redirectUriFor } = await import('@/lib/mail/outlook');
    expect(redirectUriFor(mailConfig()!, 'http://localhost:3000')).toBe('https://inveck-lead-engine.vercel.app/api/auth/microsoft/callback');
    process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = 'too-short';
    expect(mailConfig()).toBeNull();
  });

  it('attaches the product profile PDF when it is there, and sends without one until it is', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadProfilePdf, PROFILE_FILES, GENERAL_PROFILE_FILE } = await import('@/lib/mail/profile-pdf');
    const dir = await mkdtemp(join(tmpdir(), 'profile-'));
    expect(await loadProfilePdf('Manufacturing', dir)).toBeNull();
    await writeFile(join(dir, PROFILE_FILES.manufacturing), Buffer.from('%PDF-1.4 manufacturing'));
    await writeFile(join(dir, PROFILE_FILES['3pl']), Buffer.from('%PDF-1.4 3pl'));
    const pdf = await loadProfilePdf('Manufacturing', dir);
    expect(pdf).toMatchObject({ name: 'INVECK Product Profile.pdf', contentType: 'application/pdf' });
    expect(pdf!.bytes.toString()).toContain('manufacturing');
    expect((await loadProfilePdf('3PL & Logistics', dir))!.bytes.toString()).toContain('3pl');
    // No file for CA firms (or another segment) until the general one is added.
    expect(await loadProfilePdf('CA Firms', dir)).toBeNull();
    await writeFile(join(dir, GENERAL_PROFILE_FILE), Buffer.from('%PDF-1.4 general'));
    expect((await loadProfilePdf('CA Firms', dir))!.bytes.toString()).toContain('general');
    await writeFile(join(dir, PROFILE_FILES.manufacturing), Buffer.alloc(3 * 1024 * 1024 + 1));
    await expect(loadProfilePdf('Manufacturing', dir)).rejects.toThrow(/too large/);

    // In the request Graph gets: base64 file attachment.
    const { sendFromMailbox } = await import('@/lib/mail/outlook');
    await connect();
    calls = [];
    await sendFromMailbox(db, me.id, { to: 'ravi@hosurgears.in', subject: 's', body: 'b', attachments: [pdf!] });
    const att = JSON.parse(graphCalls()[0].body).message.attachments[0];
    expect(att).toMatchObject({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'INVECK Product Profile.pdf', contentType: 'application/pdf' });
    expect(Buffer.from(att.contentBytes, 'base64').length).toBe(pdf!.bytes.length);
  });
});

describe('first emails for Manufacturing and 3PL', () => {
  const sentMessage = () => JSON.parse(graphCalls().find((c) => c.url.endsWith('/me/sendMail'))!.body).message;

  it('Manufacturing: the fixed email with the contact and the owner filled in, and its own PDF', async () => {
    await connect();
    const l = await lead({ segment: 'Manufacturing', contactName: 'Mr. Ravi Kumar' });
    const t = await emailTask(l.id);
    calls = [];
    expect((await send({ id: t.id })).error).toBe('');
    const m = sentMessage();
    expect(m.subject).toBe('Inventory verification and reconciliation application');
    expect(written(m.body.content).startsWith('Hello Mr. Ravi Kumar,\n\nI hope you\'re doing well.\n\nI am Parimal, leading Business Development at Inveck.')).toBe(true);
    expect(m.body.content).toContain('* Achieve an ROI of 30–40% by automating key verification steps');
    expect(written(m.body.content).endsWith('Looking forward to hearing from you.')).toBe(true);
    expect(plain(m.body.content)).toMatch(/\| Inveck India/);
    expect(m.body.content).not.toMatch(/\{\{|INVECK Sales Team/);
    expect(Buffer.from(m.attachments[0].contentBytes, 'base64').toString()).toContain('manufacturing');
    expect(m.toRecipients[0].emailAddress.address).toBe('ravi@hosurgears.in');
  });

  it('3PL and warehousing: the 3PL email and the 3PL PDF', async () => {
    await connect();
    const l = await lead({ segment: '3PL & Logistics', contactName: 'Asha Rao' });
    const t = await emailTask(l.id);
    calls = [];
    expect((await send({ id: t.id })).error).toBe('');
    const m = sentMessage();
    expect(m.subject).toBe('Inveck - Digitalizing Physical Inventory Verification for 3PL Operations');
    expect(written(m.body.content).startsWith('Dear Mr. Asha Rao,\n\nThank you for connecting with us on LinkedIn.\n\nI’m Parimal, leading Business Development.')).toBe(true);
    expect(written(m.body.content).endsWith('Looking forward to connecting.')).toBe(true);
    expect(Buffer.from(m.attachments[0].contentBytes, 'base64').toString()).toContain('3pl');
  });

  it('CA firms have no email template until one is assigned: nothing is drafted or sent, and no Manufacturing or 3PL template or PDF is used', async () => {
    await connect();
    const l = await lead({ segment: 'CA Firms' });
    const t = await emailTask(l.id);
    calls = [];
    expect((await send({ id: t.id })).error).toMatch(/No email template is assigned to the first contact for CA Firms/);
    expect(graphCalls()).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
  });

  it('a missing contact name or owner stops the send with a clear message, even from the review form', async () => {
    await connect();
    const noName = await lead({ segment: 'Manufacturing', contactName: '  ' });
    calls = [];
    expect((await send({ id: (await emailTask(noName.id)).id })).error).toMatch(/main contact's name is missing/);
    const t2 = await emailTask(noName.id, 'Day 2');
    expect((await send({ id: t2.id, subject: 'x', body: 'Hello Mr. ,' })).error).toMatch(/missing in the CRM/);
    expect(graphCalls()).toEqual([]);
    const { firstEmailFor } = await import('@/lib/mail/first-email');
    expect(firstEmailFor({ segment: '3PL & Logistics', contactName: 'Asha' }, '')).toMatchObject({ problem: expect.stringContaining("owner's name is missing") });
    expect(firstEmailFor({ segment: '3PL & Logistics', contactName: '' }, null)).toMatchObject({ problem: expect.stringContaining('are missing') });
    expect(firstEmailFor({ segment: 'CA Firms', contactName: '' }, null)).toBeNull();
  });

  it('the name comes from the lead owner record', async () => {
    const { firstEmailFor } = await import('@/lib/mail/first-email');
    expect(firstEmailFor({ segment: 'Manufacturing', contactName: 'Ravi Kumar' }, 'Anuradha')!.body).toContain('I am Anuradha, leading');
  });

  it('refuses to send a templated email without its PDF, and keeps the step open', async () => {
    await connect();
    const { rm } = await import('node:fs/promises');
    await rm(join(assets.dir, 'inveck-profile-manufacturing.pdf'));
    const l = await lead({ segment: 'Manufacturing' });
    const t = await emailTask(l.id);
    calls = [];
    expect((await send({ id: t.id })).error).toMatch(/Manufacturing profile PDF isn't on the server/);
    expect(graphCalls()).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
  });
});

describe('editing the email before it is sent', () => {
  it("an edit changes only that email: recipient, subject and attachment as before, and the saved draft is untouched", async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    calls = [];
    const r = await send({ id: t.id, to: 'ravi@hosurgears.in', subject: 'Stock checks at Hosur Gears', body: 'Hi Ravi,\r\n\r\nA reworded note, edited by hand.' });
    expect(r.error).toBe('');
    const message = JSON.parse(graphCalls().find((c) => c.url.endsWith('/me/sendMail'))!.body).message;
    expect(message.body.content).toContain('A reworded note, edited by hand.');
    expect(message.toRecipients[0].emailAddress.address).toBe('ravi@hosurgears.in');
    expect(message.subject).toBe('Stock checks at Hosur Gears');
    // The lead's saved draft is not replaced by the edited text.
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.emailBody).toContain('A quick note about your stock counts.');
    expect(after.emailBody).not.toContain('reworded');
    const [sent] = await db.select().from(sentEmails).where(eq(sentEmails.taskId, t.id));
    expect(sent.body).toContain('reworded');
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.includes('text edited before sending'))).toBe(true);
  });

  it('sending the review form without changing anything is not an edit (line breaks from the browser do not count)', async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    const { planEmail } = await import('@/lib/mail/plan');
    const { loadTemplateSet } = await import('@/lib/config');
    const plan = planEmail(l, undefined, { templates: await loadTemplateSet(db), owner: 'Puja' });
    expect((await send({ id: t.id, subject: plan.subject, body: plan.body })).error).toBe('');
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.includes('text edited before sending'))).toBe(false);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].emailBody).toContain('A quick note about your stock counts.');
  });
});

describe('the email signature', () => {
  const sentMessage = () => JSON.parse(graphCalls().find((c) => c.url.endsWith('/me/sendMail'))!.body).message;
  const count = (s: string, part: string) => s.split(part).length - 1;

  it("is the sender's own, with the logo inline, after the body, in HTML", async () => {
    await connect();
    const l = await lead();
    const t = await emailTask(l.id);
    calls = [];
    expect((await send({ id: t.id })).error).toBe('');
    const m = sentMessage();
    const html: string = m.body.content;
    expect(m.body.contentType).toBe('HTML');
    // The sender (the first team member here) with their own name and number.
    expect(html).toContain('Parimal Dhake | Inveck India');
    expect(html).toContain('Contact No: +91-8149991842');
    for (const other of ['Puja Mehta', 'Anchal Parekh', 'Anuradha Pohare', '+91-8149123078', '+91-7774042851', '+91-7522988834']) expect(html).not.toContain(other);
    expect(html).toContain('Thanks &amp; Regards,');
    expect(html).toContain('Corporate Office:');
    expect(html).toContain('Red Building, Boat Club Road, DP Road,');
    expect(html).toContain('Pune – 411001');
    expect(html).toContain('<a href="https://inveck.com/"');
    expect(html).toContain('privileged and confidential material of AK Finserv');
    // After what was written, and once.
    expect(html.indexOf('A quick note about your stock counts.')).toBeLessThan(html.indexOf('Thanks &amp; Regards,'));
    expect(count(html, 'Business Development')).toBe(1);
    // The logo travels with the email (inline, by Content-ID), as a PNG: no file path or link to the CRM.
    const logo = m.attachments.find((a: { isInline?: boolean }) => a.isInline);
    expect(logo).toMatchObject({ contentType: 'image/png', isInline: true, contentId: 'inveck-email-logo' });
    expect(html).toContain('src="cid:inveck-email-logo"');
    expect(Buffer.from(logo.contentBytes, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(html).not.toMatch(/src="(?!cid:)|assets\//);
  });

  it('names and numbers come from each account, not one person', async () => {
    const { signerOf } = await import('@/lib/mail/signature');
    const bdas = await db.select().from(users).where(eq(users.role, 'bda'));
    const seen = new Map(await Promise.all(bdas.map(async (u) => [u.name, await signerOf(db, u.id)] as const)));
    expect(seen.get('Parimal')).toEqual({ name: 'Parimal Dhake', phone: '+91-8149991842' });
    expect(seen.get('Puja')).toEqual({ name: 'Puja Mehta', phone: '+91-8149123078' });
    expect(seen.get('Anchal')).toEqual({ name: 'Anchal Parekh', phone: '+91-7774042851' });
    expect(seen.get('Anuradha')).toEqual({ name: 'Anuradha Pohare', phone: '+91-7522988834' });
    // A person without a number: no contact line, never someone else's.
    const { signatureHtml } = await import('@/lib/mail/signature');
    expect(signatureHtml({ name: 'New Person', phone: '' }, false)).not.toContain('Contact No');
  });

  it('is not added twice when the text already carries it', async () => {
    const { sendFromMailbox } = await import('@/lib/mail/outlook');
    const { signatureHtml } = await import('@/lib/mail/signature');
    await connect();
    const typed = 'Hi team,\n\nBody.\n\nThanks & Regards,\nPuja Mehta | Inveck India\nBusiness Development';
    calls = [];
    await sendFromMailbox(db, me.id, { to: 'a@b.in', subject: 's', body: typed });
    const html: string = sentMessage().body.content;
    expect(count(html, 'Inveck India')).toBe(1);
    expect(html).not.toContain('AK Finserv');
    expect(sentMessage().attachments).toBeUndefined();
    // Nothing else looks like a signature: a plain mention is still signed.
    calls = [];
    await sendFromMailbox(db, me.id, { to: 'a@b.in', subject: 's', body: 'We are Inveck India fans' });
    expect(count(sentMessage().body.content, 'Business Development')).toBe(1);
    expect(signatureHtml({ name: 'X', phone: '1' }, true)).toContain('cid:inveck-email-logo');
  });

  it('stays out of WhatsApp messages', async () => {
    const { buildWhatsApp } = await import('@/lib/whatsapp-outreach');
    const r = buildWhatsApp({ segment: 'Manufacturing', company: 'Acme', contactName: 'Ravi Shah', contactPhone: '9876543210' }, 'Puja');
    expect(r.ok && /AK Finserv|Boat Club|Inveck India|<br>/.test(r.text)).toBe(false);
  });
});

describe('email templates for every step', () => {
  const sentMessage = () => JSON.parse(graphCalls().find((c) => c.url.endsWith('/me/sendMail'))!.body).message;
  const mfg = async () => {
    const { listIcps, defaultProduct } = await import('@/lib/config');
    const product = (await defaultProduct(db))!;
    const icp = (await listIcps(db, product.id)).find((i) => i.segment === 'Manufacturing')!;
    return { product, icp };
  };
  const followUpTask = async (leadId: number, round: number) =>
    (await db.insert(tasks).values({ leadId, ownerId: me.id, kind: 'email', step: `Follow-up ${round}`, title: `Follow-up ${round}: email`, dueDate: istDay(), slot: 'day', followUpRound: round }).returning())[0];

  it('carries the old email templates over as each ICP\'s first-contact template, and the steps follow the follow-up rule', async () => {
    const { emailStepsFor, listEmailAssignments, listEmailTemplates, listIcps, saveFollowupRule, followupRuleFor } = await import('@/lib/config');
    const { product, icp } = await mfg();
    const first = (await listEmailTemplates(db, product.id)).find((t) => t.icpId === icp.id)!;
    expect(first).toMatchObject({ name: 'First contact', subject: 'Inventory verification and reconciliation application' });
    expect(first.body).toContain('<p');
    expect((await listEmailAssignments(db, product.id)).find((a) => a.icpId === icp.id && a.step === 0)?.templateId).toBe(first.id);
    // First contact + the 5 follow-ups of the default rule; CA firms (3 rounds) get 3; CA has no email template yet.
    expect((await emailStepsFor(db, product.id, icp.id)).map((s) => s.label)).toEqual(['First contact', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3', 'Follow-up 4', 'Follow-up 5']);
    const ca = (await listIcps(db, product.id)).find((i) => i.segment === 'CA Firms')!;
    expect((await emailStepsFor(db, product.id, ca.id)).length).toBe(4);
    expect((await listEmailAssignments(db, product.id)).some((a) => a.icpId === ca.id)).toBe(false);
    // Change the rule: the list changes with it.
    const rule = (await followupRuleFor(db, product.id, icp.id)).rule;
    await saveFollowupRule(db, product.id, icp.id, { ...rule, rounds: 2 });
    expect((await emailStepsFor(db, product.id, icp.id)).length).toBe(3);
  });

  it('a follow-up step sends its own template as HTML: bold kept, nothing unsafe, signature once, template untouched by an edit', async () => {
    const { saveEmailTemplate, assignEmailTemplate, listEmailTemplates } = await import('@/lib/config');
    const { emailTemplates } = await import('@/lib/db/schema');
    await connect();
    const { product, icp } = await mfg();
    // Formatting pasted from Word: a bold span; plus things that must never reach an email.
    const saved = await saveEmailTemplate(db, product.id, icp.id, {
      name: 'Follow-up one',
      subject: 'Following up, {{company_name}}',
      body: '<p>Hi <span style="font-weight:700">{{first_name}}</span>,</p><p>See <a href="https://inveck.com/demo" onclick="x()">our demo</a> <a href="javascript:alert(1)">bad</a><script>alert(1)</script></p>',
    });
    expect(saved.ok).toBe(true);
    const id = saved.ok ? saved.id : 0;
    expect(await assignEmailTemplate(db, product.id, icp.id, 1, id)).toEqual({ ok: true });
    const [row] = await listEmailTemplates(db, product.id).then((all) => all.filter((t) => t.id === id));
    expect(row.body).toContain('<strong>{{first_name}}</strong>');
    expect(row.body).not.toMatch(/script|onclick|javascript:/);
    expect(row.body).toContain('<a href="https://inveck.com/demo">our demo</a>');

    const l = await lead({ segment: 'Manufacturing', mailOutcome: 'Sent', contactName: 'Ravi <b>Kumar</b>', emailBody: 'old' });
    const t = await followUpTask(l.id, 1);
    calls = [];
    expect((await send({ id: t.id })).error).toBe('');
    let m = sentMessage();
    expect(m.subject).toBe('Following up, Hosur Gears');
    expect(m.body.contentType).toBe('HTML');
    expect(m.body.content).toContain('<strong>Ravi</strong>');
    expect(m.body.content).toContain('<a href="https://inveck.com/demo">our demo</a>');
    expect(m.body.content).not.toMatch(/<script|onclick|javascript:/);
    expect((m.body.content.match(/Business Development/g) ?? []).length).toBe(1);

    // A different follow-up with no template of its own: nothing is sent, and the AI draft on the lead is not used.
    const l2 = await lead({ segment: 'Manufacturing', mailOutcome: 'Sent', contactEmail: 'b@x.in', followUpSubject: 'Re: x', followUpBody: 'The AI draft.' });
    const t2 = await followUpTask(l2.id, 2);
    calls = [];
    expect((await send({ id: t2.id })).error).toMatch(/No email template is assigned to Follow-up 2 for Manufacturing/);
    expect(graphCalls()).toEqual([]);

    // Editing one email (review form) changes only that email: the saved template is as it was.
    const l3 = await lead({ segment: 'Manufacturing', mailOutcome: 'Sent', contactEmail: 'c@x.in' });
    const t3 = await followUpTask(l3.id, 1);
    calls = [];
    expect((await send({ id: t3.id, to: 'c@x.in', subject: 'Custom subject', body: '<p>Edited <b>bold</b> text</p><script>x</script>' })).error).toBe('');
    m = sentMessage();
    expect(m.subject).toBe('Custom subject');
    expect(m.body.content).toContain('Edited <strong>bold</strong> text');
    expect(m.body.content).not.toContain('<script');
    const [after] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
    expect(after.body).toBe(row.body);
    expect(after.subject).toBe('Following up, {{company_name}}');
  });

  it('refuses a template that is empty, has no subject, or uses an unknown variable, and a step can only use its own ICP\'s template', async () => {
    const { saveEmailTemplate, assignEmailTemplate, deleteEmailTemplate, emailStepsFor, listEmailAssignments, listIcps } = await import('@/lib/config');
    const { product, icp } = await mfg();
    expect(await saveEmailTemplate(db, product.id, icp.id, { name: 'A', subject: 'S', body: '<p> </p>' })).toMatchObject({ ok: false });
    expect(await saveEmailTemplate(db, product.id, icp.id, { name: 'A', subject: '', body: '<p>x</p>' })).toMatchObject({ ok: false });
    expect(await saveEmailTemplate(db, product.id, icp.id, { name: 'A', subject: 'S', body: '<p>{{nope}}</p>' })).toMatchObject({ ok: false, error: expect.stringContaining('{{nope}}') });
    const made = await saveEmailTemplate(db, product.id, icp.id, { name: 'Mine', subject: 'S', body: '<p>x</p>' });
    const other = (await listIcps(db, product.id)).find((i) => i.segment === '3PL & Logistics')!;
    expect(await assignEmailTemplate(db, product.id, other.id, 1, made.ok ? made.id : 0)).toMatchObject({ ok: false });
    expect(await assignEmailTemplate(db, product.id, icp.id, 9, made.ok ? made.id : 0)).toMatchObject({ ok: false });
    // Deleting a template leaves its steps without one (flagged), not pointing at nothing.
    await assignEmailTemplate(db, product.id, icp.id, 2, made.ok ? made.id : 0);
    await deleteEmailTemplate(db, product.id, made.ok ? made.id : 0);
    expect((await listEmailAssignments(db, product.id)).some((a) => a.icpId === icp.id && a.step === 2)).toBe(false);
    expect((await emailStepsFor(db, product.id, icp.id)).length).toBe(6);
  });
});
