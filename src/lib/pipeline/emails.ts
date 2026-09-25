import type { Contact } from './contacts';
import type { Services } from './services';
import { hunter } from './services';
import { errorMessage, splitName } from './text';

export type EmailSource = 'hunter' | 'manual' | 'website' | 'pattern' | 'format' | 'hunter-finder';
export type EmailStatus = 'valid' | 'accept_all' | 'invalid' | 'unknown' | 'no email found';

export type EmailResult = { email: string; status: EmailStatus; source: EmailSource | ''; notes: string[] };

export const SOURCE_LABELS: Record<EmailSource, string> = {
  hunter: 'Hunter',
  manual: 'sales team',
  website: 'company website',
  pattern: "company's email format",
  format: 'common email format',
  'hunter-finder': 'Hunter finder',
};

const COMMON_FORMATS = ['{first}.{last}', '{f}{last}', '{first}{last}', '{first}', '{f}.{last}', '{first}_{last}'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;

/** Hunter's verdict on one address; 'unknown' when the check itself fails (e.g. out of credits). */
export async function verifyEmail(svc: Services, email: string): Promise<{ status: EmailStatus; error: string }> {
  try {
    const data = await hunter<{ status?: string }>(svc, 'email-verifier', { email });
    const s = data.status;
    return { status: s === 'valid' || s === 'accept_all' || s === 'invalid' ? s : 'unknown', error: '' };
  } catch (e) {
    return { status: 'unknown', error: errorMessage(e) };
  }
}

export function fillPattern(pattern: string, first: string, last: string): string {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  const local = pattern
    .replace(/{first}/g, f)
    .replace(/{last}/g, l)
    .replace(/{f}/g, f.charAt(0))
    .replace(/{l}/g, l.charAt(0));
  return /[{}]/.test(local) || !/^[a-z0-9._-]+$/.test(local) ? '' : local;
}

/**
 * Finds the contact's email, cheapest first, verifying one address at a time:
 *  1. an address that came with the contact (Hunter's company search, or typed in by the sales team)
 *  2. the person's address published on the company website
 *  3. the company's email format from Hunter, or else common formats
 *  4. Hunter's email finder
 * Known addresses are kept unless Hunter says invalid; guesses only when Hunter says valid.
 */
export async function findEmail(
  svc: Services,
  contact: Contact,
  ctx: { domain: string; pattern: string; websiteEmails: string[] },
): Promise<EmailResult> {
  const notes: string[] = [];
  const tried = new Set<string>();
  const check = async (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || tried.has(email)) return null;
    tried.add(email);
    const v = await verifyEmail(svc, email);
    if (v.error) notes.push(`Email check failed for ${email}: ${v.error}`);
    return { email, status: v.status };
  };

  // 1. Already known.
  if (contact.email) {
    const r = await check(contact.email);
    const source: EmailSource = contact.emailSource === 'manual' ? 'manual' : 'hunter';
    if (r && (source === 'manual' || r.status !== 'invalid')) return { ...r, source, notes };
  }

  const { first, last } = splitName(contact.name);
  if (!first && !last) return { email: '', status: 'no email found', source: '', notes };
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');

  // 2. Published on the company website.
  for (const e of ctx.websiteEmails) {
    const local = e.split('@')[0];
    if ((l.length > 1 && local.includes(l)) || (f.length > 2 && local.includes(f))) {
      const r = await check(e);
      if (r && r.status !== 'invalid') return { ...r, source: 'website', notes };
    }
  }

  if (!first || !last || !ctx.domain) return { email: '', status: 'no email found', source: '', notes };

  // 3. The company's format, or common formats. A guess must come back "valid"; on a
  //    catch-all server every address "works", so a guess there proves nothing.
  const formats = ctx.pattern ? [ctx.pattern] : COMMON_FORMATS.slice(0, svc.settings.maxEmailGuesses);
  const source: EmailSource = ctx.pattern ? 'pattern' : 'format';
  for (const format of formats) {
    const local = fillPattern(format, first, last);
    if (!local) continue;
    const r = await check(`${local}@${ctx.domain}`);
    if (!r) continue;
    if (r.status === 'valid') return { ...r, source, notes };
    if (r.status === 'accept_all') {
      notes.push(`Possible email (the company's mail server accepts every address, so it can't be verified): ${r.email}`);
      break; // every other guess on this domain would say the same
    }
  }

  // 4. Last resort: Hunter's finder.
  try {
    const found = await hunter<{ email?: string | null }>(svc, 'email-finder', { domain: ctx.domain, first_name: first, last_name: last });
    if (found.email) {
      const r = await check(found.email);
      if (r && r.status !== 'invalid') return { ...r, source: 'hunter-finder', notes };
    }
  } catch (e) {
    notes.push(`Email finder failed: ${errorMessage(e)}`);
  }
  return { email: '', status: 'no email found', source: '', notes };
}
