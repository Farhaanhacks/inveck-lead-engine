import type { LeadStatus } from '../db/schema';
import type { Contact } from './contacts';
import type { EmailStatus } from './emails';

export type Score = {
  finalScore: number;
  breakdown: string;
  /** The contact can be reached (a usable email or a LinkedIn profile). */
  reachable: boolean;
  /** Status after drafting: reachable leads await approval; the rest need the team to find someone. */
  status: LeadStatus;
};

/**
 * 0-100, used to rank leads: the ICP fit (0-10) times ten, so a 9/10 fit is 90. How reachable the
 * contact is (email, phone, LinkedIn) doesn't change the score; those are filled in automatically.
 * Every qualified lead gets a draft, even with no contact found yet (the team finds one and uses it);
 * a person reviews it before anything is sent, so the score never blocks one.
 */
export function scoreLead(fitScore: number, contact: Contact, emailStatus: EmailStatus): Score {
  const emailOk = !!contact.email && (emailStatus === 'valid' || emailStatus === 'accept_all' || emailStatus === 'likely');
  const finalScore = Math.max(0, Math.min(100, Math.round(fitScore * 10)));
  const reachable = emailOk || !!contact.linkedin;
  return {
    finalScore,
    breakdown: '',
    reachable,
    status: reachable ? 'Awaiting Approval' : 'Needs Manual Contact',
  };
}
