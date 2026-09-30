import type { LeadStatus } from '../db/schema';
import type { Contact } from './contacts';
import type { EmailStatus } from './emails';

export type Score = {
  finalScore: number;
  breakdown: string;
  readyForDraft: boolean;
  /** Status when no draft is written. */
  statusWithoutDraft: LeadStatus;
};

/** Owners and top executives: real decision-makers even when they aren't in the ICP's target titles. */
const OWNER_TITLE = /\b(managing director|md|ceo|chief executive|founder|co-?founder|owner|proprietor|partner|chairman|president)\b/i;

/**
 * 0-100, used to rank leads: ICP fit (up to 50), contact's role (20 for a target role, 15 for an
 * owner or top executive), verified email (20, or 10 when the server can't confirm it: catch-all
 * or company format), LinkedIn profile (5), phone (5).
 * Every qualified lead that can be reached (email or LinkedIn) gets a draft; a person reviews it
 * before anything is sent, so the score never blocks one.
 */
export function scoreLead(fitScore: number, contact: Contact, emailStatus: EmailStatus): Score {
  const emailOk = !!contact.email && (emailStatus === 'valid' || emailStatus === 'accept_all' || emailStatus === 'likely');
  const parts = {
    fit: fitScore * 5,
    role: contact.roleMatch ? 20 : OWNER_TITLE.test(contact.title) ? 15 : 0,
    email: !contact.email ? 0 : emailStatus === 'valid' ? 20 : emailStatus === 'accept_all' || emailStatus === 'likely' ? 10 : 0,
    linkedin: contact.linkedin ? 5 : 0,
    phone: contact.phone ? 5 : 0,
  };
  const finalScore = parts.fit + parts.role + parts.email + parts.linkedin + parts.phone;
  const reachable = emailOk || !!contact.linkedin;
  return {
    finalScore,
    breakdown:
      `Fit ${parts.fit}/50, role match ${parts.role}/20, email ${parts.email}/20, ` +
      `LinkedIn ${parts.linkedin}/5, phone ${parts.phone}/5`,
    readyForDraft: reachable,
    statusWithoutDraft: 'Needs Manual Contact',
  };
}
