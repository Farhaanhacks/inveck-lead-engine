import { describe, expect, it } from 'vitest';
import { findMatches, isBlocked, normalizedKey, type ExistingItem } from '@/lib/blogs/discovery/dedup';

const now = new Date('2026-10-18T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5);
const item = (over: Partial<ExistingItem>): ExistingItem => ({ id: '1', kind: 'article', status: 'published', headline: 'How to Start a Small Business in 2026', keyword: 'start small business', createdAt: daysAgo(3), ...over });

describe('duplicate detection', () => {
  it('normalises word order, case, plurals and stopwords', () => {
    expect(normalizedKey('Small Businesses: Starting a')).toBe(normalizedKey('start small business'.replace('start', 'starting')));
    expect(normalizedKey('AI tools for the small business')).toBe(normalizedKey('small business ai tool'));
  });

  it('blocks the same primary keyword', () => {
    const m = findMatches({ headline: 'Launching a tiny shop', primaryKeyword: 'Start Small Business', newestSourceAt: now }, [item({})], now);
    expect(isBlocked(m)).toBe(true);
    expect(m[0].reason).toBe('same primary keyword');
  });

  it('blocks a near-identical headline', () => {
    const m = findMatches({ headline: 'How to start a small business in 2026', primaryKeyword: 'founding a company', newestSourceAt: null }, [item({})], now);
    expect(isBlocked(m)).toBe(true);
  });

  it('does not block an unrelated topic', () => {
    const m = findMatches({ headline: 'Why central banks hold gold reserves', primaryKeyword: 'central bank gold reserves', newestSourceAt: now }, [item({})], now);
    expect(m).toHaveLength(0);
  });

  it('counts topics awaiting approval and in progress as duplicates', () => {
    for (const status of ['pending', 'approved', 'generating']) {
      const m = findMatches({ headline: 'Launching a tiny shop', primaryKeyword: 'start small business', newestSourceAt: now }, [item({ kind: 'topic', status })], now);
      expect(isBlocked(m)).toBe(true);
    }
  });

  it('remembers a rejection for 90 days, then forgets it', () => {
    const cand = { headline: 'Launching a tiny shop', primaryKeyword: 'start small business', newestSourceAt: now };
    expect(isBlocked(findMatches(cand, [item({ kind: 'topic', status: 'rejected', createdAt: daysAgo(40) })], now))).toBe(true);
    expect(findMatches(cand, [item({ kind: 'topic', status: 'rejected', createdAt: daysAgo(120) })], now)).toHaveLength(0);
  });

  it('allows a genuinely new development on an old published article', () => {
    const old = item({ createdAt: daysAgo(60), headline: 'Interest rate outlook for 2026', keyword: 'interest rate outlook' });
    const cand = { headline: 'Interest rate outlook after the October central bank cut', primaryKeyword: 'interest rate outlook', newestSourceAt: daysAgo(1) };
    const m = findMatches(cand, [old], now);
    expect(m).toHaveLength(1);
    expect(m[0].overridden).toBe(true);
    expect(isBlocked(m)).toBe(false);
  });

  it('does not allow a repeat just because the topic is trending again', () => {
    const recent = item({ createdAt: daysAgo(5), headline: 'Interest rate outlook for 2026', keyword: 'interest rate outlook' });
    const cand = { headline: 'Interest rate outlook for 2026', primaryKeyword: 'interest rate outlook', newestSourceAt: daysAgo(1) };
    expect(isBlocked(findMatches(cand, [recent], now))).toBe(true);
    const oldNoNews = item({ createdAt: daysAgo(60), headline: 'Interest rate outlook for 2026', keyword: 'interest rate outlook' });
    expect(isBlocked(findMatches({ ...cand, newestSourceAt: daysAgo(90) }, [oldNoNews], now))).toBe(true);
  });
});
