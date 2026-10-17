import type { Icp } from './db/schema';

/** A segment name compared without case, spacing or punctuation: "3PL & Logistics" is "3pl and logistics". */
export function normSegment(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type IcpProblem = 'missing' | 'unknown' | 'inactive' | 'ambiguous';
export type IcpMatch<T> = { icp: T; problem?: undefined; detail?: undefined } | { icp?: undefined; problem: IcpProblem; detail: string };

/**
 * The ICP a lead is assessed against: the one active ICP whose name is the lead's segment (ignoring
 * case, spacing and punctuation). No segment, a segment no ICP has, a switched-off ICP or two ICPs
 * with the same name are problems to flag for review, never a reason to use some other ICP.
 */
export function resolveIcp<T extends Pick<Icp, 'segment' | 'active'>>(segment: string, icps: T[]): IcpMatch<T> {
  const want = normSegment(segment);
  if (!want) return { problem: 'missing', detail: 'No segment set: choose the ICP this company should be checked against' };
  const same = icps.filter((i) => normSegment(i.segment) === want);
  const active = same.filter((i) => i.active);
  if (active.length === 1) return { icp: active[0] };
  if (active.length > 1) return { problem: 'ambiguous', detail: `${active.length} active ICPs are named "${segment.trim()}": rename one so each segment is unique` };
  if (same.length) return { problem: 'inactive', detail: `The "${same[0].segment}" ICP is switched off: turn it on in Targets, or choose another segment` };
  return { problem: 'unknown', detail: `Segment "${segment.trim()}" matches no ICP: choose one of the ICPs` };
}

/** The ICP's own spelling of a segment typed by hand ("manufacturing" → "Manufacturing"), or the text as typed when no ICP has that name. */
export function canonicalSegment(segment: string, names: string[]): string {
  const want = normSegment(segment);
  return (want && names.find((n) => normSegment(n) === want)) || segment.trim();
}
