import { startOfDay, tzOffsetMs, zonedTimeToUtc } from '../time';

export type SlotConfig = {
  timezone: string;
  maxPerDay: number;
  windows: { start: string; end: string }[];
  minIntervalMinutes: number;
};

const MIN = 60_000;

/** "2026-10-18" style key for the local calendar day containing `at`. */
export function localDayKey(timeZone: string, at: Date): string {
  const local = new Date(at.getTime() + tzOffsetMs(timeZone, at));
  return local.toISOString().slice(0, 10);
}

function windowBounds(timeZone: string, dayKey: string, w: { start: string; end: string }): [Date, Date] {
  const [y, m, d] = dayKey.split('-').map(Number);
  const [sh, sm] = w.start.split(':').map(Number);
  const [eh, em] = w.end.split(':').map(Number);
  return [zonedTimeToUtc(timeZone, y, m, d, sh, sm), zonedTimeToUtc(timeZone, y, m, d, eh, em)];
}

/**
 * The first moment at or after `from` that is inside a publishing window, at least `minIntervalMinutes` away from every
 * taken time, on a day that has not reached `maxPerDay`. `taken` holds the times of everything already scheduled or published.
 * Days are local calendar days in the configured timezone, so daylight-saving changes are handled by the conversion.
 */
export function findSlot(from: Date, taken: Date[], config: SlotConfig, horizonDays = 60): Date | null {
  const gap = config.minIntervalMinutes * MIN;
  const times = taken.map((t) => t.getTime()).sort((a, b) => a - b);
  const perDay = new Map<string, number>();
  for (const t of times) {
    const k = localDayKey(config.timezone, new Date(t));
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  let day = startOfDay(config.timezone, from);
  for (let i = 0; i <= horizonDays; i++) {
    const key = localDayKey(config.timezone, new Date(day.getTime() + 12 * 3600_000));
    if ((perDay.get(key) ?? 0) < config.maxPerDay) {
      for (const w of [...config.windows].sort((a, b) => a.start.localeCompare(b.start))) {
        const [open, close] = windowBounds(config.timezone, key, w);
        let t = Math.max(open.getTime(), from.getTime());
        // Push past any neighbour that is too close, repeating until the spot is clear.
        for (let guard = 0; guard < 500; guard++) {
          const clash = times.find((x) => Math.abs(x - t) < gap);
          if (!clash) break;
          t = clash + gap;
        }
        if (t < close.getTime()) return new Date(Math.ceil(t / MIN) * MIN);
      }
    }
    day = startOfDay(config.timezone, new Date(day.getTime() + 36 * 3600_000));
  }
  return null;
}

/** Does `at` already have `maxPerDay` or more items on its local day? */
export function dayIsFull(at: Date, taken: Date[], config: Pick<SlotConfig, 'timezone' | 'maxPerDay'>): boolean {
  const key = localDayKey(config.timezone, at);
  return taken.filter((t) => localDayKey(config.timezone, t) === key).length >= config.maxPerDay;
}
