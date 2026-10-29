import { describe, expect, it } from 'vitest';
import { jobState, postState, runState, shortError } from '@/lib/blogs/status';

const NOW = new Date('2026-10-22T12:00:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const later = (s: number) => new Date(NOW.getTime() + s * 1000);
const job = (over: Record<string, unknown> = {}) => ({ status: 'queued', stage: 'research', attempts: 0, maxAttempts: 3, nextRunAt: null, leaseExpiresAt: null, startedAt: null, updatedAt: ago(10), error: null, ...over }) as Parameters<typeof jobState>[0];

describe('jobState', () => {
  it('shows a never-started job as queued, and nudges when no worker has picked it up', () => {
    expect(jobState(job(), NOW)).toMatchObject({ label: 'Queued', active: true });
    expect(jobState(job(), NOW).live).toBeFalsy();
    expect(jobState(job({ updatedAt: ago(600) }), NOW).detail).toMatch(/Run now/);
  });

  it('shows a yielded job as waiting for the next worker run, not as running', () => {
    const st = jobState(job({ startedAt: ago(300), stage: 'validation' }), NOW);
    expect(st.label).toBe('Waiting: next is Quality checks');
    expect(st.live).toBeFalsy();
  });

  it('only calls a job running while a worker holds an unexpired lease', () => {
    expect(jobState(job({ status: 'running', stage: 'writing', leaseExpiresAt: later(300) }), NOW)).toMatchObject({ label: 'Running: Writing', live: true });
    const stalled = jobState(job({ status: 'running', stage: 'writing', leaseExpiresAt: ago(5) }), NOW);
    expect(stalled.label).toBe('Stalled at Writing');
    expect(stalled.live).toBeFalsy();
  });

  it('explains a retry with the attempt, a readable reason and when it runs', () => {
    const st = jobState(job({ status: 'retrying', stage: 'seo', attempts: 2, maxAttempts: 6, nextRunAt: later(120), error: { message: 'Gemini returned 503: {"error": "high demand"}' } }), NOW);
    expect(st.label).toBe('Retrying SEO');
    expect(st.detail).toMatch(/Attempt 2 of 6 failed: Google’s model is overloaded/);
    expect(st.at).toEqual(later(120));
    expect(jobState(job({ status: 'retrying', nextRunAt: ago(300), attempts: 1 }), NOW).detail).toMatch(/press Run now/);
  });

  it('separates waiting for review from a hard block, a budget pause and a failure', () => {
    expect(jobState(job({ status: 'blocked', stage: 'validation', error: { code: 'validation_blocked', reviewOnly: true } }), NOW)).toMatchObject({ label: 'Waiting for your review', active: false });
    expect(jobState(job({ status: 'blocked', stage: 'validation', error: { code: 'validation_blocked', reviewOnly: false, message: 'x' } }), NOW).label).toBe('Blocked by quality checks');
    expect(jobState(job({ status: 'blocked', error: { code: 'budget', message: 'daily budget used' } }), NOW).label).toBe('Paused: budget limit');
    expect(jobState(job({ status: 'failed', stage: 'research', error: { message: 'Only 2 usable sources' } }), NOW)).toMatchObject({ label: 'Failed at Research', tone: 'danger', detail: 'Only 2 usable sources', active: false });
  });

  it('marks completion, and says so when only the image failed', () => {
    expect(jobState(job({ status: 'completed', stage: 'done' }), NOW)).toMatchObject({ label: 'Complete', tone: 'ok', active: false });
    expect(jobState(job({ status: 'completed', stage: 'done' }), NOW, { imageFailed: true }).label).toBe('Complete, image failed');
  });
});

describe('runState', () => {
  const run = (over: Record<string, unknown> = {}) => ({ status: 'queued', leaseExpiresAt: null, createdAt: ago(10), result: {}, error: null, ...over }) as Parameters<typeof runState>[0];
  it('shows saved per-domain progress while running, and nothing invented before there is any', () => {
    expect(runState(run({ status: 'running', leaseExpiresAt: later(300), result: { progress: { total: 5, done: ['Business', 'Health'], failed: [], found: 4 } } }), NOW).detail).toBe('2 of 5 domains done · 4 topics found so far');
    expect(runState(run({ status: 'running', leaseExpiresAt: later(300) }), NOW).detail).not.toMatch(/\d/);
  });
  it('reports results, partial failures, full failures and stalls', () => {
    expect(runState(run({ status: 'completed', result: { created: 3, errors: [{ domain: 'finance', message: 'Exa returned 503' }] } }), NOW)).toMatchObject({ label: 'Completed: 3 topics' });
    expect(runState(run({ status: 'completed', result: { created: 3, errors: [{ domain: 'finance', message: 'Exa returned 503' }] } }), NOW).detail).toMatch(/finance/);
    expect(runState(run({ status: 'failed', error: { message: 'None of the selected domains exist' } }), NOW)).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(runState(run({ status: 'running', leaseExpiresAt: ago(5) }), NOW).label).toBe('Stalled');
  });
});

describe('postState', () => {
  const post = (over: Record<string, unknown> = {}) => ({ status: 'scheduled', isMock: false, scheduledFor: later(3600), nextAttemptAt: null, attempts: 0, maxAttempts: 5, lastError: null, ...over }) as Parameters<typeof postState>[0];
  it('distinguishes waiting, due, retrying, publishing and delayed', () => {
    expect(postState(post(), NOW)).toMatchObject({ label: 'Waiting for its time', active: false });
    expect(postState(post({ scheduledFor: ago(30) }), NOW).label).toBe('Due now');
    expect(postState(post({ scheduledFor: ago(30), attempts: 2, nextAttemptAt: later(60), lastError: { message: 'WordPress is unavailable (503)' } }), NOW)).toMatchObject({ label: 'Retry 2 of 5' });
    expect(postState(post({ status: 'publishing', nextAttemptAt: later(300) }), NOW)).toMatchObject({ label: 'Publishing now', live: true });
    expect(postState(post({ status: 'delayed', lastError: { message: 'Not published: featured image is missing.' } }), NOW)).toMatchObject({ label: 'Delayed', detail: 'Not published: featured image is missing.' });
  });
  it('never calls a mock post published', () => {
    expect(postState(post({ status: 'published', isMock: true }), NOW).label).toBe('Simulated (mock)');
    expect(postState(post({ status: 'published', isMock: false }), NOW).label).toBe('Published');
  });
  it('shows why a post failed', () => {
    expect(postState(post({ status: 'failed', lastError: { message: 'WordPress refused the credentials (401).' } }), NOW)).toMatchObject({ label: 'Failed', detail: 'WordPress refused the credentials (401).' });
  });
});

describe('shortError', () => {
  it('turns provider dumps into one sentence', () => {
    expect(shortError('Gemini returned 503: {\n "error": { "message": "This model is currently experiencing high demand." } }')).toBe('Google’s model is overloaded right now (503).');
    expect(shortError(null)).toBe('No details were recorded.');
    expect(shortError('x'.repeat(300))).toHaveLength(201);
  });
});
