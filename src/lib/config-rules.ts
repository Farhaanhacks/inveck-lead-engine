import { addWorkingDays, type Holidays } from './tasks';

/**
 * The checks and arithmetic behind Configuration (no database): follow-up rules, their schedule, and the allocation
 * counts. The defaults are what the app did before any of it was configurable.
 */

// ─── Follow-up rules ───

export const OUTCOME_CHOICES = [
  { value: 'no_answer', label: 'No answer' },
  { value: 'busy', label: 'Busy or voicemail' },
  { value: 'wrong_number', label: 'Wrong number' },
] as const;
export const MAX_ROUNDS = 10;
export const MAX_SPACING = 10;

export type FollowupRule = { rounds: number; spacingDays: number; outcomes: string[] };
/** Today's behaviour for every ICP but CA: five rounds, every other working day, started by an unanswered call. */
export const DEFAULT_FOLLOWUP: FollowupRule = { rounds: 5, spacingDays: 2, outcomes: ['no_answer', 'busy', 'wrong_number'] };
/** CA firms: three rounds, one working day apart (after the LinkedIn request, see tasks.ts). */
export const CA_FOLLOWUP: FollowupRule = { rounds: 3, spacingDays: 1, outcomes: ['no_answer', 'busy', 'wrong_number'] };

export const parseOutcomes = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** Problems with a follow-up rule, in plain words (empty: fine). */
export function validateFollowup(r: FollowupRule): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(r.rounds) || r.rounds < 1 || r.rounds > MAX_ROUNDS) errors.push(`The number of follow-ups must be a whole number from 1 to ${MAX_ROUNDS}.`);
  if (!Number.isInteger(r.spacingDays) || r.spacingDays < 1 || r.spacingDays > MAX_SPACING) errors.push(`The gap between follow-ups must be a whole number of working days from 1 to ${MAX_SPACING}.`);
  const allowed = OUTCOME_CHOICES.map((o) => o.value) as string[];
  if (!r.outcomes.length) errors.push('Choose at least one call outcome that starts the follow-ups.');
  else if (r.outcomes.some((o) => !allowed.includes(o))) errors.push('Only no answer, busy or wrong number can start the follow-ups (a connected call always ends them).');
  return errors;
}

/** Working days from Day 1 for each round: every `spacingDays`, so 2 gives 2, 4, 6, 8, 10. */
export const offsetsOf = (r: Pick<FollowupRule, 'rounds' | 'spacingDays'>) => Array.from({ length: r.rounds }, (_, i) => (i + 1) * r.spacingDays);

/** The due date of each round for a sequence whose Day 1 is `day1`: weekends and holidays never count. */
export const scheduleFor = (r: Pick<FollowupRule, 'rounds' | 'spacingDays'>, day1: string, holidays?: Holidays) => offsetsOf(r).map((n) => addWorkingDays(day1, n, holidays));

// ─── Allocation ───

export type AllocationCheck = { ok: boolean; sum: number; message: string };

/** The per-ICP counts must add up to the BDA's daily total for the product. */
export function validateAllocation(total: number, counts: number[]): AllocationCheck {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (counts.some((n) => !Number.isInteger(n) || n < 0 || n > 500)) return { ok: false, sum, message: 'Each count must be a whole number from 0 to 500.' };
  if (!Number.isInteger(total) || total < 0 || total > 1000) return { ok: false, sum, message: 'The daily total must be a whole number from 0 to 1,000.' };
  if (sum !== total) return { ok: false, sum, message: `The ICP counts add up to ${sum}, but the daily total is ${total}. They must match exactly.` };
  return { ok: true, sum, message: '' };
}
