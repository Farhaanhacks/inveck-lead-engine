import { isLinkedinNegative, LI_POSITIVE } from './linkedin-outcomes';

/**
 * Outcomes that end a lead's follow-ups for good, read from the lead's saved Tracker outcomes (its call outcome, mail outcome and
 * LinkedIn outcome), so call, email and LinkedIn all count the same way:
 * - positive: Interested, a demo (scheduled or completed), a client (onboarded or already one); an email reply "Replied: interested";
 *   a "LinkedIn – Positive Response". The conversation is on: no more follow-up rounds are chosen or scheduled.
 * - negative: a "LinkedIn – Negative Response" (see linkedin-outcomes.ts).
 * (A wrong number is separate: whether it enters the follow-ups is a Configuration checkbox, off by default.)
 */
export const POSITIVE_CALL_OUTCOMES = ['Interested', 'Demo scheduled', 'Demo completed', 'Client onboarded', 'Already a client'] as const;
export const POSITIVE_MAIL_OUTCOME = 'Replied: interested';

export type OutcomeFields = { callFeedback: string; mailOutcome: string; linkedinOutcome: string };

export const isPositiveLead = (l: OutcomeFields) =>
  (POSITIVE_CALL_OUTCOMES as readonly string[]).includes(l.callFeedback) || l.mailOutcome === POSITIVE_MAIL_OUTCOME || l.linkedinOutcome === LI_POSITIVE;

/** True when the lead's saved outcomes mean it gets no follow-up rounds: a positive outcome anywhere, or a negative LinkedIn response. */
export const followUpsEnded = (l: OutcomeFields) => isPositiveLead(l) || isLinkedinNegative(l.linkedinOutcome);
