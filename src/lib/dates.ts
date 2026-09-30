const TZ = 'Asia/Kolkata';

/** "25 Sep 2026, 14:05" in Indian time. */
export function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

export function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** "3 days ago", "in 2 days", "today". */
export function relativeDays(d: Date, now = new Date()): string {
  const day = (x: Date) => Math.floor(new Date(x.toLocaleString('en-US', { timeZone: TZ })).setHours(0, 0, 0, 0) / 86_400_000);
  const diff = day(d) - day(now);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

/** True once the date has passed. */
export function isPast(d: Date): boolean {
  return d.getTime() <= Date.now();
}

/** "14:05" in Indian time. */
export function formatTime(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
