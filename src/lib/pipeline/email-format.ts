import type { SerperResult, Services } from './services';
import { googleSearch } from './services';
import { rootDomain, searchName, splitName } from './text';
import { domainScore, nameTokens } from './website';

/**
 * Company email formats. Data providers (RocketReach, ZoomInfo, LeadIQ, email-format sites)
 * publish each company's format for search engines, e.g. "The most common Honeywell email
 * format is [first].[last] (ex. jane.doe@honeywell.com) being used 88.4% of the time".
 * Reading those through Google costs one search and no Hunter credits.
 */

/** Builds the local part of an address from a format like "{first}.{last}"; '' when a needed name part is missing. */
export function fillPattern(pattern: string, first: string, last: string, middle = ''): string {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  const m = middle.toLowerCase().replace(/[^a-z]/g, '');
  if ((/{first}|{f}/.test(pattern) && !f) || (/{last}|{l}/.test(pattern) && !l) || (pattern.includes('{m}') && !m)) return '';
  const local = pattern
    .replace(/{first}/g, f)
    .replace(/{last}/g, l)
    .replace(/{f}/g, f.charAt(0))
    .replace(/{l}/g, l.charAt(0))
    .replace(/{m}/g, m);
  return /[{}]/.test(local) || !/^[a-z0-9._-]+$/.test(local) ? '' : local;
}

/** "{first}.{last}" → "first.last", for people to read. */
export function patternLabel(pattern: string): string {
  return pattern.replace(/[{}]/g, '');
}

/** Every format we know how to build, most common first. */
export const ALL_PATTERNS = [
  '{first}.{last}', '{first}', '{f}{last}', '{first}{last}', '{f}.{last}', '{first}_{last}', '{first}-{last}',
  '{last}.{first}', '{last}{first}', '{last}{f}', '{last}.{f}', '{last}_{first}', '{first}.{l}', '{first}{l}', '{last}',
];

// Names the providers use in their example addresses.
const EXAMPLE_NAMES: [string, string][] = [
  ['jane', 'doe'], ['john', 'doe'], ['john', 'smith'], ['jane', 'smith'], ['first', 'last'], ['firstname', 'lastname'],
];

/** The format behind an example address: "jane.doe" → {first}.{last}, "doejane" → {last}{first}. */
export function patternFromExample(local: string): string {
  for (const [first, last] of EXAMPLE_NAMES) {
    for (const p of ALL_PATTERNS) if (fillPattern(p, first, last) === local) return p;
  }
  return '';
}

/** A likely format read off a real person's address: "rp.singh" → {f}{m}.{last}, "ravi.shah" → {first}.{last}. */
export function classifyLocal(local: string): string {
  if (/^[a-z]\.[a-z]{3,}$/.test(local)) return '{f}.{last}';
  if (/^[a-z]{2}\.[a-z]{3,}$/.test(local)) return '{f}{m}.{last}';
  if (/^[a-z]{3,}\.[a-z]{3,}$/.test(local)) return '{first}.{last}';
  if (/^[a-z]{3,}_[a-z]{3,}$/.test(local)) return '{first}_{last}';
  return '';
}

// Formats written out in words: "first.last", "[first_initial][last]", "firstname.lastname", "first initial + last name".
const TOKEN = {
  first: 'first[ _-]?name|first',
  last: 'last[ _-]?name|surname|last',
  f: 'first[ _-]?initial|f',
  l: 'last[ _-]?initial|l',
} as const;
type Tok = keyof typeof TOKEN;
const wrap = (t: Tok) => `[\\[{(<]?(?:${TOKEN[t]})[\\]})>]?`;
const PAIRS: [Tok, Tok][] = [['first', 'last'], ['f', 'last'], ['first', 'l'], ['last', 'first'], ['last', 'f']];
const SEPS: [string, string][] = [['.', '\\.'], ['_', '_'], ['-', '-'], ['', '\\s*\\+\\s*'], ['', '']];
const WORD_PATTERNS = [
  ...PAIRS.flatMap(([a, b]) =>
    SEPS.map(([sep, re]) => ({ pattern: `{${a}}${sep}{${b}}`, re: new RegExp(`(?<![a-z0-9])${wrap(a)}${re}${wrap(b)}(?![a-z0-9])`, 'g') })),
  ),
  { pattern: '{first}', re: /[[{(<](?:first[ _-]?name|first)[\]})>]\s*@/g },
  { pattern: '{last}', re: /[[{(<](?:last[ _-]?name|surname|last)[\]})>]\s*@/g },
];
const ADDRESS = /([a-z0-9*][a-z0-9*._-]{0,40})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g;

type Mention = { start: number; end: number; pattern: string; base: number; domain?: string };

function findMentions(text: string, acceptDomain: (d: string) => boolean): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    const [whole, local, dom] = m;
    if (local.includes('*') || !acceptDomain(dom)) continue;
    const example = patternFromExample(local);
    const pattern = example || classifyLocal(local);
    if (pattern) out.push({ start: m.index, end: m.index + whole.length, pattern, base: example ? 40 : 20, domain: rootDomain(dom) });
  }
  for (const { re, pattern } of WORD_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (out.some((o) => start >= o.start && start < o.end)) continue; // part of an address already counted
      if (!/@|%|format|pattern|e-?mail/.test(text.slice(Math.max(0, start - 60), end + 30))) continue;
      out.push({ start, end, pattern, base: 40 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export type EmailFormat = { pattern: string; share?: number; domain: string; strong: boolean };

/**
 * The company's email format from search results about it. Only results that name the
 * company and show its domain count, so another company's format is never used.
 * `strong` means the evidence is good enough to use an address that can't be mailbox-checked.
 */
export function parseEmailFormat(company: string, websiteDomain: string, results: SerperResult[]): EmailFormat | null {
  const tokens = nameTokens(company);
  const site = rootDomain(websiteDomain);
  // The company's own domain, or (when it has several) one that is clearly its name, like johndeere.com.
  const acceptDomain = (d: string) => {
    const root = rootDomain(d);
    return root === site || domainScore(company, root) >= 3;
  };
  const votes = new Map<string, { weight: number; share: number; results: Set<number> }>();
  const domainVotes = new Map<string, number>();

  results.slice(0, 10).forEach((r, i) => {
    const text = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
    if (!tokens.some((t) => text.includes(t))) return;
    const mentions = findMentions(text, acceptDomain);
    const domains = mentions.map((m) => m.domain).filter((d): d is string => !!d);
    if (site && text.includes(site)) domains.push(site);
    if (!domains.length) return; // can't tell whose format this is
    for (const d of domains) domainVotes.set(d, (domainVotes.get(d) || 0) + 1);

    mentions.forEach((m, j) => {
      const next = mentions[j + 1];
      const after = text.slice(m.end, Math.min(next ? next.start : Infinity, m.end + 90));
      const pct = after.match(/(\d{1,3}(?:\.\d+)?)\s?%/);
      const share = pct && Number(pct[1]) <= 100 ? Number(pct[1]) : 0;
      const before = text.slice(Math.max(0, m.start - 80), m.start);
      const boost = /most (?:common|used|popular)|typically|primary|standard|usually/.test(before) ? 30 : 0;
      const v = votes.get(m.pattern) || { weight: 0, share: 0, results: new Set<number>() };
      v.weight += (share || m.base) + boost;
      v.share = Math.max(v.share, share);
      v.results.add(i);
      votes.set(m.pattern, v);
    });
  });

  const top = [...votes].sort((a, b) => b[1].weight - a[1].weight)[0];
  if (!top) return null;
  const [pattern, v] = top;
  const domain = site && domainVotes.has(site) ? site : [...domainVotes].sort((a, b) => b[1] - a[1])[0]?.[0] || site;
  if (!domain) return null;
  const strong = v.share >= 40 || (!v.share && (v.weight >= 70 || v.results.size >= 2));
  return { pattern, share: v.share || undefined, domain, strong };
}

/** Looks the company's email format up on Google (one Serper search). */
export async function lookupEmailFormat(svc: Services, company: string, websiteDomain: string): Promise<EmailFormat | null> {
  const name = searchName(company);
  if (!name) return null;
  try {
    return parseEmailFormat(company, websiteDomain, await googleSearch(svc, `"${name}" email format`));
  } catch {
    return null;
  }
}

/**
 * The format behind a masked address on a people-search page, matched to the person:
 * "m****.s****" for Mayank Singh → {first}.{last}, "m.s****" → {f}.{last}. '' when unclear.
 */
export function maskedPattern(local: string, first: string, last: string): string {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l || f[0] === l[0]) return '';
  const m = local.match(/^([a-z])(\**)([._-]?)([a-z])(\**)$/);
  if (!m) return '';
  const [, c1, s1, sep, c2, s2] = m;
  if (!s1 && !s2) return '';
  const part = (c: string, masked: string) => (c === f[0] ? (masked ? '{first}' : '{f}') : c === l[0] ? (masked ? '{last}' : '{l}') : '');
  const a = part(c1, s1);
  const b = part(c2, s2);
  if (!a || !b || a.slice(0, 2) === b.slice(0, 2)) return '';
  return `${a}${sep}${b}`;
}

export type PersonHints = { emails: string[]; pattern: string; masked: string; domain: string };
const NO_HINTS: PersonHints = { emails: [], pattern: '', masked: '', domain: '' };

/**
 * One Google search for the person's email: people-search pages and documents often show
 * the address itself, or a masked version that still gives away the format.
 */
export async function personEmailHints(svc: Services, name: string, company: string, domain: string): Promise<PersonHints> {
  const clean = name.replace(/\(.*?\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim();
  const company_ = searchName(company);
  if (!clean || !company_) return NO_HINTS;
  let results: SerperResult[];
  try {
    results = await googleSearch(svc, `"${clean}" ${company_} email`);
  } catch {
    return NO_HINTS;
  }
  const { first, last } = splitName(clean);
  const site = rootDomain(domain);
  const accept = (d: string) => (site ? rootDomain(d) === site : domainScore(company, d) >= 3);
  const text = results.map((r) => `${r.title || ''} ${r.snippet || ''}`).join('\n').toLowerCase();
  const hints: PersonHints = { emails: [], pattern: '', masked: '', domain: '' };
  for (const m of text.matchAll(ADDRESS)) {
    const [whole, local, dom] = m;
    if (!accept(dom)) continue;
    if (local.includes('*')) {
      const p = hints.pattern ? '' : maskedPattern(local, first, last);
      if (p) Object.assign(hints, { pattern: p, masked: whole, domain: rootDomain(dom) });
    } else {
      hints.emails.push(`${local.replace(/\.+$/, '')}@${dom}`);
      hints.domain ||= rootDomain(dom);
    }
  }
  hints.emails = [...new Set(hints.emails)];
  return hints;
}
