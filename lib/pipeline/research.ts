import type { Icp } from '../db/schema';
import { askJson } from './ai';
import {
  buildSources,
  CHECK_JSON_SCHEMA,
  decideFit,
  decisiveEvidence,
  FIT_JSON_SCHEMA,
  icpCriteria,
  mergeRisks,
  readCheckReply,
  readFitReply,
  verdictProblems,
  type Criterion,
  type FitDecision,
  type FitEvidence,
  type FitStatus,
  type ReadReply,
  type RiskFlag,
  type Source,
} from './fit';
import { EVIDENCE_CHECK_PROMPT, RESEARCH_PROMPT } from './prompts';
import type { Services } from './services';
import { googleSearch } from './services';
import { searchName } from './text';

export type LeadInput = { company: string; website: string; domain: string; city: string };

/** The fit as decided from the evidence (see fit.ts), with what it rests on. */
export type FitAssessment = {
  status: FitStatus;
  /** Why: the failed must-have or deal-breaker, what needs review, or what was met. */
  reason: string;
  /** The AI's 0–10 rating, or null when no valid answer came back. */
  fitScore: number | null;
  /** The AI's own explanation of its verdict. */
  fitReason: string;
  evidence: FitEvidence[];
  risks: RiskFlag[];
  /** AI answers asked for, and Google searches run for more evidence. */
  attempts: number;
  searches: number;
};

export type Research = {
  summary: string;
  industry: string;
  companySize: string;
  locations: string;
  inventoryComplexity: string;
  warehousing3pl: string;
  erpWms: string;
  verificationNeed: string;
  fitReason: string;
  pitchHook: string;
  targetRoles: string[];
  fitScore: number;
  qualified: boolean;
  /** Human-readable block saved as the lead's research summary. */
  text: string;
  /** Present when the fit was assessed now; absent when research saved earlier is reused. */
  assessment?: FitAssessment;
};

type Log = (msg: string, level?: 'info' | 'warn' | 'error') => Promise<void> | void;

const KIND_FOR_AI: Record<Criterion['kind'], string> = {
  requirement: 'must-have',
  preference: 'a plus, never required',
  deal_breaker: 'deal-breaker',
  size: 'size target',
  geography: 'geography target',
  industry: 'industry target',
};

/** What the AI is shown: the ICP, its criteria by id, any risk notices, and the numbered sources. */
function researchText(lead: LeadInput, icp: Icp, criteria: Criterion[], sources: Source[], risks: RiskFlag[]): string {
  return [
    `## ICP: ${icp.segment}`,
    `Description: ${icp.description}`,
    `Target titles: ${icp.targetTitles}`,
    '',
    '## Criteria (answer each by its id)',
    ...criteria.map((c) => `- ${c.id} (${KIND_FOR_AI[c.kind]}): ${c.text}`),
    '',
    '## Company',
    `Name: ${lead.company}`,
    `Website: ${lead.website || 'not given'}`,
    `City: ${lead.city || 'not given'}`,
    ...(risks.length ? ['', '## Notices found in the sources', ...risks.map((r) => `- ${r.label}: “${r.evidence}” (${r.url || 'no address'})`)] : []),
    '',
    '## Sources',
    sources.length
      ? sources.map((s) => `[${s.id}] ${s.url || '(no address)'}${s.title ? ` (${s.title})` : ''}\n<source>\n${s.text}\n</source>`).join('\n\n')
      : '(Nothing could be read about this company: no website text and no search results. Use only what is widely known about it, with source "K", and answer "unknown" otherwise.)',
  ].join('\n');
}

type Answer = ReadReply & { decision: FitDecision; problems: string[] };
type Round = { ok?: Answer; inconsistent?: Answer; invalid?: string[]; error?: string; attempts: number };

/** Answers asked for per round: the first, and one more when it doesn't pass the checks. */
const ATTEMPTS = 2;

/**
 * One assessment from the AI, asked again (saying what was wrong) when the answer is malformed,
 * misses a criterion or contradicts itself. A call that can't be made at all (no key, API down) is
 * an error.
 */
async function assessRound(svc: Services, text: string, criteria: Criterion[], sources: Source[], found: RiskFlag[], company: string, log?: Log): Promise<Round> {
  let feedback = '';
  let invalid: string[] = [];
  let inconsistent: Answer | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const res = await askJson(svc, RESEARCH_PROMPT, text + feedback, FIT_JSON_SCHEMA);
    let problems: string[];
    if (res.error !== undefined) {
      if (res.failure === 'call') return { error: res.error, attempts: attempt };
      problems = [res.error];
      invalid = problems;
    } else {
      const read = readFitReply(res.data, criteria, sources);
      if ('problems' in read) {
        problems = read.problems;
        invalid = problems;
      } else {
        const risks = mergeRisks(found, read.risks);
        const decision = decideFit(read.evidence, risks);
        problems = verdictProblems(read.reply, read.evidence, decision);
        const answer: Answer = { ...read, risks, decision, problems };
        if (!problems.length) return { ok: answer, attempts: attempt };
        inconsistent = answer;
      }
    }
    if (attempt < ATTEMPTS) {
      await log?.(`${company}: the AI's assessment didn't pass the checks (${problems.join('; ')}); asking again`, 'warn');
      feedback =
        `\n\n## Your previous answer was rejected\n${problems.map((p) => `- ${p}`).join('\n')}\n` +
        'Answer again: every field with the right type, every criterion id exactly once with evidence for "met" and "not_met", and `qualified` following its rule.';
    }
  }
  return inconsistent ? { inconsistent, attempts: ATTEMPTS } : { invalid, attempts: ATTEMPTS };
}

/**
 * A second look before a company is ruled out: does each quote the rejection rests on show the
 * failure, or merely appear on the page? Quotes that don't stop counting, which usually sends the
 * company to review instead. An answer that can't be read even when asked again confirms nothing.
 */
async function confirmRejection(svc: Services, company: string, round: Round, log?: Log): Promise<Round> {
  const a = round.ok;
  if (!a || a.decision.status !== 'not_fit') return round;
  const items = decisiveEvidence(a.evidence);
  const text = [
    `Company: ${company}`,
    '',
    ...items.map(
      (e) =>
        `- id ${e.id}: ${e.kind === 'requirement' ? 'must-have' : 'deal-breaker'} “${e.criterion}”. Finding: ${e.kind === 'requirement' ? 'not met' : 'applies'}. Quote: “${e.evidence}” (${e.url || 'no address'})`,
    ),
  ].join('\n');
  let problems: string[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const res = await askJson(svc, EVIDENCE_CHECK_PROMPT, text, CHECK_JSON_SCHEMA);
    if (res.error !== undefined) {
      if (res.failure === 'call') return { error: res.error, attempts: round.attempts };
      problems = [res.error];
      continue;
    }
    const read = readCheckReply(res.data, a.evidence);
    if ('problems' in read) {
      problems = read.problems;
      continue;
    }
    if (!read.setAside.length) return round;
    await log?.(`${company}: ${read.setAside.length === 1 ? 'a quote' : 'quotes'} behind the rejection didn't show the failure on a second look (${read.setAside.map((e) => `${e.id}: ${e.check}`).join('; ')})`, 'warn');
    return { ...round, ok: { ...a, evidence: read.evidence, decision: decideFit(read.evidence, a.risks) } };
  }
  const evidence = a.evidence.map((e) => (items.includes(e) ? { ...e, verified: false, check: `the second look couldn't be read (${problems.join('; ')})` } : e));
  return { ...round, ok: { ...a, evidence, decision: decideFit(evidence, a.risks) } };
}

const QUERY_STOP = new Set(
  'a an and or the of to in on for with that which who its their it is are be has have holds hold any some such as at by from into use uses using run runs significant physical include includes including verify company companies business firm firms'.split(' '),
);

/** The words worth searching for in a criterion: "Runs statutory, internal, stock or bank stock audits…" gives "statutory internal stock bank audits". */
export function criterionKeywords(text: string, max = 5): string {
  const words = text.toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !QUERY_STOP.has(w));
  return [...new Set(words)].slice(0, max).join(' ');
}

/** Google results about the company, for must-haves its own pages didn't settle (two searches at most). */
async function moreEvidence(svc: Services, lead: LeadInput, unconfirmed: FitEvidence[], start: number): Promise<{ sources: Source[]; risks: RiskFlag[]; searches: number }> {
  if (!svc.keys.serper) return { sources: [], risks: [], searches: 0 };
  const name = searchName(lead.company);
  const queries = [`"${name}"${lead.city ? ` ${lead.city}` : ''} company profile products`];
  const words = criterionKeywords(unconfirmed[0]?.criterion ?? '');
  if (words) queries.push(`"${name}" ${words}`);
  const seen = new Set<string>();
  const items: { url: string; title: string; text: string }[] = [];
  let searches = 0;
  for (const q of queries) {
    searches++;
    try {
      for (const r of (await googleSearch(svc, q)).slice(0, 5)) {
        const url = r.link || '';
        if (!url || seen.has(url) || !(r.title || r.snippet)) continue;
        seen.add(url);
        items.push({ url, title: r.title || '', text: [r.title, r.snippet].filter(Boolean).join('\n') });
      }
    } catch {
      // A failed search only means less evidence: the assessment says what stayed unconfirmed.
    }
  }
  return { ...buildSources(items, start, 12_000, lead.company), searches };
}

/**
 * Researches a company and decides whether it fits the ICP, from evidence (see fit.ts). Must-haves
 * its own pages don't settle get one more look (Google results about the company) before it goes to
 * review. Returns an error only when the AI can't be reached; an answer that can't be used even after
 * asking again ends in review, never in a rejection.
 */
export async function researchLead(
  svc: Services,
  lead: LeadInput,
  icp: Icp,
  read: { sources: Source[]; risks: RiskFlag[] },
  log?: Log,
): Promise<{ research?: Research; error?: string }> {
  const criteria = icpCriteria(icp);
  let attempts = 0;
  let searches = 0;
  let round = await assessRound(svc, researchText(lead, icp, criteria, read.sources, read.risks), criteria, read.sources, read.risks, lead.company, log);
  attempts += round.attempts;
  if (round.error !== undefined) return { error: round.error };
  round = await confirmRejection(svc, lead.company, round, log);
  if (round.error !== undefined) return { error: round.error };

  const first = round.ok;
  if (first && first.decision.status === 'review' && first.decision.unconfirmed.length) {
    const more = await moreEvidence(svc, lead, first.decision.unconfirmed, read.sources.length + 1);
    searches = more.searches;
    if (more.sources.length) {
      const n = first.decision.unconfirmed.length;
      await log?.(`${lead.company}: ${n} must-have${n === 1 ? '' : 's'} not settled by its own pages; checking ${more.sources.length} search results`);
      const sources = [...read.sources, ...more.sources];
      const risks = mergeRisks(read.risks, more.risks);
      let second = await assessRound(svc, researchText(lead, icp, criteria, sources, risks), criteria, sources, risks, lead.company, log);
      attempts += second.attempts;
      if (second.error !== undefined) return { error: second.error };
      second = await confirmRejection(svc, lead.company, second, log);
      if (second.error !== undefined) return { error: second.error };
      // The wider look stands when it gave a usable answer; otherwise the first one does.
      if (second.ok) round = second;
    }
  }

  let assessment: FitAssessment;
  const answer = round.ok ?? round.inconsistent;
  if (round.ok) {
    const a = round.ok;
    assessment = { status: a.decision.status, reason: a.decision.reason, fitScore: a.reply.fit_score, fitReason: a.reply.fit_reason, evidence: a.evidence, risks: a.risks, attempts, searches };
  } else if (round.inconsistent) {
    const a = round.inconsistent;
    const opening = a.decision.status === 'review' ? `${a.decision.reason}. Also,` : 'Needs review:';
    assessment = {
      status: 'review',
      reason: `${opening} the AI's verdict contradicts its evidence after ${ATTEMPTS} tries (${a.problems.join('; ')})`,
      fitScore: a.reply.fit_score,
      fitReason: a.reply.fit_reason,
      evidence: a.evidence,
      risks: a.risks,
      attempts,
      searches,
    };
  } else {
    assessment = {
      status: 'review',
      reason: `Needs review: the AI's answers failed the checks ${ATTEMPTS} times (${(round.invalid ?? []).join('; ') || 'no usable answer'})`,
      fitScore: null,
      fitReason: '',
      evidence: [],
      risks: read.risks,
      attempts,
      searches,
    };
  }

  const reply = answer?.reply;
  const t = (v: string | undefined) => (v ?? '').trim() || 'unknown';
  const targetRoles = (reply?.target_roles ?? []).map((r) => r.trim()).filter(Boolean);
  const research: Research = {
    summary: t(reply?.summary),
    industry: t(reply?.industry),
    companySize: t(reply?.company_size),
    locations: t(reply?.locations),
    inventoryComplexity: t(reply?.inventory_complexity),
    warehousing3pl: t(reply?.warehousing_3pl),
    erpWms: t(reply?.erp_wms),
    verificationNeed: t(reply?.verification_need),
    fitReason: assessment.fitReason || assessment.reason,
    pitchHook: t(reply?.pitch_hook),
    targetRoles,
    fitScore: assessment.fitScore ?? 0,
    qualified: assessment.status === 'qualified',
    text: '',
    assessment,
  };
  research.text = reply
    ? [
        research.summary,
        '',
        `Industry: ${research.industry}`,
        `Size: ${research.companySize}`,
        `Locations: ${research.locations}`,
        `Inventory complexity: ${research.inventoryComplexity}`,
        `Warehousing / 3PL: ${research.warehousing3pl}`,
        `ERP / WMS: ${research.erpWms}`,
        `Verification need: ${research.verificationNeed}`,
        `Roles to approach: ${targetRoles.join(', ')}`,
        `Pitch hook: ${research.pitchHook}`,
      ].join('\n')
    : '';
  return { research };
}
