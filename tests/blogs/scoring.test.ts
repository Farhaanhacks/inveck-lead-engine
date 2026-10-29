import { describe, expect, it } from 'vitest';
import { actual, computeOpportunity, estimated, trendFromSources, unavailable, type DimensionScores } from '@/lib/blogs/discovery/scoring';
import { SETTING_DEFAULTS } from '@/lib/blogs/settings';

const W = SETTING_DEFAULTS.scoringWeights;
const all = (over: Partial<DimensionScores> = {}): DimensionScores => ({
  trendMomentum: estimated(80, ''),
  searchDemand: estimated(60, ''),
  competitionGap: estimated(70, ''),
  relevance: estimated(90, ''),
  engagementPotential: estimated(50, ''),
  ...over,
});

describe('opportunity score', () => {
  it('weights dimensions by the configured weights', () => {
    const r = computeOpportunity(all(), W, 3);
    // 80*.25 + 60*.25 + 70*.20 + 90*.15 + 50*.15 = 70
    expect(r.opportunityScore).toBe(70);
    expect(r.coverage).toBe(1);
  });

  it('leaves out an unavailable dimension instead of scoring it as zero', () => {
    const withGap = computeOpportunity(all({ searchDemand: unavailable('none') }), W, 3);
    // Renormalised over the remaining 75% of the weight: (20+14+13.5+7.5)/0.75 = 73.3
    expect(withGap.opportunityScore).toBeCloseTo(73.3, 1);
    expect(withGap.coverage).toBeCloseTo(0.75);
    expect(withGap.explanation).toContain('Search demand');
  });

  it('gives no overall score when less than half the weight has data', () => {
    const r = computeOpportunity(
      all({ searchDemand: unavailable(''), competitionGap: unavailable(''), relevance: unavailable(''), engagementPotential: unavailable('') }),
      W,
      3,
    );
    expect(r.opportunityScore).toBeNull();
    expect(r.confidence).toBe('low');
  });

  it('keeps confidence low when everything is an estimate', () => {
    expect(computeOpportunity(all(), W, 5).confidence).toBe('low');
  });

  it('raises confidence only with actual data, broad coverage and several sources', () => {
    const real = all({ searchDemand: actual(70, ''), trendMomentum: actual(80, '') });
    expect(computeOpportunity(real, W, 3).confidence).toBe('high');
    expect(computeOpportunity(real, W, 1).confidence).toBe('low');
    // One actual dimension (25% of the weight) is below the 40% needed for high confidence.
    expect(computeOpportunity(all({ searchDemand: actual(70, '') }), W, 3).confidence).toBe('medium');
    expect(computeOpportunity(all({ searchDemand: actual(70, ''), competitionGap: unavailable(''), engagementPotential: unavailable('') }), W, 3).confidence).toBe('medium');
  });

  it('respects changed weights', () => {
    const heavyRelevance = { trendMomentum: 0, searchDemand: 0, competitionGap: 0, relevance: 100, engagementPotential: 0 };
    expect(computeOpportunity(all(), heavyRelevance, 3).opportunityScore).toBe(90);
  });
});

describe('trend momentum from sources', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  it('is higher for many publishers and fresh news', () => {
    const fresh = trendFromSources([{ publisher: 'a.com', publishedAt: '2026-10-17T00:00:00Z' }, { publisher: 'b.com', publishedAt: '2026-10-16T00:00:00Z' }, { publisher: 'c.com', publishedAt: '2026-10-15T00:00:00Z' }], now);
    const stale = trendFromSources([{ publisher: 'a.com', publishedAt: '2026-08-01T00:00:00Z' }], now);
    expect(fresh.score!).toBeGreaterThan(stale.score!);
    expect(fresh.basis).toBe('estimated');
  });
  it('is unavailable without dates or sources, never zero', () => {
    expect(trendFromSources([], now).score).toBeNull();
    expect(trendFromSources([{ publisher: 'a.com', publishedAt: null }], now).basis).toBe('unavailable');
  });
});
