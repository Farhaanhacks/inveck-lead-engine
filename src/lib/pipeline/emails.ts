import type { Contact } from './contacts';
import type { Services } from './services';
import { googleSearch, hunter } from './services';
import { errorMessage, splitName } from './text';
import { classifyLocal, fillPattern, lookupEmailFormat, patternLabel, personEmailHints } from './email-format';

export { fillPattern } from './email-format';

export type EmailSource = 'hunter' | 'manual' | 'website' | 'web' | 'pattern' | 'format' | 'hunter-finder';
/** `likely`: follows the company's proven email format, but its mail server can't confirm single addresses. */
export type EmailStatus = 'valid' | 'accept_all' | 'likely' | 'invalid' | 'unknown' | 'no email found';

export type EmailFormatUsed = { pattern: string; domain: string; strong: boolean; detail: string };
export type EmailResult = {
  email: string;
  status: EmailStatus;
  source: EmailSource | '';
  notes: string[];
  reason?: string;
  detail?: string;
  /** The company's email format, when one was found; used for the company's other people too. */
  format?: EmailFormatUsed;
};

export const SOURCE_LABELS: Record<EmailSource, string> = {
  hunter: 'Hunter',
  manual: 'sales team',
  website: 'company website',
  web: 'found on the web',
  pattern: "company's email format",
  format: 'common email format',
  'hunter-finder': 'Hunter finder',
};

// Tried, and kept only when Hunter confirms them, when the company's format is unknown.
const COMMON_FORMATS = ['{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{f}.{last}', '{first}_{last}'];
// Tried first when the person has a middle name: "Rabindra Pratap Singh" → rp.singh.
const MIDDLE_FORMATS = ['{f}{m}.{last}'];
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

/**
 * The company's email format, read off addresses of its people: "rp.singh", "a.kumar" → {f}.{last}.
 * '' unless at least `minVotes` addresses agree.
 */
export function inferPattern(emails: string[], minVotes = 1): string {
  const votes = new Map<string, number>();
  for (const e of emails) {
    const p = classifyLocal(e.split('@')[0]);
    if (p) votes.set(p, (votes.get(p) || 0) + 1);
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= minVotes ? best[0] : '';
}

/** Does this published address belong to the person? Needs their surname and first initial, or their first name. */
export function belongsTo(local: string, first: string, last: string): boolean {
  if (first.length > 2 && local.includes(first)) return true;
  return last.length > 2 && local.includes(last) && local.startsWith(first.charAt(0));
}

/** A format using the full first or last name needs that name, not just an initial. */
function namesComplete(pattern: string, first: string, last: string): boolean {
  return (!pattern.includes('{first}') || first.length > 1) && (!pattern.includes('{last}') || last.length > 1);
}

/**
 * Finds the contact's email, most trustworthy and cheapest first:
 *  1. an address that came with the contact (Hunter's company search, or typed in by the sales team)
 *  2. the person's address published on the company website or elsewhere on the web
 *  3. the person's address (or a masked version of it) on people-search pages and documents
 *  4. the company's proven email format: from Hunter, from the formats data providers publish
 *     (RocketReach, ZoomInfo…), or from several of its people's published addresses
 *  5. Hunter's email finder
 *  6. common formats, kept only when Hunter confirms them "valid"
 * An address built from a proven format is saved as "likely" when the company's mail server
 * can't confirm single addresses (like ZoomInfo does); plain guesses never are.
 */
export async function findEmail(
  svc: Services,
  contact: Contact,
  ctx: { company?: string; domain: string; pattern: string; websiteEmails: string[]; webEmails?: string[] },
): Promise<EmailResult> {
  const used: { format?: EmailFormatUsed } = {};
  const result = await findEmailInner(svc, contact, ctx, used);
  return used.format ? { ...result, format: used.format } : result;
}

async function findEmailInner(
  svc: Services,
  contact: Contact,
  ctx: { company?: string; domain: string; pattern: string; websiteEmails: string[]; webEmails?: string[] },
  used: { format?: EmailFormatUsed },
): Promise<EmailResult> {
  const notes: string[] = [];
  const checked = new Map<string, EmailStatus>();
  let hunterError = '';
  let unconfirmable: '' | 'accept_all' | 'unknown' = '';
  let rejected = false;
  const none = (reason: string): EmailResult => ({ email: '', status: 'no email found', source: '', notes, reason });
  const check = async (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return null;
    let status = checked.get(email);
    if (!status) {
      const v = await verifyEmail(svc, email);
      if (v.error) {
        notes.push(`Email check failed for ${email}: ${v.error}`);
        hunterError ||= v.error;
      }
      status = v.status;
      checked.set(email, status);
    }
    if (status === 'invalid') rejected = true;
    return { email, status };
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

  // 3. The person's own address on people-search pages and documents.
  const person = ctx.company ? await personEmailHints(svc, contact.name, ctx.company, ctx.domain) : null;
  for (const e of person?.emails || []) {
    if (!belongsTo(e.split('@')[0], f, l)) continue;
    const r = await check(e);
    if (r && r.status !== 'invalid') return { ...r, source: 'web', notes };
  }

  // 4. The company's proven email format.
  let domain = ctx.domain;
  let format: { pattern: string; strong: boolean; detail: string } | null = null;
  if (ctx.pattern) {
    format = { pattern: ctx.pattern, strong: true, detail: `${patternLabel(ctx.pattern)} per Hunter` };
  } else if (person?.pattern) {
    format = { pattern: person.pattern, strong: true, detail: `${patternLabel(person.pattern)}, matches ${person.masked}` };
    domain ||= person.domain;
  } else if (ctx.company) {
    const web = await lookupEmailFormat(svc, ctx.company, ctx.domain);
    if (web) {
      domain = web.domain || domain;
      format = { pattern: web.pattern, strong: web.strong, detail: `${patternLabel(web.pattern)}${web.share ? `, ${web.share}% of ${web.domain} emails` : ''}` };
    }
  }
  if (!format) {
    const inferred = inferPattern([...ctx.websiteEmails, ...webEmails, ...(person?.emails || [])], 2);
    if (inferred) format = { pattern: inferred, strong: true, detail: `${patternLabel(inferred)}, from the company's published addresses` };
  }
  domain ||= person?.domain || '';
  if (!domain) return none('company website unknown');
  if (format) used.format = { ...format, domain };

  if (format) {
    const local = fillPattern(format.pattern, first, last, middle);
    const r = local ? await check(`${local}@${domain}`) : null;
    if (r?.status === 'valid') return { ...r, source: 'pattern', notes, detail: format.detail };
    if (r && r.status !== 'invalid') {
      if (format.strong && svc.settings.useCompanyFormat && namesComplete(format.pattern, first, last)) {
        return { email: r.email, status: 'likely', source: 'pattern', notes, detail: format.detail };
      }
      notes.push(`Likely email (company's email format ${format.detail}, not confirmed, not saved): ${r.email}`);
      unconfirmable ||= r.status === 'accept_all' ? 'accept_all' : 'unknown';
    }
  }

  // 5. Hunter's finder. It reports its own check, so no extra credit is spent re-checking.
  try {
    const params: Record<string, string> = first && last ? { domain, first_name: first, last_name: last } : { domain, full_name: contact.name };
    const found = await hunter<{ email?: string | null; score?: number | null; verification?: { status?: string | null } }>(svc, 'email-finder', params);
    if (found.email) {
      const email = found.email.toLowerCase();
      const own = found.verification?.status;
      let status = checked.get(email);
      if (!status && (own === 'valid' || own === 'accept_all' || own === 'invalid')) checked.set(email, (status = own));
      if (!status) status = (await check(email))?.status;
      const weak = status !== 'valid' && typeof found.score === 'number' && found.score < 50;
      if (status && status !== 'invalid' && !weak) return { email, status, source: 'hunter-finder', notes };
      if (weak) notes.push(`Hunter's low-confidence suggestion (score ${found.score}), not saved: ${email}`);
    }
  } catch (e) {
    notes.push(`Email finder failed: ${errorMessage(e)}`);
    hunterError ||= errorMessage(e);
  }

  // 6. Common formats, kept only when Hunter confirms them. Pointless when the server can't
  //    confirm addresses or Hunter isn't answering.
  if (!unconfirmable && !hunterError) {
    const formats = [...(middle ? MIDDLE_FORMATS : []), ...COMMON_FORMATS].filter((p) => p !== format?.pattern);
    let guesses = 0;
    for (const p of formats) {
      if (guesses >= svc.settings.maxEmailGuesses) break;
      const local = fillPattern(p, first, last, middle);
      if (!local) continue;
      guesses++;
      const r = await check(`${local}@${domain}`);
      if (!r) continue;
      if (r.status === 'valid') return { ...r, source: 'format', notes };
      if (r.status === 'accept_all' || r.status === 'unknown') {
        unconfirmable = r.status;
        break; // every other guess on this domain would get the same answer
      }
    }
  }

  if (hunterError) return none(`Hunter error: ${hunterError.slice(0, 80)}`);
  if (unconfirmable === 'accept_all') {
    notes.push("No confirmed email: the company's mail server accepts every address, so addresses can't be verified.");
    return none("company's mail server can't confirm addresses");
  }
  if (unconfirmable === 'unknown') return none("the company's mail server didn't answer the email check");
  if (rejected) return none('the addresses tried were rejected by the mail server');
  return none('Hunter has no email for this person');
}
