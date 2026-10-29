import { and, gte, sql } from 'drizzle-orm';
import type { AnyDb } from './db/types';
import { usageEvents } from './db/schema';
import type { UsageReport } from './providers/types';
import { startOfDay } from './time';

/** Stores one provider call. Cost is only recorded when the provider reported it; otherwise it stays null and labelled unknown. */
export async function recordUsage(db: AnyDb, u: UsageReport, jobId?: string) {
  await db.insert(usageEvents).values({
    jobId,
    provider: u.provider,
    model: u.model,
    operation: u.operation,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    requests: u.requests ?? 1,
    estimatedCostUsd: u.reportedCostUsd === undefined ? null : String(u.reportedCostUsd),
    costBasis: u.reportedCostUsd === undefined ? 'unknown' : 'provider_reported',
  });
}

export class BudgetExceededError extends Error {
  constructor(readonly period: 'daily' | 'monthly', readonly limitUsd: number, readonly spentUsd: number) {
    super(`The ${period} budget of $${limitUsd.toFixed(2)} is used up ($${spentUsd.toFixed(2)} recorded).`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Throws if recorded spend has reached a configured limit. Only costs the providers reported are summed,
 * so spend on calls with unknown cost (for example Gemini tokens) is not counted and the real total may be higher.
 */
export async function assertBudget(db: AnyDb, budget: { dailyUsd: number | null; monthlyUsd: number | null }, timeZone: string, now = new Date()) {
  const spent = async (since: Date) => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${usageEvents.estimatedCostUsd}), 0)` })
      .from(usageEvents)
      .where(and(gte(usageEvents.createdAt, since)));
    return Number(row?.total ?? 0);
  };
  if (budget.dailyUsd !== null) {
    const s = await spent(startOfDay(timeZone, now));
    if (s >= budget.dailyUsd) throw new BudgetExceededError('daily', budget.dailyUsd, s);
  }
  if (budget.monthlyUsd !== null) {
    const local = new Date(now.getTime());
    const monthStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    const s = await spent(monthStart);
    if (s >= budget.monthlyUsd) throw new BudgetExceededError('monthly', budget.monthlyUsd, s);
  }
}
