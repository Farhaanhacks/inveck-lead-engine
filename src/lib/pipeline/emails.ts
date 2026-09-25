import type { Contact } from './contacts';
import type { Services } from './services';
import { googleSearch, hunter } from './services';
import { errorMessage, splitName } from './text';

export type EmailSource = 'hunter' | 'manual' | 'website' | 'web' | 'pattern' | 'format' | 'hunter-finder';
export type EmailStatus = 'valid' | 'accept_all' | 'invalid' | 'unknown' | 'no email found';

export type EmailResult = { email: string; status: EmailStatus; source: EmailSource | ''; notes: string[]; reason?: string };

export const SOURCE_LABELS: Record<EmailSource, string> = {
  hunter: 'Hunter',
  manual: 'sales team',
  website: 'company website',
  web: 'found on the web',
  pattern: "company's email format",
  format: 'common email format',
  'hunter-finder': 'Hunter finder',
};

const COMMON_FORMATS = ['{first}.{last}', '{f}{last}', '{first}{last}', '{first}', '{f}.{last}', '{first}_{last}'];
// Tried first when the person has a middle name: "Rabindra Pratap Singh" → rp.singh.
const MIDDLE_FORMATS = ['{f}{m}.{last}', '{f}{m}{last}'];
// Shared inboxes, never a person.
const GENERIC_LOCAL = /^(info|sales|contact|enquir|inquir|hr|careers?|jobs|admin|support|marketing|mail|office|accounts?|finance|purchase|export|help|hello|investors?|cs|secretarial|compliance|grievance|feedback|media|pr|service|corporate|webmaster|noreply|no-reply)/;
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
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

export function fillPattern(pattern: string, first: string, last: string, middle = ''): string {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  const m = middle.toLowerCase().replace(/[^a-z]/g, '');
  if (pattern.includes('{m}') && !m) return '';
  const local = pattern
    .replace(/{first}/g, f)
    .replace(/{last}/g, l)
    .replace(/{f}/g, f.charAt(0))
    .replace(/{l}/g, l.charAt(0))
    .replace(/{m}/g, m);
  return /[{}]/.test(local) || !/^[a-z0-9._-]+$/.test(local) ? '' : local;
}

/** People's addresses at the domain that Google has indexed (one search, no Hunter credits). */
export async function searchWebEmails(svc: Services, domain: string): Promise<string[]> {
  if (!domain) return [];
  try {
    const results = await googleSearch(svc, `"@${domain}"`);
    const text = results.map((r) => `${r.title || ''} ${r.snippet || ''}`).join(' ');
    return personalEmails(text.match(EMAIL_IN_TEXT) || [], domain);
  } catch {
    return [];
  }
}

export function personalEmails(emails: string[], domain: string): string[] {
  const out = emails
    .map((e) => e.toLowerCase().replace(/\.+$/, ''))
    .filter((e) => e.endsWith('@' + domain) && !GENERIC_LOCAL.test(e.split('@')[0]));
  return [...new Set(out)];
}

/** The company's email format, read off addresses of its people: "rp.singh", "a.kumar" → {f}{m}.{last}/{f}.{last}. */
export function inferPattern(emails: string[]): string {
  const votes = new Map<string, number>();
  for (const e of emails) {
    const local = e.split('@')[0];
    let p = '';
    if (/^[a-z]\.[a-z]{3,}$/.test(local)) p = '{f}.{last}';
    else if (/^[a-z]{2}\.[a-z]{3,}$/.test(local)) p = '{f}{m}.{last}';
    else if (/^[a-z]{3,}\.[a-z]{3,}$/.test(local)) p = '{first}.{last}';
    else if (/^[a-z]{3,}_[a-z]{3,}$/.test(local)) p = '{first}_{last}';
    if (p) votes.set(p, (votes.get(p) || 0) + 1);
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  if (!best) return '';
  // Two initials only happen for people with a middle name; the same company writes others as {f}.{last}.
  return best[0] === '{f}{m}.{last}' ? '{f}{m}.{last}' : best[0];
}

/** Does this published address belong to the person? Needs their surname and first initial, or their first name. */
function belongsTo(local: string, first: string, last: string): boolean {
  if (first.length > 2 && local.includes(first)) return true;
  return last.length > 2 && local.includes(last) && local.startsWith(first.charAt(0));
}

/**
 * Finds the contact's email, cheapest first, verifying one address at a time:
 *  1. an address that came with the contact (Hunter's company search, or typed in by the sales team)
 *  2. the person's address published on the company website or elsewhere on the web
 *  3. the company's email format (from Hunter, or learned from its addresses on the web), then common formats
 *  4. Hunter's email finder
 * Known and published addresses are kept unless Hunter says invalid. A guessed address is
 * only ever used when Hunter confirms it "valid"; unconfirmed guesses are never saved.
 */
export async function findEmail(
  svc: Services,
  contact: Contact,
  ctx: { domain: string; pattern: string; websiteEmails: string[]; webEmails?: string[] },
): Promise<EmailResult> {
  const notes: string[] = [];
  const tried = new Set<string>();
  let hunterError = '';
  const none = (reason: string): EmailResult => ({ email: '', status: 'no email found', source: '', notes, reason });
  const check = async (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || tried.has(email)) return null;
    tried.add(email);
    const v = await verifyEmail(svc, email);
    if (v.error) {
      notes.push(`Email check failed for ${email}: ${v.error}`);
      hunterError ||= v.error;
    }
    return { email, status: v.status };
  };

  // 1. Already known.
  if (contact.email) {
    const r = await check(contact.email);
    const source: EmailSource = contact.emailSource === 'manual' ? 'manual' : 'hunter';
    if (r && (source === 'manual' || r.status !== 'invalid')) return { ...r, source, notes };
  }

  const { first, last, middle } = splitName(contact.name);
  if (!first && !last) return none('no contact name');
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');

  // 2. Published on the company website, or anywhere Google has seen it.
  const webEmails = ctx.webEmails || [];
  for (const [list, source] of [[ctx.websiteEmails, 'website'], [webEmails, 'web']] as const) {
    for (const e of list) {
      if (!belongsTo(e.split('@')[0], f, l)) continue;
      const r = await check(e);
      if (r && r.status !== 'invalid') return { ...r, source, notes };
    }
  }

  if (!ctx.domain) return none('company website unknown');
  if (!first || !last) return none('need a first and last name');

  // 3. The company's format, then common formats. A guess must come back "valid"; on a
  //    catch-all server every address "works", so a guess there proves nothing.
  const pattern = ctx.pattern || inferPattern([...ctx.websiteEmails, ...webEmails]);
  const common = [...(middle ? MIDDLE_FORMATS : []), ...COMMON_FORMATS].filter((p) => p !== pattern);
  const formats = [
    ...(pattern ? [{ format: pattern, source: 'pattern' as const }] : []),
    ...common.slice(0, Math.max(0, svc.settings.maxEmailGuesses - (pattern ? 1 : 0))).map((format) => ({ format, source: 'format' as const })),
  ];
  let unconfirmable = '';
  for (const { format, source } of formats) {
    const local = fillPattern(format, first, last, middle);
    if (!local) continue;
    const r = await check(`${local}@${ctx.domain}`);
    if (!r) continue;
    if (r.status === 'valid') return { ...r, source, notes };
    if (r.status === 'accept_all' || r.status === 'unknown') {
      unconfirmable = r.status === 'accept_all' ? "the company's mail server accepts every address" : 'the email check was unavailable';
      // Every other guess on this domain would get the same answer.
      break;
    }
  }

  // 4. Last resort: Hunter's finder. It reports its own check, so no extra credit is spent re-checking.
  try {
    const found = await hunter<{ email?: string | null; verification?: { status?: string | null } }>(svc, 'email-finder', {
      domain: ctx.domain,
      first_name: first,
      last_name: last,
    });
    if (found.email && !tried.has(found.email.toLowerCase())) {
      const own = found.verification?.status;
      const r =
        own === 'valid' || own === 'accept_all' || own === 'invalid'
          ? (tried.add(found.email.toLowerCase()), { email: found.email.toLowerCase(), status: own as EmailStatus })
          : await check(found.email);
      if (r && r.status !== 'invalid') return { ...r, source: 'hunter-finder', notes };
    }
  } catch (e) {
    notes.push(`Email finder failed: ${errorMessage(e)}`);
    hunterError ||= errorMessage(e);
  }

  if (unconfirmable) notes.push(`No confirmed email: ${unconfirmable}, so addresses can't be verified.`);
  if (hunterError) return none(`Hunter error: ${hunterError.slice(0, 80)}`);
  if (unconfirmable === "the company's mail server accepts every address") return none("company's mail server can't confirm addresses");
  return none('Hunter has no email for this person');
}
