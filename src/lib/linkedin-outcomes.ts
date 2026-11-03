/**
 * The LinkedIn outcomes of the tracker (a lead's `linkedinOutcome`), apart from the per-contact activity steps on Today
 * (linkedin-activity.ts). No imports, so anything can use it.
 */
export const LI_POSITIVE = 'LinkedIn – Positive Response';
export const LI_NEGATIVE = 'LinkedIn – Negative Response';
export const LI_NEUTRAL = 'Neutral';
export const LI_NOT_ACTIVE = 'Not Active on LinkedIn';
/** The old "Not on LinkedIn" label, kept only so the one-time rename of saved data and the tests can name it. */
export const LI_NOT_ON_OLD = 'Not on LinkedIn';
/**
 * The old single "Replied". It said someone answered but not how, so saved ones are never turned into positive or negative by
 * guesswork: they keep this value (shown as "Replied (not classified)") until a person picks one of the three responses.
 */
export const LI_REPLIED_LEGACY = 'Replied';

/** The three kinds of response a person can pick. */
export const LI_RESPONSES = [LI_POSITIVE, LI_NEGATIVE, LI_NEUTRAL] as const;

/** Someone answered on LinkedIn, however: a classified response, or an old unclassified "Replied". */
export const isLinkedinResponse = (outcome: string) => (LI_RESPONSES as readonly string[]).includes(outcome) || outcome === LI_REPLIED_LEGACY;

/** A negative response ends the follow-ups: the lead leaves the follow-up list and nothing more is scheduled for it. */
export const isLinkedinNegative = (outcome: string | null | undefined) => outcome === LI_NEGATIVE;

/** What an outcome is called on screen. */
export const linkedinOutcomeLabel = (outcome: string) => (outcome === LI_REPLIED_LEGACY ? 'Replied (not classified)' : outcome);
