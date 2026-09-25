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
 * 0-100: ICP fit (up to 50), contact's role matches a target role (20), verified email
 * (20, or 10 when the server can't confirm it: catch-all or company format), LinkedIn profile (5), phone (5).
 * A lead gets a draft when it can be reached (email or LinkedIn) and scores at least minScore.
 */
export function scoreLead(fitScore: number, contact: Contact, emailStatus: EmailStatus, minScore: number): Score {
  const emailOk = !!contact.email && (emailStatus === 'valid' || emailStatus === 'accept_all' || emailStatus === 'likely');
  const parts = {
    fit: fitScore * 5,
    role: contact.roleMatch ? 20 : 0,
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
    readyForDraft: reachable && finalScore >= minScore,
    statusWithoutDraft: reachable ? 'Low Score' : 'Needs Manual Contact',
  };
}
