import type { Contact } from './contacts';
import type { Services } from './services';
import { googleSearch, hunter } from './services';
import { errorMessage, splitName } from './text';
import { classifyLocal, fillPattern, lookupEmailFormat, patternLabel, personEmailHints } from './email-format';
import { apolloEmail, type ApolloResult } from './apollo';

export { fillPattern } from './email-format';

/**
 * Where an address came from, kept apart from whether it is verified: typed by the sales team, the
 * person's own address published on the company website or elsewhere on the web, Apollo, or
 * inferred from the company's email format. Hunter is no longer a source (only the mail-server check).
 */
export type EmailSource = 'manual' | 'website' | 'web' | 'apollo' | 'inferred';
/**
 * Our verdict on an address. `verified`: confirmed deliverable (by Apollo's own check, or the
 * mail-server check); `catch_all`: the company's server accepts every address, so this one can't be
 * confirmed; `unverified`: not confirmed either way; `invalid`: rejected by the mail server.
 */
export type Verification = 'verified' | 'catch_all' | 'unverified' | 'invalid';
/** For scoring reachability: valid, accept_all and likely count as an address to write to. */
export type EmailStatus = 'valid' | 'accept_all' | 'likely' | 'invalid' | 'unknown' | 'no email found';

export type EmailFormatUsed = { pattern: string; domain: string; strong: boolean; detail: string };
export type EmailResult = {
  email: string;
  status: EmailStatus;
  source: EmailSource | '';
  verification: Verification | '';
  /** Who confirmed a verified address. */
  verifiedBy?: 'Apollo' | 'mail-server check';
  /** Apollo's own email_status, exactly as returned (kept apart from our verdict). */
  providerStatus?: string;
  /** When Apollo returned the address (ISO date-time). */
  retrievedAt?: string;
  notes: string[];
  reason?: string;
  detail?: string;
  /** The company's email format, when one was found; used for the company's other people too. */
  format?: EmailFormatUsed;
};

/** How the readable email status names each source. */
export const SOURCE_LABELS: Record<EmailSource, string> = {
  manual: 'entered by the team',
  website: 'company website',
  web: 'found on the web',
  apollo: 'Apollo',
  inferred: "inferred from the company's email format",
};

/**
 * The readable email status: the source first, then our verdict, never one dressed up as the other.
 * "Apollo (Apollo status: extrapolated, retrieved 2026-10-04) · unverified".
 */
export function emailLabel(r: Pick<EmailResult, 'source' | 'verification' | 'verifiedBy' | 'providerStatus' | 'retrievedAt' | 'detail'>): string {
  if (!r.source) return '';
  const source =
    r.source === 'apollo'
      ? `Apollo (${[r.providerStatus && `Apollo status: ${r.providerStatus}`, r.retrievedAt && `retrieved ${r.retrievedAt.slice(0, 10)}`].filter(Boolean).join(', ')})`
      : r.source === 'inferred'
        ? `inferred${r.detail ? ` from the company's email format: ${r.detail}` : " from the company's email format"}`
        : SOURCE_LABELS[r.source];
  const verdict =
    r.verification === 'verified'
      ? `verified by ${r.verifiedBy ?? 'mail-server check'}`
      : r.verification === 'catch_all'
        ? "unverified: the company's mail server accepts every address, so it can't be checked individually"
        : r.verification === 'invalid'
          ? 'rejected by the mail server'
          : 'unverified';
  return `${source.replace(' ()', '')} · ${verdict}`;
}

// Tried, and kept only when the mail-server check confirms them, when the company's format is unknown.
const COMMON_FORMATS = ['{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{f}.{last}', '{first}_{last}'];
// Tried first when the person has a middle name: "Rabindra Pratap Singh" → rp.singh.
const MIDDLE_FORMATS = ['{f}{m}.{last}'];
// Shared inboxes, never a person.
const GENERIC_LOCAL = /^(info|sales|contact|enquir|inquir|hr|careers?|jobs|admin|support|marketing|mail|office|accounts?|finance|purchase|export|help|hello|investors?|cs|secretarial|compliance|grievance|feedback|media|pr|service|corporate|webmaster|noreply|no-reply)/;
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;

/**
 * The mail-server check (Hunter's email verifier, the one Hunter service still used): 'unknown' when
 * the check can't be made (no key, out of credits).
 */
export async function verifyEmail(svc: Services, email: string): Promise<{ status: Exclude<EmailStatus, 'likely' | 'no email found'>; error: string }> {
  if (!svc.keys.hunter) return { status: 'unknown', error: 'no email verification key (HUNTER_API_KEY)' };
  try {
    const data = await hunter<{ status?: string }>(svc, 'email-verifier', { email });
    const s = data.status;
    return { status: s === 'valid' || s === 'accept_all' || s === 'invalid' ? s : 'unknown', error: '' };
  } catch (e) {
    return { status: 'unknown', error: errorMessage(e) };
  }
}

const VERDICT: Record<string, Verification> = { valid: 'verified', accept_all: 'catch_all', invalid: 'invalid', unknown: 'unverified' };

/** The scoring status for a verdict: an unconfirmed address from Apollo or the company's format still counts as likely. */
function scoringStatus(v: Verification, source: EmailSource): EmailStatus {
  if (v === 'verified') return 'valid';
  if (v === 'catch_all') return 'accept_all';
  if (v === 'invalid') return 'invalid';
  return source === 'apollo' || source === 'inferred' ? 'likely' : 'unknown';
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

/** Apollo lookups left for this company; cached results don't use one. */
export type ApolloBudget = { left: number };

export type FindEmailContext = {
  company?: string;
  domain: string;
  websiteEmails: string[];
  webEmails?: string[];
  /** Apollo lookups this company may still spend; none when absent (no Apollo). */
  apollo?: ApolloBudget;
  /** The company's format already found (for the others at a company): skips looking it up again. */
  format?: EmailFormatUsed | null;
  /** Off for the others at a company: no people-search page search, no guessing common formats. */
  thorough?: boolean;
};

/**
 * Finds the contact's email. The order, most trustworthy first:
 *  1. an address the sales team typed in: always kept (checked only to label it)
 *  2. the person's own address published on the company website, the web or a people-search page,
 *     confirmed by the mail-server check
 *  3. Apollo (an identified contact: LinkedIn profile, name and employer), when nothing above is
 *     verified: Apollo's "verified" counts as verified; anything else gets the mail-server check
 *  4. a published address that couldn't be confirmed (catch-all server, check unavailable)
 *  5. Apollo's unconfirmed address
 *  6. inferred from the company's proven format: verified when the mail-server check confirms it,
 *     else saved as inferred (catch-all included) when the format is proven and the setting is on
 *  7. common formats, kept only when the mail-server check confirms them, labelled inferred
 * Source and verdict are kept apart; nothing is called verified unless Apollo's check or the mail
 * server confirmed it.
 */
export async function findEmail(svc: Services, contact: Contact, ctx: FindEmailContext): Promise<EmailResult> {
  const used: { format?: EmailFormatUsed } = {};
  const result = await findEmailInner(svc, contact, ctx, used);
  return used.format ? { ...result, format: used.format } : result;
}

async function findEmailInner(svc: Services, contact: Contact, ctx: FindEmailContext, used: { format?: EmailFormatUsed }): Promise<EmailResult> {
  const notes: string[] = [];
  const thorough = ctx.thorough !== false;
  const checked = new Map<string, Exclude<EmailStatus, 'likely' | 'no email found'>>();
  let checkError = '';
  let unconfirmable: '' | 'accept_all' | 'unknown' = '';
  let rejected = false;
  const none = (reason: string): EmailResult => ({ email: '', status: 'no email found', source: '', verification: '', notes, reason });
  const done = (email: string, source: EmailSource, v: Verification, extra: Partial<EmailResult> = {}): EmailResult => ({
    email,
    source,
    verification: v,
    status: scoringStatus(v, source),
    ...(v === 'verified' && !extra.verifiedBy ? { verifiedBy: 'mail-server check' as const } : {}),
    notes,
    ...extra,
  });
  const check = async (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return null;
    let status = checked.get(email);
    if (!status) {
      const v = await verifyEmail(svc, email);
      if (v.error) {
        notes.push(`Email check failed for ${email}: ${v.error}`);
        checkError ||= v.error;
      }
      status = v.status;
      checked.set(email, status);
    }
    if (status === 'invalid') rejected = true;
    return { email, status, verification: VERDICT[status] };
  };

  // 1. Typed in by the sales team: theirs to vouch for, never replaced.
  if (contact.email && contact.emailSource === 'manual') {
    const r = await check(contact.email);
    if (r) return done(r.email, 'manual', r.verification);
    return done(contact.email.trim(), 'manual', 'unverified');
  }

  const { first, last, middle } = splitName(contact.name);
  if (!first && !last) return none('no contact name');
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');

  // 2. The person's own address, published on the website, on the web or on people-search pages.
  let direct: { email: string; source: EmailSource; verification: Verification } | null = null;
  const webEmails = ctx.webEmails || [];
  const lists: [string[], EmailSource][] = [
    [ctx.websiteEmails, 'website'],
    [webEmails, 'web'],
  ];
  const person = thorough && ctx.company ? await personEmailHints(svc, contact.name, ctx.company, ctx.domain) : null;
  lists.push([person?.emails || [], 'web']);
  for (const [list, source] of lists) {
    for (const e of list) {
      if (!belongsTo(e.split('@')[0], f, l)) continue;
      const r = await check(e);
      if (!r || r.status === 'invalid') continue;
      if (r.verification === 'verified') return done(r.email, source, 'verified');
      direct ??= { email: r.email, source, verification: r.verification };
    }
  }

  // 3. Apollo, for an identified contact: before any address is built from a format.
  let apolloUnconfirmed: EmailResult | null = null;
  const apollo = ctx.apollo && ctx.company !== undefined ? await askApollo(svc, contact, ctx, notes) : null;
  if (apollo?.outcome === 'found') {
    const meta = { providerStatus: apollo.status, retrievedAt: apollo.retrievedAt };
    if (apollo.status === 'verified') {
      // The address published for them, now confirmed by Apollo, keeps its source.
      if (direct && direct.email === apollo.email) return done(direct.email, direct.source, 'verified', { verifiedBy: 'Apollo', ...meta });
      return done(apollo.email, 'apollo', 'verified', { verifiedBy: 'Apollo', ...meta });
    }
    // Apollo's own status isn't "verified": the mail-server check decides, and anything it can't
    // settle stays labelled unverified.
    const r = await check(apollo.email);
    if (r && r.status === 'invalid') notes.push(`Apollo's address ${apollo.email} was rejected by the mail server; not used`);
    else if (r?.verification === 'verified') return done(r.email, 'apollo', 'verified', meta);
    else apolloUnconfirmed = done(apollo.email, 'apollo', r?.verification ?? 'unverified', meta);
  }

  // 4–5. Unconfirmed direct addresses first, then Apollo's.
  if (direct) return done(direct.email, direct.source, direct.verification);
  if (apolloUnconfirmed) return apolloUnconfirmed;

  // 6. The company's proven email format.
  let domain = ctx.domain;
  let format: { pattern: string; strong: boolean; detail: string } | null = ctx.format ?? null;
  if (format && ctx.format) domain ||= ctx.format.domain;
  if (!format && person?.pattern) {
    format = { pattern: person.pattern, strong: true, detail: `${patternLabel(person.pattern)}, matches ${person.masked}` };
    domain ||= person.domain;
  } else if (!format && thorough && ctx.company) {
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
    if (r?.status === 'valid') return done(r.email, 'inferred', 'verified', { detail: format.detail });
    if (r && r.status !== 'invalid') {
      if (format.strong && svc.settings.useCompanyFormat && namesComplete(format.pattern, first, last)) {
        return done(r.email, 'inferred', r.verification, { detail: format.detail });
      }
      notes.push(`Inferred email (company's email format ${format.detail}, not confirmed, not saved): ${r.email}`);
      unconfirmable ||= r.status === 'accept_all' ? 'accept_all' : 'unknown';
    }
  }

  // 7. Common formats, kept only when the mail-server check confirms them. Pointless when the server
  //    can't confirm addresses or the check isn't answering.
  if (thorough && !unconfirmable && !checkError) {
    const formats = [...(middle ? MIDDLE_FORMATS : []), ...COMMON_FORMATS].filter((p) => p !== format?.pattern);
    let guesses = 0;
    for (const p of formats) {
      if (guesses >= svc.settings.maxEmailGuesses) break;
      const local = fillPattern(p, first, last, middle);
      if (!local) continue;
      guesses++;
      const r = await check(`${local}@${domain}`);
      if (!r) continue;
      if (r.status === 'valid') return done(r.email, 'inferred', 'verified', { detail: `${patternLabel(p)}, confirmed by the mail server` });
      if (r.status === 'accept_all' || r.status === 'unknown') {
        unconfirmable = r.status;
        break; // every other guess on this domain would get the same answer
      }
    }
  }

  if (checkError) return none(`email check unavailable: ${checkError.slice(0, 80)}`);
  if (unconfirmable === 'accept_all') {
    notes.push("No confirmed email: the company's mail server accepts every address, so addresses can't be verified.");
    return none("company's mail server can't confirm addresses");
  }
  if (unconfirmable === 'unknown') return none("the company's mail server didn't answer the email check");
  if (rejected) return none('the addresses tried were rejected by the mail server');
  if (apollo?.outcome === 'failed') return none(`Apollo lookup failed (${apollo.reason}); no other source had an email`);
  return none('no email found in any source');
}

/**
 * One Apollo lookup for the contact, within the company's budget (a cached result spends nothing).
 * What happened is noted either way: a match, no match, or a lookup that failed.
 */
async function askApollo(svc: Services, contact: Contact, ctx: FindEmailContext, notes: string[]): Promise<ApolloResult> {
  const q = { name: contact.name, company: ctx.company ?? '', domain: ctx.domain, linkedin: contact.linkedin };
  const budget = ctx.apollo!;
  const cached = await apolloEmail(svc, q, { cacheOnly: true });
  let r: ApolloResult = cached;
  if (cached.outcome === 'skipped' && cached.reason === 'no cached Apollo result') {
    if (budget.left <= 0) {
      notes.push(`Apollo not asked for ${contact.name}: this company's Apollo lookups are used up`);
      return { outcome: 'skipped', reason: 'budget' };
    }
    r = await apolloEmail(svc, q);
    if (r.outcome !== 'skipped' && !(r.outcome === 'failed' && r.kind === 'no_key')) budget.left--;
  }
  const who = contact.name;
  if (r.outcome === 'found') notes.push(`Apollo: ${r.email} for ${who} (Apollo status: ${r.status}${r.cached ? ', from an earlier lookup' : ''})`);
  else if (r.outcome === 'no_email' || r.outcome === 'not_found') notes.push(`Apollo: nothing for ${who}: ${r.reason}${r.cached ? ' (earlier lookup)' : ''}`);
  else if (r.outcome === 'failed') notes.push(r.kind === 'no_key' ? 'Apollo not set up (APOLLO_API_KEY missing)' : `Apollo lookup failed for ${who}: ${r.reason}`);
  else if (r.outcome === 'skipped') notes.push(`Apollo not asked for ${who}: ${r.reason}`);
  return r;
}
