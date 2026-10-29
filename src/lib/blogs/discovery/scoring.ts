// Explainable opportunity scoring. A prioritisation heuristic, not a traffic forecast.
// A dimension without evidence is `unavailable` and is left out of the average; it is never scored as 0.

export type Basis = 'actual' | 'estimated' | 'unavailable';
export const DIMENSIONS = ['trendMomentum', 'searchDemand', 'competitionGap', 'relevance', 'engagementPotential'] as const;
export type DimensionKey = (typeof DIMENSIONS)[number];
export type Dimension = { score: number | null; basis: Basis; note: string };
export type DimensionScores = Record<DimensionKey, Dimension>;
export type Weights = Record<DimensionKey, number>;
export type Confidence = 'low' | 'medium' | 'high';

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  trendMomentum: 'Trend momentum',
  searchDemand: 'Search demand',
  competitionGap: 'Competition & content gap',
  relevance: 'Relevance to Inveck',
  engagementPotential: 'Clicks & engagement potential',
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export const unavailable = (note: string): Dimension => ({ score: null, basis: 'unavailable', note });
export const estimated = (score: number, note: string): Dimension => ({ score: clamp(score), basis: 'estimated', note });
export const actual = (score: number, note: string): Dimension => ({ score: clamp(score), basis: 'actual', note });

type SourceDate = { publisher: string | null; publishedAt: string | null };

/**
 * Momentum from news coverage the candidate cites: how many independent publishers covered it and how
 * recently. This measures news activity, not search interest, so it is always an estimate.
 */
export function trendFromSources(sources: SourceDate[], now: Date): Dimension {
  const publishers = new Set(sources.map((s) => s.publisher).filter(Boolean));
  if (!sources.length) return unavailable('No sources cited, so momentum cannot be assessed.');
  const dates = sources.map((s) => (s.publishedAt ? Date.parse(s.publishedAt) : NaN)).filter((t) => Number.isFinite(t));
  if (!dates.length) return unavailable('Cited sources carry no publication dates.');
  const ageDays = Math.max(0, (now.getTime() - Math.max(...dates)) / 864e5);
  const recency = ageDays <= 2 ? 40 : ageDays <= 7 ? 30 : ageDays <= 14 ? 20 : ageDays <= 30 ? 10 : 0;
  const breadth = Math.min(60, publishers.size * 20);
  return estimated(
    breadth + recency,
    `${publishers.size} independent publisher${publishers.size === 1 ? '' : 's'}, newest article ${ageDays < 1 ? 'today' : `${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? '' : 's'} old`}. Based on news coverage, not search-interest data.`,
  );
}

export type Opportunity = {
  opportunityScore: number | null;
  confidence: Confidence;
  /** Share of total weight that has a score (0-1). */
  coverage: number;
  explanation: string;
};

/**
 * Weighted average over the dimensions that have data, renormalised to their combined weight.
 * Below 50% weight coverage no score is given at all. Confidence falls with missing coverage and
 * stays low unless some of the evidence is actual rather than estimated.
 */
export function computeOpportunity(scores: DimensionScores, weights: Weights, independentSources: number): Opportunity {
  const total = DIMENSIONS.reduce((a, k) => a + weights[k], 0) || 1;
  let have = 0;
  let actualWeight = 0;
  let sum = 0;
  const missing: string[] = [];
  for (const k of DIMENSIONS) {
    const d = scores[k];
    if (d.score === null || d.basis === 'unavailable') {
      missing.push(DIMENSION_LABELS[k]);
      continue;
    }
    have += weights[k];
    sum += d.score * weights[k];
    if (d.basis === 'actual') actualWeight += weights[k];
  }
  const coverage = have / total;
  const actualShare = actualWeight / total;
  const opportunityScore = coverage >= 0.5 && have > 0 ? Math.round((sum / have) * 10) / 10 : null;

  let confidence: Confidence = 'low';
  if (opportunityScore !== null) {
    if (coverage >= 0.9 && actualShare >= 0.4 && independentSources >= 3) confidence = 'high';
    else if (coverage >= 0.6 && independentSources >= 3 && actualShare > 0) confidence = 'medium';
  }

  const parts: string[] = [];
  parts.push(opportunityScore === null ? 'Too little data for an overall score.' : `Weighted from ${Math.round(coverage * 100)}% of the scoring weight.`);
  if (missing.length) parts.push(`Unavailable: ${missing.join(', ')}.`);
  if (actualShare === 0) parts.push('Every figure is an estimate; no measured search data was available.');
  return { opportunityScore, confidence, coverage, explanation: parts.join(' ') };
}
