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

/**
 * 0-100, used to rank leads: the ICP fit (0-10) times ten, so a 9/10 fit is 90. How reachable the
 * contact is (email, phone, LinkedIn) doesn't change the score; those are filled in automatically.
 * Every qualified lead that can be reached (email or LinkedIn) gets a draft; a person reviews it
 * before anything is sent, so the score never blocks one.
 */
export function scoreLead(fitScore: number, contact: Contact, emailStatus: EmailStatus): Score {
  const emailOk = !!contact.email && (emailStatus === 'valid' || emailStatus === 'accept_all' || emailStatus === 'likely');
  const finalScore = Math.max(0, Math.min(100, Math.round(fitScore * 10)));
  const reachable = emailOk || !!contact.linkedin;
  return {
    finalScore,
    breakdown: '',
    readyForDraft: reachable,
    statusWithoutDraft: 'Needs Manual Contact',
  };
}
