import type { Contact } from './contacts';
import type { Services } from './services';
import { googleSearch } from './services';
import { splitName } from './text';
import { classifyLocal, fillPattern, lookupEmailFormat, patternLabel, personEmailHints } from './email-format';
import { apolloEmail, type PersonQuery, type ProviderResult } from './apollo';
import { prospeoEmail } from './prospeo';

export { fillPattern } from './email-format';

/**
 * Where an address came from, kept apart from whether it is verified: typed by the sales team, the
 * person's own address published on the company website or elsewhere on the web, an email provider
 * (Prospeo, Apollo), or inferred from the company's email format.
 */
export type EmailSource = 'manual' | 'website' | 'web' | 'prospeo' | 'apollo' | 'inferred';
export type ProviderSource = Extract<EmailSource, 'prospeo' | 'apollo'>;
export type ProviderName = 'Prospeo' | 'Apollo';
/**
 * Our verdict on an address. `verified`: confirmed deliverable by the provider's own check (Prospeo,
 * Apollo); `unverified`: not confirmed. `catch_all` and `invalid` come from the mail-server check
 * used before, and are only read on older rows.
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
  /** Who confirmed a verified address ('mail-server check' on older rows only). */
  verifiedBy?: ProviderName | 'mail-server check';
  /** The provider's own email status, exactly as returned (kept apart from our verdict). */
  providerStatus?: string;
  /** When the provider returned the address (ISO date-time). */
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
  prospeo: 'Prospeo',
  apollo: 'Apollo',
  inferred: "inferred from the company's email format",
};

/**
 * The readable email status: the source first, then our verdict, never one dressed up as the other.
 * "Apollo (Apollo status: extrapolated, retrieved 2026-10-04) · unverified".
 */
const PROVIDER_NAME: Record<ProviderSource, ProviderName> = { prospeo: 'Prospeo', apollo: 'Apollo' };

export function emailLabel(r: Pick<EmailResult, 'source' | 'verification' | 'verifiedBy' | 'providerStatus' | 'retrievedAt' | 'detail'>): string {
  if (!r.source) return '';
  const source =
    r.source === 'apollo' || r.source === 'prospeo'
      ? `${PROVIDER_NAME[r.source]} (${[r.providerStatus && `${PROVIDER_NAME[r.source]} status: ${r.providerStatus}`, r.retrievedAt && `retrieved ${r.retrievedAt.slice(0, 10)}`].filter(Boolean).join(', ')})`
      : r.source === 'inferred'
        ? `inferred${r.detail ? ` from the company's email format: ${r.detail}` : " from the company's email format"}`
        : SOURCE_LABELS[r.source];
  const verdict =
    r.verification === 'verified'
      ? `verified by ${r.verifiedBy ?? (r.source === 'apollo' || r.source === 'prospeo' ? PROVIDER_NAME[r.source] : 'mail-server check')}`
      : r.verification === 'catch_all'
        ? "unverified: the company's mail server accepts every address, so it can't be checked individually"
        : r.verification === 'invalid'
          ? 'rejected by the mail server'
          : 'unverified';
  return `${source.replace(' ()', '')} · ${verdict}`;
}

// Shared inboxes, never a person.
const GENERIC_LOCAL = /^(info|sales|contact|enquir|inquir|hr|careers?|jobs|admin|support|marketing|mail|office|accounts?|finance|purchase|export|help|hello|investors?|cs|secretarial|compliance|grievance|feedback|media|pr|service|corporate|webmaster|noreply|no-reply)/;
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;

/** The scoring status for a verdict: an address not verified (typed by the team, published, a provider's, inferred) still counts as one to write to. */
function scoringStatus(v: Verification): EmailStatus {
  if (v === 'verified') return 'valid';
  if (v === 'catch_all') return 'accept_all';
  if (v === 'invalid') return 'invalid';
  return 'likely';
}

/** People's addresses at the domain that Google has indexed (one search). */
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

/** Paid provider lookups left for this company; cached results don't use one. */
export type LookupBudget = { left: number };

export type EmailProvider = {
  name: ProviderName;
  source: ProviderSource;
  keyName: string;
  ready: (svc: Services) => boolean;
  lookup: (svc: Services, q: PersonQuery, opts?: { cacheOnly?: boolean }) => Promise<ProviderResult>;
};

/** The email providers, in the order they are asked: Prospeo first, Apollo when Prospeo has nothing verified. */
export const EMAIL_PROVIDERS: EmailProvider[] = [
  { name: 'Prospeo', source: 'prospeo', keyName: 'PROSPEO_API_KEY', ready: (svc) => !!svc.keys.prospeo, lookup: prospeoEmail },
  { name: 'Apollo', source: 'apollo', keyName: 'APOLLO_API_KEY', ready: (svc) => !!svc.keys.apollo, lookup: apolloEmail },
];

/** The providers with a key set, in order. */
export const emailProviders = (svc: Services) => EMAIL_PROVIDERS.filter((p) => p.ready(svc));

export type FindEmailContext = {
  company?: string;
  domain: string;
  websiteEmails: string[];
  webEmails?: string[];
  /** Provider lookups this company may still spend; none when absent (no provider is asked). */
  lookups?: LookupBudget;
  /** The company's format already found (for the others at a company): skips looking it up again. */
  format?: EmailFormatUsed | null;
  /** Off for the others at a company: no people-search page search, no format lookup on the web. */
  thorough?: boolean;
};

/**
 * Finds the contact's email. The order, most trustworthy first:
 *  1. an address the sales team typed in: always kept
 *  2. the person's own address published on the company website, the web or a people-search page
 *     (no paid lookup is spent then)
 *  3. the email providers, Prospeo then Apollo (an identified contact: LinkedIn profile, name and
 *     employer): an address the provider has verified, else one it hasn't
 *  4. inferred from the company's proven format, when the setting is on, labelled inferred
 * Source and verdict are kept apart: only a provider's own check makes an address verified.
 */
export async function findEmail(svc: Services, contact: Contact, ctx: FindEmailContext): Promise<EmailResult> {
  const used: { format?: EmailFormatUsed } = {};
  const result = await findEmailInner(svc, contact, ctx, used);
  return used.format ? { ...result, format: used.format } : result;
}

async function findEmailInner(svc: Services, contact: Contact, ctx: FindEmailContext, used: { format?: EmailFormatUsed }): Promise<EmailResult> {
  const notes: string[] = [];
  const thorough = ctx.thorough !== false;
  const none = (reason: string): EmailResult => ({ email: '', status: 'no email found', source: '', verification: '', notes, reason });
  const done = (email: string, source: EmailSource, v: Verification, extra: Partial<EmailResult> = {}): EmailResult => ({
    email,
    source,
    verification: v,
    status: scoringStatus(v),
    notes,
    ...extra,
  });
  const clean = (raw: string) => {
    const email = raw.trim().toLowerCase();
    return EMAIL_RE.test(email) ? email : '';
  };

  // 1. Typed in by the sales team: theirs to vouch for, never replaced.
  if (contact.email && contact.emailSource === 'manual') return done(clean(contact.email) || contact.email.trim(), 'manual', 'unverified');

  const { first, last, middle } = splitName(contact.name);
  if (!first && !last) return none('no contact name');
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');

  // 2. The person's own address, published on the website, on the web or on people-search pages.
  let direct: { email: string; source: EmailSource } | null = null;
  const webEmails = ctx.webEmails || [];
  const lists: [string[], EmailSource][] = [
    [ctx.websiteEmails, 'website'],
    [webEmails, 'web'],
  ];
  const person = thorough && ctx.company ? await personEmailHints(svc, contact.name, ctx.company, ctx.domain) : null;
  lists.push([person?.emails || [], 'web']);
  for (const [list, source] of lists) {
    for (const e of list) {
      const email = belongsTo(e.split('@')[0], f, l) ? clean(e) : '';
      if (email) {
        direct = { email, source };
        break;
      }
    }
    if (direct) break;
  }
  if (direct) return done(direct.email, direct.source, 'unverified');

  // 3. The email providers, for an identified contact.
  let providerUnconfirmed: EmailResult | null = null;
  let lookupFailed = '';
  if (ctx.lookups && ctx.company !== undefined) {
    const q = { name: contact.name, company: ctx.company, domain: ctx.domain, linkedin: contact.linkedin };
    for (const p of emailProviders(svc)) {
      const r = await askProvider(svc, p, q, ctx.lookups, notes);
      if (r.outcome === 'failed') lookupFailed ||= `${p.name} lookup failed (${r.reason})`;
      if (r.outcome !== 'found') continue;
      const meta = { providerStatus: r.status, retrievedAt: r.retrievedAt };
      if (r.status === 'verified') return done(r.email, p.source, 'verified', { verifiedBy: p.name, ...meta });
      // Not verified by the provider: kept as unverified (the next provider may have a verified one).
      providerUnconfirmed ??= done(r.email, p.source, 'unverified', meta);
    }
  }

  if (providerUnconfirmed) return providerUnconfirmed;

  // 4. The company's proven email format.
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
  if (!domain) return none(lookupFailed ? `${lookupFailed}; company website unknown` : 'company website unknown');
  if (format) used.format = { ...format, domain };

  if (format) {
    const local = fillPattern(format.pattern, first, last, middle);
    const email = local ? clean(`${local}@${domain}`) : '';
    if (email) {
      if (format.strong && svc.settings.useCompanyFormat && namesComplete(format.pattern, first, last)) return done(email, 'inferred', 'unverified', { detail: format.detail });
      notes.push(`Inferred email (company's email format ${format.detail}, not proven or switched off, not saved): ${email}`);
    }
  }

  if (lookupFailed) return none(`${lookupFailed}; no other source had an email`);
  return none('no email found in any source');
}

/**
 * One provider lookup for the contact, within the company's budget (a cached result spends nothing,
 * nor does a provider that isn't set up or is held back this run). What happened is noted either
 * way: a match, no match, or a lookup that failed.
 */
export async function askProvider(svc: Services, p: EmailProvider, q: PersonQuery, budget: LookupBudget, notes?: string[]): Promise<ProviderResult> {
  const cached = await p.lookup(svc, q, { cacheOnly: true });
  let r: ProviderResult = cached;
  if (cached.outcome === 'skipped' && cached.reason === `no cached ${p.name} result`) {
    if (budget.left <= 0) {
      notes?.push(`${p.name} not asked for ${q.name}: this company's email lookups are used up`);
      return { outcome: 'skipped', reason: 'budget' };
    }
    r = await p.lookup(svc, q);
    if (r.outcome !== 'skipped' && !(r.outcome === 'failed' && (r.kind === 'no_key' || r.held))) budget.left--;
  }
  const who = q.name;
  if (r.outcome === 'found') notes?.push(`${p.name}: ${r.email} for ${who} (${p.name} status: ${r.status}${r.cached ? ', from an earlier lookup' : ''})`);
  else if (r.outcome === 'no_email' || r.outcome === 'not_found') notes?.push(`${p.name}: nothing for ${who}: ${r.reason}${r.cached ? ' (earlier lookup)' : ''}`);
  else if (r.outcome === 'failed') notes?.push(r.kind === 'no_key' ? `${p.name} not set up (${p.keyName} missing)` : `${p.name} lookup failed for ${who}: ${r.reason}`);
  else if (r.outcome === 'skipped') notes?.push(`${p.name} not asked for ${who}: ${r.reason}`);
  return r;
}
