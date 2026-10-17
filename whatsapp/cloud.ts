import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WhatsApp from INVECK's business number, through Meta's official WhatsApp Cloud API. Set up once in
 * Meta (see README); the details come from the server's environment, never from the database or the
 * screen: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN (a permanent System User token), WHATSAPP_APP_SECRET
 * (proves webhook calls come from Meta) and WHATSAPP_VERIFY_TOKEN (any random string, also typed into
 * Meta's webhook setup). WHATSAPP_GRAPH_VERSION is optional.
 */
const GRAPH = 'https://graph.facebook.com';
const VERSION = 'v25.0';
const TIMEOUT_MS = 30_000;

export type WaConfig = { phoneNumberId: string; token: string; appSecret: string; verifyToken: string; version: string };

const env = (name: string) => (process.env[name] || '').trim().replace(/^["']|["']$/g, '').replace(/^bearer\s+/i, '').trim();

/** The WhatsApp setup, or null until all of it is on the server. */
export function waConfig(): WaConfig | null {
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID');
  const token = env('WHATSAPP_TOKEN');
  const appSecret = env('WHATSAPP_APP_SECRET');
  if (!phoneNumberId || !token || !appSecret) return null;
  return { phoneNumberId, token, appSecret, verifyToken: env('WHATSAPP_VERIFY_TOKEN'), version: env('WHATSAPP_GRAPH_VERSION') || VERSION };
}

/** A problem worth telling the person about, with Meta's error code (0 when there is none). */
export class WaError extends Error {
  constructor(
    message: string,
    readonly code = 0,
  ) {
    super(message);
  }
}

/** Meta's error codes, in plain words (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
export function waErrorText(code: number | undefined, detail: string): string {
  switch (code) {
    case 131047:
      return 'More than 24 hours since they last wrote to INVECK: only the approved template can go now.';
    case 131026:
      return "WhatsApp couldn't deliver it: the number may not be on WhatsApp, or their app is out of date.";
    case 131049:
      return 'WhatsApp held this marketing message back, to keep people from getting too many. Try again in a day or two.';
    case 131050:
      return 'They have stopped marketing messages from INVECK in WhatsApp.';
    case 131030:
      return "This number isn't on the test recipients list in Meta: a test number can only message numbers added there.";
    case 131048:
    case 131056:
    case 130429:
    case 80007:
      return "WhatsApp is limiting messages from INVECK's number right now. Try again later.";
    case 132000:
    case 132001:
    case 132005:
    case 132007:
    case 132012:
    case 132015:
    case 132016:
      return "The WhatsApp template in Settings doesn't match the one Meta approved: check its name, language and {{1}} {{2}} {{3}} fields.";
    case 190:
      return 'The WhatsApp access token has expired or was revoked: put a new one in Vercel (WHATSAPP_TOKEN).';
    case 133010:
      return "INVECK's WhatsApp number isn't registered on the Cloud API yet (Meta's WhatsApp Manager).";
    case 131042:
      return "Meta couldn't charge for this message: check the payment method in Meta Business Manager.";
    default:
      return `WhatsApp didn't send it: ${detail.split(/\r?\n/)[0].slice(0, 200)}`;
  }
}

export type WaOutgoing = { to: string; text: string } | { to: string; template: { name: string; language: string; params: string[] } };

/** Sends one message from INVECK's number; returns WhatsApp's id for it (status updates refer to it). */
export async function sendWhatsApp(c: WaConfig, msg: WaOutgoing): Promise<{ wamid: string }> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: msg.to };
  const body =
    'text' in msg
      ? { ...base, type: 'text', text: { preview_url: false, body: msg.text } }
      : {
          ...base,
          type: 'template',
          template: {
            name: msg.template.name,
            language: { code: msg.template.language },
            ...(msg.template.params.length ? { components: [{ type: 'body', parameters: msg.template.params.map((text) => ({ type: 'text', text })) }] } : {}),
          },
        };
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${c.version}/${encodeURIComponent(c.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // It may still have gone: say so, rather than invite a second copy straight away.
    throw new WaError("WhatsApp didn't answer, so this may or may not have gone. Wait a few minutes before sending again.");
  }
  const data = (await res.json().catch(() => ({}))) as {
    messages?: { id?: string }[];
    error?: { code?: number; message?: string; error_data?: { details?: string } };
  };
  const wamid = data.messages?.[0]?.id;
  if (!res.ok || !wamid) {
    const e = data.error ?? {};
    throw new WaError(waErrorText(e.code, e.error_data?.details || e.message || `HTTP ${res.status}`), e.code ?? 0);
  }
  return { wamid };
}

/** Whether a webhook call really comes from Meta: its X-Hub-Signature-256 is the body signed with the app secret. */
export function validSignature(c: WaConfig, raw: Buffer | string, header: string | null): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  if (!m) return false;
  const want = createHmac('sha256', c.appSecret).update(raw).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
