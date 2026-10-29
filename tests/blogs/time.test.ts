import { describe, expect, it } from 'vitest';
import { isValidTimeZone, startOfDay, startOfWeek, zonedTimeToUtc } from '@/lib/blogs/time';

describe('timezone helpers', () => {
  it('converts Asia/Kolkata wall time to UTC (+05:30, no DST)', () => {
    expect(zonedTimeToUtc('Asia/Kolkata', 2026, 6, 1, 9, 0).toISOString()).toBe('2026-06-01T03:30:00.000Z');
  });

  it('finds local midnight on the other side of the UTC date line', () => {
    // 2026-06-01T20:00Z is already 01:30 on 2 June in Kolkata.
    expect(startOfDay('Asia/Kolkata', new Date('2026-06-01T20:00:00Z')).toISOString()).toBe('2026-06-01T18:30:00.000Z');
  });

  it('handles the US spring-forward day (23 hours long)', () => {
    const start = startOfDay('America/New_York', new Date('2026-03-08T18:00:00Z'));
    const next = startOfDay('America/New_York', new Date('2026-03-09T18:00:00Z'));
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z'); // EST
    expect(next.toISOString()).toBe('2026-03-09T04:00:00.000Z'); // EDT
    expect((next.getTime() - start.getTime()) / 36e5).toBe(23);
  });

  it('handles the US fall-back day (25 hours long)', () => {
    const start = startOfDay('America/New_York', new Date('2026-11-01T18:00:00Z'));
    const next = startOfDay('America/New_York', new Date('2026-11-02T18:00:00Z'));
    expect((next.getTime() - start.getTime()) / 36e5).toBe(25);
  });

  it('moves a nonexistent spring-forward time forward instead of failing', () => {
    // 02:30 on 2026-03-08 does not exist in New York.
    expect(zonedTimeToUtc('America/New_York', 2026, 3, 8, 2, 30).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('starts the week on Monday', () => {
    // Wednesday 2026-06-03 in Kolkata -> Monday 2026-06-01 00:00 IST.
    expect(startOfWeek('Asia/Kolkata', new Date('2026-06-03T10:00:00Z')).toISOString()).toBe('2026-05-31T18:30:00.000Z');
  });

  it('validates timezone names', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
