// Timestamps are stored in UTC; these helpers convert to and from a named IANA timezone, DST included.

/** Milliseconds the timezone is ahead of UTC at the given instant. */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant for a wall-clock time in the timezone. Nonexistent (spring-forward) times move forward. */
export function zonedTimeToUtc(timeZone: string, y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  const reads = (utc: number) => utc + tzOffsetMs(timeZone, new Date(utc)) === wall;
  const first = wall - tzOffsetMs(timeZone, new Date(wall));
  const second = wall - tzOffsetMs(timeZone, new Date(first));
  if (reads(second)) return new Date(second);
  if (reads(first)) return new Date(first);
  // Neither guess shows this wall time: it falls in a spring-forward gap, so take the later instant.
  return new Date(Math.max(first, second));
}

/** Midnight at the start of the local day containing `at`, as a UTC instant. */
export function startOfDay(timeZone: string, at: Date): Date {
  const local = new Date(at.getTime() + tzOffsetMs(timeZone, at));
  return zonedTimeToUtc(timeZone, local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
}

/** Start of the local week (Monday). */
export function startOfWeek(timeZone: string, at: Date): Date {
  const day0 = startOfDay(timeZone, at);
  const local = new Date(day0.getTime() + tzOffsetMs(timeZone, day0));
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return zonedTimeToUtc(timeZone, local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate() - sinceMonday);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatInZone(date: Date | string | null | undefined, timeZone: string): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
}

/** Adds whole local days (not 24-hour blocks), so a daylight-saving change does not shift the clock time. */
export function addDays(startOfLocalDay: Date, days: number): Date {
  return new Date(startOfLocalDay.getTime() + days * 24 * 3600_000 + 12 * 3600_000);
}
