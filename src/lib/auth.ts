// Sessions: a signed cookie that says who is logged in ("admin" for the shared password,
// "u7" for a team member). Uses Web Crypto so it also runs in the proxy.

export const SESSION_COOKIE = 'inveck_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

async function hmac(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function appPassword(): string {
  return process.env.APP_PASSWORD || '';
}

/** Without APP_PASSWORD the app is open, which is only allowed outside production. */
export function authDisabled(): boolean {
  return !appPassword() && process.env.NODE_ENV !== 'production';
}

function sessionSecret(): string {
  return process.env.SESSION_SECRET || appPassword() || process.env.CRON_SECRET || '';
}

/** The cookie value for a login: "<who>.<expiry>.<signature>". */
export async function createSession(subject: string): Promise<string> {
  const body = `${subject}.${Math.floor(Date.now() / 1000) + SESSION_MAX_AGE}`;
  return `${body}.${await hmac(sessionSecret(), 'inveck-session-v2:' + body)}`;
}

/** Who the cookie belongs to, or null when it is missing, forged or expired. */
export async function readSession(cookieValue: string | undefined): Promise<string | null> {
  const secret = sessionSecret();
  if (!cookieValue || !secret) return null;
  const cut = cookieValue.lastIndexOf('.');
  if (cut < 0) return null;
  const body = cookieValue.slice(0, cut);
  const given = cookieValue.slice(cut + 1);
  const expected = await hmac(secret, 'inveck-session-v2:' + body);
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const [subject, expiry] = body.split('.');
  if (!subject || !(Number(expiry) > Date.now() / 1000)) return null;
  return subject;
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  if (authDisabled()) return true;
  return (await readSession(cookieValue)) !== null;
}

/** Secret for the cron job and for a run handing itself to the next invocation. */
export async function runSecret(): Promise<string> {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  return hmac(appPassword() || 'dev', 'inveck-run-v1');
}
