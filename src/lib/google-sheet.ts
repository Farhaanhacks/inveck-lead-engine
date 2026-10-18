import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Reads a Google Sheet as a service account (read-only), with no library: the key signs a short-lived
 * token. The key stays on the server and is never logged or sent to the browser.
 *
 * Configuration (environment variables, like every other secret here):
 * - GOOGLE_SERVICE_ACCOUNT_JSON: the whole service-account key file, as JSON (or base64 of it). Use this on Vercel.
 * - GOOGLE_SERVICE_ACCOUNT_FILE: a path to the key file. For local development only (ignored on Vercel).
 */
export type GoogleCredentials = { client_email: string; private_key: string };

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 30_000;

function parseKey(text: string): GoogleCredentials | null {
  const raw = text.trim();
  for (const candidate of [raw, (() => { try { return Buffer.from(raw, 'base64').toString('utf8'); } catch { return ''; } })()]) {
    try {
      const j = JSON.parse(candidate) as Partial<GoogleCredentials>;
      if (j.client_email && j.private_key) return { client_email: j.client_email, private_key: j.private_key };
    } catch {}
  }
  return null;
}

/** The service account's credentials, or null until they are configured. Never throws, never logs the key. */
export function googleCredentials(env: NodeJS.ProcessEnv = process.env): GoogleCredentials | null {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) return parseKey(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const file = env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  if (file && !env.VERCEL) {
    try {
      return parseKey(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

const b64 = (x: unknown) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
let cached: { token: string; until: number } | null = null;

async function accessToken(c: GoogleCredentials, fetchFn: typeof fetch): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(c.private_key).toString('base64url');
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed: ${data.error_description || data.error || `HTTP ${res.status}`}`.slice(0, 200));
  cached = { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/** Every row of a tab as text (the first row is the headers). */
export async function readTab(spreadsheetId: string, tab: string, c: GoogleCredentials, fetchFn: typeof fetch = fetch): Promise<string[][]> {
  const token = await accessToken(c, fetchFn);
  const res = await fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab)}?majorDimension=ROWS`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { values?: unknown[][]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Sheets: ${data.error?.message ?? `HTTP ${res.status}`}`.slice(0, 200));
  return (data.values ?? []).map((r) => r.map((cell) => String(cell ?? '').trim()));
}
