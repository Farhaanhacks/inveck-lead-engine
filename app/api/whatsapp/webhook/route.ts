import { getDb } from '@/lib/db';
import { validSignature, waConfig } from '@/lib/whatsapp/cloud';
import { handleWebhook } from '@/lib/whatsapp/webhook';
import { safeEqual } from '@/lib/safe-equal';

export const dynamic = 'force-dynamic';

/** Meta checks the webhook once, when it is set up: it must echo the challenge for our verify token. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const verify = (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim();
  if (verify && q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') ?? '', verify)) {
    return new Response(q.get('hub.challenge') ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

/**
 * Replies and delivery updates for INVECK's WhatsApp number, from Meta. Public (no login), so only
 * calls signed with the app secret are read. Meta sends a call again until it gets a 200.
 */
export async function POST(req: Request) {
  const c = waConfig();
  if (!c) return new Response('WhatsApp is not set up', { status: 503 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (!validSignature(c, raw, req.headers.get('x-hub-signature-256'))) return new Response('Bad signature', { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  try {
    await handleWebhook(await getDb(), c, payload);
  } catch (e) {
    console.error('[whatsapp] webhook failed:', e);
    return new Response('Error', { status: 500 });
  }
  return new Response('OK', { status: 200 });
}
