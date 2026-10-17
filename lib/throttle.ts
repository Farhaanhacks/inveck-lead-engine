/**
 * Runs housekeeping at most once per `ms` for a key on this server instance; within that window the
 * fallback is returned straight away. Today's list is drawn on every click (Show all, a filter, a
 * logged step), and the housekeeping only needs to run now and then, not before every page.
 */
const lastRun = new Map<string, number>();

export async function atMostEvery<T>(key: string, ms: number, fn: () => Promise<T>, fallback: T): Promise<T> {
  const now = Date.now();
  if (now - (lastRun.get(key) ?? 0) < ms) return fallback;
  lastRun.set(key, now);
  return fn();
}

/** For tests: forget when everything last ran. */
export function resetThrottle() {
  lastRun.clear();
}
