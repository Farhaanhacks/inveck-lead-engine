/** The same check the server makes (config-rules.ts), small enough for the browser: counts must add up to the daily total. */
export function validateAllocationClient(total: number, counts: number[]): { ok: boolean; sum: number; message: string } {
  const sum = counts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (counts.some((n) => !Number.isInteger(n) || n < 0 || n > 500)) return { ok: false, sum, message: 'Each count must be a whole number from 0 to 500.' };
  if (!Number.isInteger(total) || total < 0 || total > 1000) return { ok: false, sum, message: 'The daily total must be a whole number from 0 to 1,000.' };
  if (sum !== total) return { ok: false, sum, message: `The ICP counts add up to ${sum}, but the daily total is ${total}. They must match exactly.` };
  return { ok: true, sum, message: '' };
}
