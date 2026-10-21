import type { LeadStatus } from '../db/schema';
import type { Contact } from './contacts';
/** How usable the contact's email is: only an address the team typed in counts ('likely'). */
export type EmailStatus = 'valid' | 'accept_all' | 'likely' | 'invalid' | 'unknown' | 'no email found';

export type Score = {
  finalScore: number;
  breakdown: string;
  /** The contact can be reached (a usable email or a LinkedIn profile). */
  reachable: boolean;
  /** Status after research: a qualified lead with a reachable contact is Approved; with nobody reachable it goes to Deleted (the caller records why). */
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
    status: reachable ? 'Approved' : 'Deleted',
  };
}
