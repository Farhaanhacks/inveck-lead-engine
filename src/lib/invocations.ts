/**
 * No invocation can still be working on a run or a sourcing test whose last sign of life is older than
 * this: each lasts at most 300 seconds (RUN_MAX_DURATION in run-driver.ts). One that stalled (Vercel
 * ends a long chain of invocations each calling the next, after a few) is picked up again from a fresh
 * request after it.
 */
export const RESUME_AFTER_MS = 330 * 1000;
