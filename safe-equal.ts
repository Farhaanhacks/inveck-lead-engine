import { timingSafeEqual } from 'node:crypto';

/** Compares a secret with what was sent, in constant time; never throws (any text, any length). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
