import { describe, expect, it } from 'vitest';
import { allowedUnconfirmed, claimIssues, classifyClaim, judgeClaim, removable } from '@/lib/blogs/pipeline/claim-policy';
import type { ClaimCheck, SourceDoc } from '@/lib/blogs/pipeline/schemas';
import { fuzzyIncludes, normalizeLoose, removeClaimSentence } from '@/lib/blogs/pipeline/text';

const src = (id: string, text: string): SourceDoc => ({ n: Number(id.slice(1)), id, url: `https://${id}.example.com/`, title: `Title ${id}`, publisher: `${id}.example.com`, publishedAt: null, excerpts: [], text });
const SOURCES = [
  src('S1', 'The survey found that 62% of retailers cut waste. "Small shops benefit most from weekly forecasts," the authors wrote. Adoption was highest among shops with fewer than ten staff.'),
  src('S2', 'Analysts cautioned that results vary widely between product categories and that setup takes several weeks.'),
];
const check = (over: Partial<ClaimCheck>): ClaimCheck => ({ text: 'Shops often rethink how they reorder stock', sourceIds: ['S1'], risk: 'general', outcome: 'unconfirmed', ...over });

describe('classifyClaim', () => {
  it('protects figures and quotations in ordinary categories, nothing else', () => {
    expect(classifyClaim('Sales rose 12% last year', 'business')).toBe('protected');
    expect(classifyClaim('The fee is $40 a month', 'technology')).toBe('protected');
    expect(classifyClaim('The CEO said "we will double output by spring"', 'business')).toBe('protected');
    expect(classifyClaim('Apple states that the feature runs on device', 'technology')).toBe('general');
    expect(classifyClaim('The launch was announced in March', 'technology')).toBe('general');
    expect(classifyClaim('Many shops reorder weekly', 'lifestyle')).toBe('general');
  });
  it('protects every claim in health and finance', () => {
    expect(classifyClaim('Many people sleep better after exercise', 'health')).toBe('protected');
    expect(classifyClaim('Banks usually lend against property', 'finance')).toBe('protected');
  });
});

describe('fuzzyIncludes', () => {
  it('matches despite punctuation, markdown, case and curly quotes', () => {
    const hay = 'Analysts **cautioned** that results vary widely between product categories, and that setup takes several weeks.';
    expect(fuzzyIncludes(hay, 'analysts cautioned that results vary widely between product categories and that setup takes several weeks')).toBe(true);
    expect(fuzzyIncludes('He said “small shops benefit most”.', 'He said "small shops benefit most"')).toBe(true);
  });
  it('matches a quote with an ellipsis or a dropped word', () => {
    expect(fuzzyIncludes(SOURCES[0].text, 'Adoption was highest among shops with fewer than staff')).toBe(true);
  });
  it('does not match unrelated or merely topical text', () => {
    expect(fuzzyIncludes(SOURCES[0].text, 'Retailers reported that forecasting software increased revenue in every region')).toBe(false);
    expect(fuzzyIncludes(SOURCES[0].text, 'the')).toBe(false);
    expect(fuzzyIncludes('', 'anything at all here please')).toBe(false);
  });
  it('keeps figures exact: a different number is not a match', () => {
    expect(fuzzyIncludes(SOURCES[0].text, 'The survey found that 26% of retailers cut waste')).toBe(false);
    expect(normalizeLoose('1,200 units')).toBe('1200 units');
  });
});

describe('judgeClaim', () => {
  const claim = { text: 'Adoption was highest among small shops', sourceIds: ['S2'] };
  it('verifies when the quote is in a cited source', () => {
    expect(judgeClaim({ ...claim, sourceIds: ['S1'] }, { verdict: 'supported', evidenceQuote: 'Adoption was highest among shops with fewer than ten staff' }, SOURCES, 'business').outcome).toBe('verified');
  });
  it('recognises support in a different source than the one cited', () => {
    const c = judgeClaim(claim, { verdict: 'supported', evidenceQuote: 'Adoption was highest among shops with fewer than ten staff' }, SOURCES, 'business');
    expect(c).toMatchObject({ outcome: 'miscited', supportedBy: ['S1'] });
  });
  it('separates "the model could not show it" from "the model says it is not there"', () => {
    expect(judgeClaim(claim, { verdict: 'supported', evidenceQuote: 'a passage that is nowhere in the sources' }, SOURCES, 'business').outcome).toBe('unconfirmed');
    expect(judgeClaim(claim, { verdict: 'supported', evidenceQuote: '' }, SOURCES, 'business').outcome).toBe('unconfirmed');
    expect(judgeClaim(claim, { verdict: 'unsupported' }, SOURCES, 'business').outcome).toBe('unsupported');
    expect(judgeClaim(claim, undefined, SOURCES, 'business').outcome).toBe('unassessed');
    expect(judgeClaim(claim, { verdict: 'partial', evidenceQuote: 'Adoption was highest among shops with fewer than ten staff' }, SOURCES, 'business').outcome).toBe('overstated');
  });
  it('classifies risk from the claim text, not from the model', () => {
    expect(judgeClaim({ text: '62% of retailers cut waste', sourceIds: ['S1'] }, { verdict: 'unsupported' }, SOURCES, 'business').risk).toBe('protected');
  });
});

describe('claimIssues', () => {
  it('turns a handful of unconfirmed general claims into warnings', () => {
    const issues = claimIssues([check({}), check({ text: 'Another general point' }), ...Array.from({ length: 6 }, (_, i) => check({ outcome: 'verified', text: `ok ${i}` }))], 'business');
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.severity === 'minor' && !i.overridable)).toBe(true);
  });
  it('allows a few, or a quarter of the claims if that is more', () => {
    expect(allowedUnconfirmed(5)).toBe(3);
    expect(allowedUnconfirmed(12)).toBe(3);
    expect(allowedUnconfirmed(20)).toBe(5);
  });
  it('sends too many unconfirmed general claims to review, not to a hard block', () => {
    const many = Array.from({ length: 4 }, (_, i) => check({ text: `General point ${i}` }));
    const issues = claimIssues(many, 'lifestyle');
    expect(issues).toHaveLength(4);
    expect(issues.every((i) => i.severity === 'major' && i.overridable === true)).toBe(true);
  });
  it('keeps a protected claim that cannot be confirmed as a hard blocker', () => {
    const [i] = claimIssues([check({ risk: 'protected', text: 'Waste fell by 62%', outcome: 'unconfirmed' })], 'business');
    expect(i).toMatchObject({ code: 'unsupported_claim', severity: 'major' });
    expect(i.overridable).toBeFalsy();
  });
  it('treats health and finance as strictly as before', () => {
    const [i] = claimIssues([check({ risk: 'protected', outcome: 'unsupported' })], 'health');
    expect(i).toMatchObject({ code: 'unsupported_claim', severity: 'critical' });
    const [p] = claimIssues([check({ risk: 'protected', outcome: 'overstated' })], 'finance');
    expect(p).toMatchObject({ code: 'claim_overstated', severity: 'major' });
  });
  it('records removed sentences and mis-citations as warnings only', () => {
    const removed = new Set(['Shops often rethink how they reorder stock']);
    const issues = claimIssues([check({ outcome: 'unsupported' }), check({ outcome: 'miscited', text: 'Other', supportedBy: ['S2'] })], 'business', removed);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['claim_removed', 'minor'], ['claim_miscited', 'minor']]);
  });
  it('only general unsupported claims in ordinary categories are removable', () => {
    const checks = [check({ outcome: 'unsupported' }), check({ outcome: 'unconfirmed', text: 'b' }), check({ outcome: 'unsupported', risk: 'protected', text: 'c 5%' })];
    expect(removable(checks, 'business').map((c) => c.text)).toEqual(['Shops often rethink how they reorder stock']);
    expect(removable(checks, 'health')).toEqual([]);
    expect(removable(checks, 'finance')).toEqual([]);
  });
});

describe('removeClaimSentence', () => {
  const md = '## Section\n\nShops adopt tools slowly. Adoption was highest among shops with fewer than ten staff [S2]. Setup takes weeks.\n\n| a | b |\n|---|---|\n| Adoption was highest | x |\n';
  it('removes only the matching sentence from prose', () => {
    const r = removeClaimSentence(md, 'Adoption was highest among shops with fewer than ten staff')!;
    expect(r.removed).toContain('Adoption was highest');
    expect(r.markdown).toContain('Shops adopt tools slowly.');
    expect(r.markdown).toContain('Setup takes weeks.');
    expect(r.markdown).not.toContain('fewer than ten staff');
    expect(r.markdown).toContain('| Adoption was highest | x |'); // tables and headings are never edited
    expect(r.markdown).toContain('## Section');
  });
  it('drops a line that becomes empty', () => {
    const r = removeClaimSentence('Intro.\n\nOnly this sentence is wrong about widgets.\n\nOutro.', 'Only this sentence is wrong about widgets')!;
    expect(r.markdown).toBe('Intro.\n\nOutro.');
  });
  it('leaves the text alone when no sentence clearly matches', () => {
    expect(removeClaimSentence(md, 'Quantum computing will replace spreadsheets entirely')).toBeNull();
  });
});
