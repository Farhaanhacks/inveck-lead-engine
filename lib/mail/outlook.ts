import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import { mailboxes, type Mailbox } from '../db/schema';

/**
 * Sending email from each team member's own Outlook mailbox (Microsoft 365), through Microsoft's
 * official sign-in and Microsoft Graph. The app is registered once in Microsoft Entra (see README);
 * its details come from the server's environment, never from the database or the screen:
 * MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID (INVECK's tenant; "organizations" when unset) and
 * MAIL_TOKEN_KEY (a long random string the stored connections are encrypted with).
 */
const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Stay connected (refresh token), know the mailbox's address, and write, send and reply to mail. */
export const OUTLOOK_SCOPES = 'offline_access openid email User.Read Mail.ReadWrite';
/** Where Microsoft sends the person back after they sign in. */
export const CALLBACK_PATH = '/api/mail/callback';
/** The sign-in attempt, kept for ten minutes so the answer can be checked against it. */
export const STATE_COOKIE = 'mail_oauth_state';
const TIMEOUT_MS = 30_000;

export type MailConfig = { clientId: string; clientSecret: string; tenant: string; tokenKey: string };

/** The app registration, or null until all of it is set on the server. */
export function mailConfig(): MailConfig | null {
  const clientId = process.env.MS_CLIENT_ID?.trim();
  const clientSecret = process.env.MS_CLIENT_SECRET?.trim();
  const tokenKey = process.env.MAIL_TOKEN_KEY?.trim();
  if (!clientId || !clientSecret || !tokenKey) return null;
  return { clientId, clientSecret, tenant: process.env.MS_TENANT_ID?.trim() || 'organizations', tokenKey };
}

/** A problem worth telling the person about. `reconnect`: their Outlook connection has to be made again. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly reconnect = false,
    readonly status = 0,
  ) {
    super(message);
  }
}

// Stored connections are encrypted (AES-256-GCM); a database copy alone can't send mail.
const keyOf = (c: MailConfig) => createHash('sha256').update(c.tokenKey).digest();

export function seal(c: MailConfig, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(c), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function unseal(c: MailConfig, sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new MailError('The saved Outlook connection is unreadable: connect Outlook again on the Account page.', true);
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(c), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    // MAIL_TOKEN_KEY changed since it was saved.
    throw new MailError('The saved Outlook connection can no longer be read: connect Outlook again on the Account page.', true);
  }
}

/** Microsoft's sign-in page for this app, coming back to `redirectUri` with `state`. */
export function authorizeUrl(c: MailConfig, redirectUri: string, state: string): string {
  const u = new URL(`${LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES,
    state,
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

type Tokens = { accessToken: string; refreshToken?: string };

/** Microsoft didn't answer (network, timeout): status 0, unlike a refusal. */
const noAnswer = () => new MailError("Microsoft didn't answer. Try again in a minute.", false, 0);

async function token(c: MailConfig, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, scope: OUTLOOK_SCOPES, ...params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw noAnswer();
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // invalid_grant: the connection was revoked, expired or the password changed.
    const reconnect = data.error === 'invalid_grant' || data.error === 'interaction_required';
    const why = (data.error_description || data.error || `HTTP ${res.status}`).split(/\r?\n/)[0].slice(0, 200);
    throw new MailError(reconnect ? 'Your Outlook connection has expired: connect Outlook again on the Account page.' : `Microsoft sign-in failed: ${why}`, reconnect, res.status);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

type GraphMessage = { id: string; conversationId?: string };

async function graph<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T | null> {
  const res: Response = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      // Ids that stay the same when a draft moves to Sent Items, so a follow-up can reply to it later.
      prefer: 'IdType="ImmutableId"',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw noAnswer();
  });
  if (res.status === 202 || res.status === 204) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new MailError(`Outlook didn't send it: ${(data.error?.message || `HTTP ${res.status}`).slice(0, 200)}`, res.status === 401, res.status);
  return data as T;
}

/** Finishes connecting: exchanges Microsoft's code for a lasting connection and saves it, encrypted. */
export async function connectMailbox(db: Db, userId: number, code: string, redirectUri: string): Promise<Mailbox> {
  const c = mailConfig();
  if (!c) throw new MailError("Outlook sending isn't set up on the server yet.");
  const t = await token(c, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!t.refreshToken) throw new MailError("Microsoft didn't allow the app to stay connected (offline access). Ask your Microsoft 365 administrator to allow it.");
  const me = await graph<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(t.accessToken, 'GET', '/me?$select=mail,userPrincipalName,displayName');
  const address = (me?.mail || me?.userPrincipalName || '').trim().toLowerCase();
  if (!address) throw new MailError("Microsoft didn't say which mailbox this is.");
  const row = { userId, address, displayName: me?.displayName ?? '', refreshToken: seal(c, t.refreshToken), connectedAt: new Date(), lastError: '' };
  const [saved] = await db.insert(mailboxes).values(row).onConflictDoUpdate({ target: mailboxes.userId, set: row }).returning();
  return saved;
}

export async function getMailbox(db: Db, userId: number): Promise<Mailbox | null> {
  if (!userId) return null;
  const [box] = await db.select().from(mailboxes).where(eq(mailboxes.userId, userId));
  return box ?? null;
}

export async function disconnectMailbox(db: Db, userId: number): Promise<void> {
  await db.delete(mailboxes).where(eq(mailboxes.userId, userId));
}

export type OutgoingMail = {
  to: string;
  subject: string;
  /** Plain text, sent as written. */
  body: string;
  /** Outlook's id of an earlier email to the same person: this one goes as a reply in its thread. */
  replyTo?: string;
};

/**
 * Sends one email from the person's own mailbox (it shows in their Sent Items). A follow-up goes as a
 * reply in the earlier email's thread; if that email can't be found any more, as a new email.
 */
export async function sendFromMailbox(db: Db, userId: number, mail: OutgoingMail): Promise<{ from: string; graphId: string; conversationId: string }> {
  const c = mailConfig();
  if (!c) throw new MailError("Outlook sending isn't set up on the server yet.");
  const box = await getMailbox(db, userId);
  if (!box) throw new MailError('Connect your Outlook on the Account page first.', true);
  let t: Tokens;
  try {
    t = await token(c, { grant_type: 'refresh_token', refresh_token: unseal(c, box.refreshToken) });
  } catch (e) {
    if (e instanceof MailError) await db.update(mailboxes).set({ lastError: e.message }).where(eq(mailboxes.userId, userId));
    throw e;
  }
  // Microsoft hands out a new refresh token now and then: keep the latest.
  await db
    .update(mailboxes)
    .set({ lastError: '', ...(t.refreshToken ? { refreshToken: seal(c, t.refreshToken) } : {}) })
    .where(eq(mailboxes.userId, userId));

  const recipients = [{ emailAddress: { address: mail.to } }];
  let draft: GraphMessage | null = null;
  if (mail.replyTo) {
    try {
      draft = await graph<GraphMessage>(t.accessToken, 'POST', `/me/messages/${encodeURIComponent(mail.replyTo)}/createReply`, {});
    } catch (e) {
      // The earlier email was deleted from the mailbox: send a new one instead.
      if (!(e instanceof MailError && e.status === 404)) throw e;
    }
  }
  if (draft) {
    // Outlook keeps the thread (RE: subject, the reply headers); the text is ours, quote included.
    await graph(t.accessToken, 'PATCH', `/me/messages/${encodeURIComponent(draft.id)}`, { body: { contentType: 'Text', content: mail.body }, toRecipients: recipients });
  } else {
    draft = await graph<GraphMessage>(t.accessToken, 'POST', '/me/messages', { subject: mail.subject, body: { contentType: 'Text', content: mail.body }, toRecipients: recipients });
  }
  if (!draft?.id) throw new MailError("Outlook didn't create the email.");
  try {
    await graph(t.accessToken, 'POST', `/me/messages/${encodeURIComponent(draft.id)}/send`);
  } catch (e) {
    // No answer: it may well have gone, so it is left where it is (in Sent Items, or Drafts).
    if (e instanceof MailError && e.status === 0) {
      throw new MailError("Outlook didn't confirm the email went. Check your Sent Items before sending again: if it's there, click Mark sent.", false, 0);
    }
    // Refused: don't leave the unsent draft in their Drafts folder.
    if (e instanceof MailError && e.status >= 400 && e.status < 500) {
      await graph(t.accessToken, 'DELETE', `/me/messages/${encodeURIComponent(draft.id)}`).catch(() => {});
    }
    throw e;
  }
  return { from: box.address, graphId: draft.id, conversationId: draft.conversationId ?? '' };
}
