import { createSign } from 'node:crypto';

export type ServiceAccount = { client_email: string; private_key: string };

/** Accepts the key file's JSON as-is, or base64 of it (easier to keep in one environment variable). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw.trim(), 'base64').toString('utf8');
  let json: Partial<ServiceAccount>;
  try {
    json = JSON.parse(text) as Partial<ServiceAccount>;
  } catch {
    throw new Error('The Google service account key is not valid JSON (or base64 of JSON).');
  }
  if (!json.client_email || !json.private_key) throw new Error('The service account key is missing client_email or private_key.');
  return { client_email: json.client_email, private_key: json.private_key.replace(/\\n/g, '\n') };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Server-to-server Google sign-in (service account JWT bearer flow). Tokens are cached until shortly before they expire. */
export class GoogleAuth {
  private cached?: { token: string; expiresAt: number };
  constructor(private readonly account: ServiceAccount, private readonly scope: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async token(now = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;
    const iat = Math.floor(now / 1000);
    const claims = { iss: this.account.client_email, scope: this.scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 };
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key);
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return data.access_token;
  }
}
