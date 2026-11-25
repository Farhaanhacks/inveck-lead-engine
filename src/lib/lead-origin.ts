import { IMPORTED_SOURCE } from './contact-import';
import { INBOUND_SOURCE } from './inbound-source';

/** The source of a company added one at a time or in bulk by a team member. */
export const ADDED_BY_HAND = 'Added by hand';

/** Where a lead's data came from, as the Tracker tags and filters it. */
export const ORIGINS = ['Manual research', 'System data', 'Inbound'] as const;
export type Origin = (typeof ORIGINS)[number];

/** Companies the team added or uploaded are Manual research; inbound requests are Inbound; everything else (the lead feed, the CA database, research) is System data. */
export function originOf(lead: { source: string; inbound: boolean }): Origin {
  if (lead.source === ADDED_BY_HAND || lead.source === IMPORTED_SOURCE) return 'Manual research';
  if (lead.inbound || lead.source === INBOUND_SOURCE) return 'Inbound';
  return 'System data';
}

export const cleanOrigin = (v: unknown): Origin | '' => (ORIGINS.includes(v as Origin) ? (v as Origin) : '');
