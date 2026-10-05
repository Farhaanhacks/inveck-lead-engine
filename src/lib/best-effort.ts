/**
 * Housekeeping that must never take a page (or the morning job) down with it: a failure is logged
 * with what was being done, and the fallback is used instead.
 */
export async function bestEffort<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[best-effort] ${what} failed:`, e);
    return fallback;
  }
}
