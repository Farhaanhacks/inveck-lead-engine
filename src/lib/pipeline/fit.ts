import { z } from 'zod';
import type { Icp } from '../db/schema';

/**
 * Whether a company fits an ICP, decided by explicit rules over evidence instead of by one AI verdict.
 *
 * The ICP's own settings become numbered criteria (must-haves M1…, pluses P1…, deal-breakers D1…, and
 * the size, geography and industry targets). The AI reads numbered sources ([S1] a website page, [S2]
 * a search result…) and answers each criterion met / not_met / unknown with a quote and the source it
 * came from. Code then checks every quote against its source and decides (decideFit):
 *
 *   Not a fit     a must-have shown not met, or a deal-breaker shown to apply, by a quote found in its source
 *   Needs review  a must-have still unconfirmed after more searching; a "not met" or deal-breaker without
 *                 a quote found in a source; a size, geography or industry target shown not met; a
 *                 commercial risk the ICP names as a deal-breaker that the assessment didn't confirm; or
 *                 an AI verdict that contradicts its own evidence (after asking again)
 *   Qualified     everything else: every must-have met and no deal-breaker shown to apply
 *
 * Missing information is never proof that a company fails a requirement, and the AI's score alone
 * never rules a company out. Commercial risk (insolvency, liquidation) is recorded apart from the fit
 * and changes the decision only when one of the ICP's deal-breakers names it.
 */

export type CriterionKind = 'requirement' | 'preference' | 'deal_breaker' | 'size' | 'geography' | 'industry';
export type Criterion = { id: string; kind: CriterionKind; text: string };
export type EvidenceStatus = 'met' | 'not_met' | 'unknown';

/** One ICP criterion as judged for a company, and what supports it. Saved on the lead. */
export type FitEvidence = {
  id: string;
  kind: CriterionKind;
  criterion: string;
  status: EvidenceStatus;
  /** A quote from the source, or the widely known fact relied on. */
  evidence: string;
  /** The source id the AI cited: "S3", "K" for a widely known fact, or '' for none. */
  source: string;
  /** The page or search result the quote is from; '' when there is none. */
  url: string;
  /** The quote was found in the source it cites. Only verified evidence can rule a company out. */
  verified: boolean;
  /** Why a quote that rules the company out was set aside on a second look: it doesn't show the failure. */
  check?: string;
};

export type RiskKind = 'insolvency' | 'liquidation' | 'other';
/** A commercial risk seen while researching. Kept apart from the ICP fit. */
export type RiskFlag = { kind: RiskKind; label: string; evidence: string; url: string; verified: boolean };

export type FitStatus = 'qualified' | 'not_fit' | 'review';
export type FitDecision = {
  status: FitStatus;
  reason: string;
  /** Code found something the AI's answer didn't confirm (a deal-breaker risk): worth asking again. */
  conflict: boolean;
  /** Must-haves not settled either way: more research may settle them. */
  unconfirmed: FitEvidence[];
};

export const KIND_LABEL: Record<CriterionKind, string> = {
  requirement: 'Must-have',
  preference: 'Plus',
  deal_breaker: 'Deal-breaker',
  size: 'Size target',
  geography: 'Geography',
  industry: 'Industry',
};

// ─── Criteria from the ICP ───────────────────────────────────────────────

/** "…, ERP or WMS in use is a plus": wanted, never required. */
const PLUS = /\b(is|are|as) an? (plus|bonus|advantage)\b|\bnice to have\b|\bpreferred\b|\b(optional|desirable)\b|\bnot (mandatory|required|essential|a must)\b/i;

/** Items of an ICP list: split at semicolons and new lines, not inside brackets; commas stay ("SAP, Oracle, Tally"). */
export function splitItems(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if ((ch === ';' || ch === '\n') && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim().replace(/^([-•*]|\d+[.)])\s+/, '').replace(/[.;,\s]+$/, '').trim()).filter((s) => s.length > 1);
}

/** The criteria a company is checked against, from the ICP's settings, each with a stable id. */
export function icpCriteria(icp: Pick<Icp, 'mustHaves' | 'dealBreakers' | 'companySize' | 'geography' | 'industries'>): Criterion[] {
  const out: Criterion[] = [];
  let m = 0;
  let p = 0;
  let d = 0;
  for (const text of splitItems(icp.mustHaves)) {
    if (PLUS.test(text)) out.push({ id: `P${++p}`, kind: 'preference', text });
    else out.push({ id: `M${++m}`, kind: 'requirement', text });
  }
  for (const text of splitItems(icp.dealBreakers)) out.push({ id: `D${++d}`, kind: 'deal_breaker', text });
  if (icp.companySize.trim()) out.push({ id: 'SIZE', kind: 'size', text: icp.companySize.trim() });
  if (icp.geography.trim()) out.push({ id: 'GEO', kind: 'geography', text: `Based or operating in ${icp.geography.trim()}` });
  if (icp.industries.trim()) out.push({ id: 'IND', kind: 'industry', text: `In one of these industries: ${icp.industries.trim()}` });
  return out;
}

// ─── Sources ─────────────────────────────────────────────────────────────

/** Something research read about the company, numbered so evidence can point at it. */
export type Source = { id: string; url: string; title: string; text: string };

const SOURCE_BUDGET = 40_000;
const FIRST_SOURCE_MAX = 16_000;
const SOURCE_MAX = 8_000;

/**
 * Numbers what research read ([S1], [S2]…) and cuts it to what the AI is shown, within the text
 * budget. Commercial-risk notices are found in the full text; one the AI wouldn't see in its page
 * (cut off) is added as a source of its own, so it can be quoted.
 */
export function buildSources(items: { url: string; title: string; text: string }[], start = 1, budget = SOURCE_BUDGET, company = ''): { sources: Source[]; risks: RiskFlag[] } {
  const sources: Source[] = [];
  let used = 0;
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const first = !sources.length && start === 1;
    const room = Math.min(first ? FIRST_SOURCE_MAX : SOURCE_MAX, budget - used);
    if (room < 200) break;
    const shown = text.length > room ? `${text.slice(0, room)}\n[cut]` : text;
    sources.push({ id: `S${start + sources.length}`, url: item.url, title: item.title, text: shown });
    used += shown.length;
  }
  const risks = detectRisks(items, company);
  for (const r of risks) {
    if (sources.some((s) => s.url === r.url && quoteFound(r.evidence, s.text))) continue;
    sources.push({ id: `S${start + sources.length}`, url: r.url, title: `${r.label} notice on this page`, text: r.evidence });
  }
  return { sources, risks };
}

// ─── Quotes ──────────────────────────────────────────────────────────────

const norm = (s: string) => ` ${s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9₹%]+/g, ' ').trim()} `;

function bigrams(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * Whether a quote is in a text: word for word (ignoring case and punctuation), or nearly so (three
 * quarters of its word pairs, for a quote with small slips). Parts joined with "…" are checked apart.
 */
export function quoteFound(quote: string, text: string): boolean {
  const hay = norm(text);
  const parts = quote.split(/\.{3}|…/).map(norm).filter((p) => p.trim().length >= 3);
  if (!parts.length) return false;
  let haystackPairs: Set<string> | null = null;
  return parts.every((p) => {
    if (hay.includes(p)) return true;
    const words = p.trim().split(' ');
    if (words.length < 4) return false;
    haystackPairs ??= new Set(bigrams(hay.trim().split(' ')));
    const pairs = bigrams(words);
    return pairs.filter((x) => haystackPairs!.has(x)).length / pairs.length >= 0.75;
  });
}

// ─── Commercial risk ─────────────────────────────────────────────────────

/**
 * Notices about the company itself, not services it offers: "CIRP initiated on…", "a resolution
 * professional has been appointed", "under liquidation". A CA firm offering IBC advice doesn't match.
 */
const RISK_SIGNS: { kind: Exclude<RiskKind, 'other'>; label: string; re: RegExp }[] = [
  {
    kind: 'insolvency',
    label: 'Insolvency process (CIRP)',
    re: /\b(corporate insolvency resolution process|cirp)\b[^.\n]{0,80}?\b(initiated|commenced|admitted|ordered|under ?way|ongoing)\b|\b(initiated|commenced|admitted|undergoing|is under)\b[^.\n]{0,40}?\b(corporate insolvency resolution process|cirp|insolvency proceedings)\b|\b(interim )?resolution professional\b[^.\n]{0,60}?\bappointed\b|\bappointed\b[^.\n]{0,60}?\b(interim )?resolution professional\b|\bmoratorium under section 14\b/i,
  },
  {
    kind: 'liquidation',
    label: 'Liquidation',
    re: /\b(is under|is in|went into|order of|order for|ordered into)\s+liquidation\b|\bliquidator\b[^.\n]{0,40}?\bappointed\b|\bappointed\b[^.\n]{0,40}?\bliquidator\b|\bwinding[- ]up order\b|\b(has been|was) wound up\b/i,
  },
];

/** Deal-breaker wording that names a commercial risk ("Company under insolvency or liquidation"). */
export const RISK_WORDS: Record<Exclude<RiskKind, 'other'>, RegExp> = {
  insolvency: /insolven|bankrupt|\bcirp\b|\bnclt\b|\bibc\b|resolution process/i,
  liquidation: /liquidat|wound up|winding[- ]up/i,
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Insolvency and liquidation notices in the text, once per kind, with the sentence they're in. With
 * the company's name, a process named as its own counts too ("Corporate Insolvency Resolution Process
 * of KLT Automotive…").
 */
export function detectRisks(items: { url: string; text: string }[], company = ''): RiskFlag[] {
  const firm = company.replace(/[^A-Za-z0-9&\s]/g, ' ').trim().split(/\s+/)[0] ?? '';
  const own = firm.length >= 2 ? `\\s+(of|against|in respect of|in the matter of)\\s+(m/s\\.?\\s+)?${escape(firm)}\\b` : '';
  const signs = RISK_SIGNS.map((sign) => ({
    ...sign,
    re: own ? new RegExp(`${sign.re.source}|\\b(${sign.kind === 'insolvency' ? 'corporate insolvency resolution process|cirp|insolvency proceedings' : 'liquidation|winding[- ]up'})${own}`, 'i') : sign.re,
  }));
  const out: RiskFlag[] = [];
  for (const sign of signs) {
    for (const item of items) {
      const m = sign.re.exec(item.text);
      if (!m) continue;
      const from = Math.max(0, item.text.lastIndexOf('\n', m.index) + 1, m.index - 120);
      const nl = item.text.indexOf('\n', m.index + m[0].length);
      const to = Math.min(item.text.length, m.index + m[0].length + 120, nl < 0 ? Infinity : nl);
      out.push({ kind: sign.kind, label: sign.label, evidence: item.text.slice(from, to).replace(/\s+/g, ' ').trim(), url: item.url, verified: true });
      break;
    }
  }
  return out;
}

function riskKindOf(text: string): RiskKind {
  if (RISK_WORDS.insolvency.test(text)) return 'insolvency';
  if (RISK_WORDS.liquidation.test(text)) return 'liquidation';
  return 'other';
}

// ─── The AI's answer ─────────────────────────────────────────────────────

/** What the AI is asked for (JSON Schema, for the model). */
export const FIT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    industry: { type: 'string' },
    company_size: { type: 'string' },
    locations: { type: 'string' },
    inventory_complexity: { type: 'string' },
    warehousing_3pl: { type: 'string' },
    erp_wms: { type: 'string' },
    verification_need: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['met', 'not_met', 'unknown'] },
          evidence: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['id', 'status', 'evidence', 'source'],
        additionalProperties: false,
      },
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string' }, evidence: { type: 'string' }, source: { type: 'string' } },
        required: ['kind', 'evidence', 'source'],
        additionalProperties: false,
      },
    },
    fit_score: { type: 'integer' },
    qualified: { type: 'boolean' },
    fit_reason: { type: 'string' },
    target_roles: { type: 'array', items: { type: 'string' } },
    pitch_hook: { type: 'string' },
  },
  required: [
    'summary', 'industry', 'company_size', 'locations', 'inventory_complexity', 'warehousing_3pl', 'erp_wms',
    'verification_need', 'criteria', 'risks', 'fit_score', 'qualified', 'fit_reason', 'target_roles', 'pitch_hook',
  ],
  additionalProperties: false,
};

/** The same, checked at run time: the model's JSON mode doesn't guarantee any of it. */
const fitReplySchema = z.object({
  summary: z.string(),
  industry: z.string(),
  company_size: z.string(),
  locations: z.string(),
  inventory_complexity: z.string(),
  warehousing_3pl: z.string(),
  erp_wms: z.string(),
  verification_need: z.string(),
  criteria: z.array(z.object({ id: z.string(), status: z.enum(['met', 'not_met', 'unknown']), evidence: z.string(), source: z.string() })),
  risks: z.array(z.object({ kind: z.string(), evidence: z.string(), source: z.string() })),
  fit_score: z.number().int().min(0).max(10),
  qualified: z.boolean(),
  fit_reason: z.string().trim().min(1),
  target_roles: z.array(z.string()),
  pitch_hook: z.string(),
});
export type FitReply = z.infer<typeof fitReplySchema>;

export type ReadReply = { reply: FitReply; evidence: FitEvidence[]; risks: RiskFlag[] };

const sourceId = (s: string) => s.trim().toUpperCase().replace(/^\[|\]$/g, '');

/**
 * Checks the AI's answer: every field present with the right type, every criterion answered exactly
 * once, and evidence given for every "met" or "not met". Quotes are checked against the sources they
 * cite. Returns the problems instead when it doesn't pass, for asking again.
 */
export function readFitReply(data: unknown, criteria: Criterion[], sources: Source[]): ReadReply | { problems: string[] } {
  const parsed = fitReplySchema.safeParse(data);
  if (!parsed.success) {
    return { problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`) };
  }
  const reply = parsed.data;
  const problems: string[] = [];
  const answers = new Map<string, FitReply['criteria'][number]>();
  for (const a of reply.criteria) {
    const id = sourceId(a.id);
    if (answers.has(id)) problems.push(`criteria: ${id} answered more than once`);
    answers.set(id, a);
  }
  for (const c of criteria) {
    const a = answers.get(c.id);
    if (!a) problems.push(`criteria: ${c.id} not answered`);
    else if (a.status !== 'unknown' && !a.evidence.trim()) problems.push(`criteria: ${c.id} is "${a.status}" with no evidence`);
  }
  if (problems.length) return { problems };

  const find = (id: string) => sources.find((s) => s.id === sourceId(id));
  const evidence = criteria.map((c): FitEvidence => {
    const a = answers.get(c.id)!;
    const src = find(a.source);
    const quote = a.evidence.trim().slice(0, 400);
    return {
      id: c.id,
      kind: c.kind,
      criterion: c.text,
      status: a.status,
      evidence: quote,
      source: sourceId(a.source),
      url: src?.url ?? '',
      verified: a.status !== 'unknown' && !!src && !!quote && quoteFound(quote, src.text),
    };
  });
  const risks = reply.risks
    .filter((r) => r.evidence.trim())
    .map((r): RiskFlag => {
      const src = find(r.source);
      const kind = riskKindOf(`${r.kind} ${r.evidence}`);
      return {
        kind,
        label: kind === 'insolvency' ? 'Insolvency process' : kind === 'liquidation' ? 'Liquidation' : r.kind.trim().slice(0, 60) || 'Commercial risk',
        evidence: r.evidence.trim().slice(0, 300),
        url: src?.url ?? '',
        verified: !!src && quoteFound(r.evidence, src.text),
      };
    });
  return { reply, evidence, risks };
}

/** Risks found by code first, then the AI's (one per kind; unconfirmed ones only when nothing confirmed it). */
export function mergeRisks(found: RiskFlag[], fromAi: RiskFlag[]): RiskFlag[] {
  const out = [...found];
  for (const r of [...fromAi].sort((a, b) => Number(b.verified) - Number(a.verified))) {
    if (r.kind !== 'other' && out.some((x) => x.kind === r.kind)) continue;
    if (r.kind === 'other' && out.some((x) => x.kind === 'other' && x.evidence === r.evidence)) continue;
    out.push(r);
  }
  return out;
}

// ─── The decision ────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cite = (e: { evidence: string; url: string }) => `“${clip(e.evidence, 160)}”${e.url ? ` (${e.url})` : ''}`;
const TARGET: Partial<Record<CriterionKind, string>> = { size: 'size', geography: 'geography', industry: 'industry' };

/** The fit, from the evidence, by the rules at the top of this file. */
export function decideFit(evidence: FitEvidence[], risks: RiskFlag[]): FitDecision {
  const failed = evidence.filter((e) => e.kind === 'requirement' && e.status === 'not_met' && e.verified);
  const applies = evidence.filter((e) => e.kind === 'deal_breaker' && e.status === 'met' && e.verified);
  if (failed.length || applies.length) {
    const why = [
      ...failed.map((e) => `fails must-have “${e.criterion}”: ${cite(e)}`),
      ...applies.map((e) => `deal-breaker “${e.criterion}” applies: ${cite(e)}`),
    ];
    return { status: 'not_fit', reason: `Not a fit: ${why.join('; ')}`, conflict: false, unconfirmed: [] };
  }

  const why: string[] = [];
  let conflict = false;
  for (const e of evidence.filter((x) => x.kind === 'deal_breaker')) {
    const risk = risks.find((r) => r.verified && r.kind !== 'other' && RISK_WORDS[r.kind].test(e.criterion));
    if (!risk) continue;
    conflict = true;
    why.push(`deal-breaker “${e.criterion}” may apply: ${risk.label.toLowerCase()} notice ${cite(risk)}, not confirmed by the assessment`);
  }
  const unconfirmed = evidence.filter((e) => e.kind === 'requirement' && (e.status === 'unknown' || (e.status === 'not_met' && !e.verified)));
  for (const e of unconfirmed) {
    why.push(
      e.status === 'unknown'
        ? `couldn't confirm must-have “${e.criterion}”`
        : e.check
          ? `must-have “${e.criterion}” not shown to be missing (the quote doesn't show it: ${e.check})`
          : `must-have “${e.criterion}” marked not met without a quote found in a source`,
    );
  }
  for (const e of evidence.filter((x) => x.kind === 'deal_breaker' && x.status === 'met' && !x.verified)) {
    why.push(
      e.check
        ? `possible deal-breaker “${e.criterion}”, not shown by its quote (${e.check})`
        : `possible deal-breaker “${e.criterion}”, not confirmed by a source${e.evidence ? ` (“${clip(e.evidence, 120)}”)` : ''}`,
    );
  }
  for (const e of evidence.filter((x) => TARGET[x.kind] && x.status === 'not_met' && x.verified)) {
    why.push(`${TARGET[e.kind]} target not met: ${cite(e)}`);
  }
  if (why.length) return { status: 'review', reason: `Needs review: ${why.join('; ')}`, conflict, unconfirmed };

  const musts = evidence.filter((e) => e.kind === 'requirement');
  const unsourced = musts.filter((e) => !e.verified).map((e) => `“${clip(e.criterion, 60)}”`);
  const reason = musts.length
    ? `Meets every must-have; no deal-breaker found${unsourced.length ? `. Not backed by a quote found in a source (widely known): ${unsourced.join(', ')}` : ''}`
    : 'No must-haves set for this ICP; no deal-breaker found';
  return { status: 'qualified', reason, conflict: false, unconfirmed: [] };
}

/** The most employees a LinkedIn size band allows ("11-50 employees" gives 50; "10,001+" has no top). */
export function sizeBandTop(size: string): number | null {
  const m = /(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/.exec(size);
  return m ? Number(m[2].replace(/,/g, '')) : null;
}

/**
 * The headcount an ICP's size target asks for ("200+ employees or Rs 100 Cr+ revenue" gives 200), or
 * null when the target can be met another way a headcount says nothing about ("3+ partners or 25+
 * audit staff": a small firm can have three partners). A revenue alternative is fine: the assessment
 * reads revenue from the sources and finds the size met when it is shown.
 */
export function employeeTarget(companySize: string): number | null {
  const parts = companySize.split(/\bor\b|\//i).map((p) => p.trim()).filter(Boolean);
  const HEADCOUNT = /(\d[\d,]*)\s*\+?\s*(?:[a-z]+\s+)?(?:employees|staff|people|workers|workforce)\b/i;
  const heads = parts.filter((p) => HEADCOUNT.test(p));
  if (heads.length !== 1 || parts.some((p) => !HEADCOUNT.test(p) && !/\b(revenue|turnover|sales|cr|crore|lakh|inr|rs\.?)\b|₹/i.test(p))) return null;
  return Number(HEADCOUNT.exec(heads[0])![1].replace(/,/g, ''));
}

/**
 * Clearly too small for the ICP: the company's own LinkedIn page puts it at half the size target or
 * less ("11-50 employees" against "100+ employees"), and the assessment didn't find the size met
 * (a website showing a bigger workforce outweighs an outdated page). Why, quoting the page; '' when
 * it isn't. A borderline band ("51-200" against 100+) is left to the assessment.
 */
export function tooSmall(evidence: FitEvidence[], page: { size: string; url: string } | null | undefined, companySize: string): string {
  const target = employeeTarget(companySize);
  const top = page?.size ? sizeBandTop(page.size) : null;
  if (!page || !target || top == null || top > target / 2) return '';
  if (evidence.find((e) => e.kind === 'size')?.status === 'met') return '';
  return `too small for the ICP's size target (${companySize.trim()}): its LinkedIn page shows “Company size: ${page.size}” (${page.url})`;
}

/** The evidence a rejection rests on: must-haves shown not met and deal-breakers shown to apply. */
export function decisiveEvidence(evidence: FitEvidence[]): FitEvidence[] {
  return evidence.filter((e) => e.verified && ((e.kind === 'requirement' && e.status === 'not_met') || (e.kind === 'deal_breaker' && e.status === 'met')));
}

export const CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, supports: { type: 'boolean' }, why: { type: 'string' } },
        required: ['id', 'supports', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['checks'],
  additionalProperties: false,
};

const checkReplySchema = z.object({ checks: z.array(z.object({ id: z.string(), supports: z.boolean(), why: z.string() })) });

/**
 * Reads the second look at a rejection's quotes: evidence whose quote doesn't show the failure stops
 * counting (verified false, with why). Problems instead when the answer doesn't pass the checks.
 */
export function readCheckReply(data: unknown, evidence: FitEvidence[]): { evidence: FitEvidence[]; setAside: FitEvidence[] } | { problems: string[] } {
  const parsed = checkReplySchema.safeParse(data);
  if (!parsed.success) return { problems: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`) };
  const items = decisiveEvidence(evidence);
  const byId = new Map(parsed.data.checks.map((c) => [sourceId(c.id), c]));
  const missing = items.filter((e) => !byId.has(e.id));
  if (missing.length) return { problems: missing.map((e) => `checks: ${e.id} not answered`) };
  const setAside: FitEvidence[] = [];
  const out = evidence.map((e) => {
    const c = items.includes(e) ? byId.get(e.id) : undefined;
    if (!c || c.supports) return e;
    const marked = { ...e, verified: false, check: c.why.trim().slice(0, 200) || 'it is about something else' };
    setAside.push(marked);
    return marked;
  });
  return { evidence: out, setAside };
}

/**
 * Where the AI's verdict contradicts itself or the evidence: `qualified` has to follow its own score
 * and criteria (6+, no must-have not met, no deal-breaker met), and agree with the decision code made.
 */
export function verdictProblems(reply: FitReply, evidence: FitEvidence[], decision: FitDecision): string[] {
  const out: string[] = [];
  const ownRule =
    reply.fit_score >= 6 &&
    !evidence.some((e) => e.kind === 'requirement' && e.status === 'not_met') &&
    !evidence.some((e) => e.kind === 'deal_breaker' && e.status === 'met');
  if (reply.qualified !== ownRule) {
    out.push(`qualified is ${reply.qualified}, but a fit_score of ${reply.fit_score} with these criteria means ${ownRule}`);
  }
  if (decision.status === 'qualified' && !reply.qualified) out.push(`judged not a fit (${reply.fit_score}/10) with no must-have shown not met and no deal-breaker shown to apply`);
  if (decision.status === 'not_fit' && reply.qualified) out.push('judged a fit although a must-have is shown not met or a deal-breaker shown to apply');
  if (decision.conflict) out.push('a commercial risk named in the deal-breakers was found in the sources but not addressed');
  return out;
}
