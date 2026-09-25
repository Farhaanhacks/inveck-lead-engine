// Shared-password login. The session cookie holds an HMAC of the password, so changing
// APP_PASSWORD logs everyone out. Uses Web Crypto so it also runs in the proxy.

export const SESSION_COOKIE = 'inveck_session';

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

export async function sessionToken(): Promise<string> {
  return hmac(appPassword(), 'inveck-session-v1');
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  if (authDisabled()) return true;
  if (!appPassword() || !cookieValue) return false;
  const expected = await sessionToken();
  if (cookieValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= cookieValue.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Secret for the cron job and for a run handing itself to the next invocation. */
export async function runSecret(): Promise<string> {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  return hmac(appPassword() || 'dev', 'inveck-run-v1');
}
