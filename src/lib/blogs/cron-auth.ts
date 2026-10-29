import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { env } from './env';

/** True when the request carries `Authorization: Bearer <CRON_SECRET>`. Fails closed when no secret is configured. */
export function isCronAuthorized(request: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const given = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
