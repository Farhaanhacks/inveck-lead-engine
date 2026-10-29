import type { ClaimCheck, Issue, SourceDoc } from './schemas';
import { extractFigures, fuzzyIncludes } from './text';

/** Domains where every claim is treated as protected and nothing is removed or waved through automatically. */
export const HIGH_RISK_DOMAINS = new Set(['health', 'finance']);

/** Most unconfirmed general claims that may pass as warnings: a few, or a quarter of the listed claims if that is more. */
export const allowedUnconfirmed = (totalClaims: number) => Math.max(3, Math.floor(totalClaims * 0.25));

/**
 * Protected claims are the ones where being wrong is easy to check or does real harm: numbers, direct quotations, and anything
 * at all in health and finance. Everything else (background, attributions, dates, descriptions) is a general claim: worth checking,
 * but a miss is a warning or a removed sentence rather than a blocked article.
 * This is deterministic on purpose; the model never decides how strictly a claim is judged.
 */
export function classifyClaim(text: string, domainSlug: string): 'protected' | 'general' {
  if (HIGH_RISK_DOMAINS.has(domainSlug)) return 'protected';
  if (extractFigures(text).length || /["\u201c\u201d]/.test(text)) return 'protected';
  return 'general';
}

export type RawVerdict = { verdict?: 'supported' | 'partial' | 'unsupported'; evidenceQuote?: string | null; supportedBy?: string[]; note?: string | null };

/** Turns the model's verdict into an outcome. The quote is checked by code against every source, not only the cited ones. */
export function judgeClaim(claim: { text: string; sourceIds: string[] }, verdict: RawVerdict | undefined, sources: SourceDoc[], domainSlug: string): ClaimCheck {
  const base = { text: claim.text, sourceIds: claim.sourceIds, risk: classifyClaim(claim.text, domainSlug), note: verdict?.note ?? undefined };
  if (!verdict) return { ...base, outcome: 'unassessed' };
  if (verdict.verdict === 'unsupported') return { ...base, outcome: 'unsupported', quote: verdict.evidenceQuote ?? undefined };
  const quote = verdict.evidenceQuote ?? '';
  const matched = quote ? sources.filter((s) => fuzzyIncludes(`${s.title} ${s.text} ${s.excerpts.join(' ')}`, quote)).map((s) => s.id) : [];
  if (!matched.length) return { ...base, outcome: 'unconfirmed', quote: quote || undefined };
  const cited = matched.some((id) => claim.sourceIds.includes(id));
  if (verdict.verdict === 'partial') return { ...base, outcome: 'overstated', quote, supportedBy: matched };
  return { ...base, outcome: cited ? 'verified' : 'miscited', quote, supportedBy: matched };
}

/** General claims the sources contradict or do not mention, in a normal (not health/finance) category: safe to delete the sentence. */
export function removable(checks: ClaimCheck[], domainSlug: string): ClaimCheck[] {
  if (HIGH_RISK_DOMAINS.has(domainSlug)) return [];
  return checks.filter((c) => c.risk === 'general' && c.outcome === 'unsupported');
}

const trim = (s: string) => (s.length > 140 ? `${s.slice(0, 140)}…` : s);

/**
 * The issues a set of checks produces.
 *  - protected claim not confirmed -> hard blocker (as before)
 *  - general claim not confirmed, ordinary category -> warning, up to a small allowance; past it, a review flag a person may release
 *  - general claim removed -> recorded as a warning
 * `removed` lists the claim texts whose sentence was deleted.
 */
export function claimIssues(checks: ClaimCheck[], domainSlug: string, removed: Set<string> = new Set()): Issue[] {
  const strict = HIGH_RISK_DOMAINS.has(domainSlug);
  const issues: Issue[] = [];
  const softUnconfirmed: ClaimCheck[] = [];
  for (const c of checks) {
    if (c.outcome === 'verified') continue;
    if (removed.has(c.text)) {
      issues.push({ code: 'claim_removed', severity: 'minor', message: `An unsupported sentence was removed: "${trim(c.text)}"`, evidence: c.text, claim: c });
      continue;
    }
    if (c.outcome === 'miscited') {
      issues.push({ code: 'claim_miscited', severity: 'minor', message: `Supported, but by ${c.supportedBy?.join(', ')} rather than the cited ${c.sourceIds.join(', ')}: "${trim(c.text)}"`, evidence: c.text, claim: c });
      continue;
    }
    if (c.outcome === 'overstated') {
      issues.push(c.risk === 'protected' && (strict || /\d/.test(c.text))
        ? { code: 'claim_overstated', severity: 'major', message: `The sources support this only in part: "${trim(c.text)}"${c.note ? ` (${c.note})` : ''}`, evidence: c.text, claim: c }
        : { code: 'claim_overstated', severity: 'minor', message: `The sources support this only in part: "${trim(c.text)}"${c.note ? ` (${c.note})` : ''}`, evidence: c.text, claim: c });
      continue;
    }
    // unconfirmed / unsupported / unassessed
    const why = c.outcome === 'unsupported' ? 'the cited sources do not say this' : c.outcome === 'unassessed' ? 'it was not assessed' : 'no supporting passage could be matched in the sources';
    if (c.risk === 'protected') {
      issues.push({ code: 'unsupported_claim', severity: strict ? 'critical' : 'major', message: `Unsupported claim (${why}): "${trim(c.text)}"`, evidence: c.text, claim: c });
    } else {
      softUnconfirmed.push(c);
    }
  }
  const allowance = allowedUnconfirmed(checks.length);
  const tooMany = softUnconfirmed.length > allowance;
  for (const c of softUnconfirmed) {
    issues.push(
      tooMany
        ? { code: 'claim_unconfirmed', severity: 'major', overridable: true, message: `Too many unconfirmed general claims (${softUnconfirmed.length}, allowed ${allowance}). This one: "${trim(c.text)}"`, evidence: c.text, claim: c }
        : { code: 'claim_unconfirmed', severity: 'minor', message: `Could not confirm this general statement in the sources: "${trim(c.text)}"`, evidence: c.text, claim: c },
    );
  }
  return issues;
}
