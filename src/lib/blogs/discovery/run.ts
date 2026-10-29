import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { articles, domainProfiles, topicCandidates, topicRuns } from '../db/schema';
import type { AnyDb } from '../db/types';
import { domainConfigSchema } from '../domains/config';
import type { LlmProvider, ResearchProvider, UsageReport } from '../providers/types';
import { ProviderError } from '../providers/types';
import { assertBudget, BudgetExceededError, recordUsage } from '../usage';
import type { ExistingItem } from './dedup';
import { discoverForDomain, runConfigSchema, type DomainOutcome } from './engine';
import type { Weights } from './scoring';

export const LEASE_MINUTES = 10;
export const MAX_RUN_ATTEMPTS = 3;

export type RunDeps = {
  research: ResearchProvider;
  llm: LlmProvider;
  model: string;
  weights: Weights;
  budget: { dailyUsd: number | null; monthlyUsd: number | null };
  timeZone: string;
  now?: () => Date;
};

type RunRow = typeof topicRuns.$inferSelect;

/** Takes a queued run, or one whose worker disappeared (lease expired). Exactly one caller wins. */
export async function claimRun(db: AnyDb, runId: string, now = new Date()): Promise<RunRow | null> {
  const lease = new Date(now.getTime() + LEASE_MINUTES * 60_000);
  const [row] = await db
    .update(topicRuns)
    .set({ status: 'running', startedAt: now, leaseExpiresAt: lease, attempts: sql`${topicRuns.attempts} + 1` })
    .where(
      and(
        eq(topicRuns.id, runId),
        lt(topicRuns.attempts, MAX_RUN_ATTEMPTS),
        or(eq(topicRuns.status, 'queued'), and(eq(topicRuns.status, 'running'), lt(topicRuns.leaseExpiresAt, now))),
      ),
    )
    .returning();
  return row ?? null;
}

/** Runs waiting for a worker: queued, or running with an expired lease. */
export async function findRunnableRuns(db: AnyDb, now = new Date(), limit = 3): Promise<string[]> {
  const rows = await db
    .select({ id: topicRuns.id })
    .from(topicRuns)
    .where(and(lt(topicRuns.attempts, MAX_RUN_ATTEMPTS), or(eq(topicRuns.status, 'queued'), and(eq(topicRuns.status, 'running'), lt(topicRuns.leaseExpiresAt, now)))))
    .orderBy(topicRuns.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

async function loadExisting(db: AnyDb, domainId: string, now: Date): Promise<ExistingItem[]> {
  const [topics, arts] = await Promise.all([
    db
      .select()
      .from(topicCandidates)
      .where(and(eq(topicCandidates.domainId, domainId), gt(topicCandidates.createdAt, new Date(now.getTime() - 400 * 864e5)))),
    db.select().from(articles).where(eq(articles.domainId, domainId)).orderBy(desc(articles.createdAt)).limit(500),
  ]);
  return [
    ...topics.map((t): ExistingItem => ({ id: t.id, kind: 'topic', status: t.status, headline: t.headline, keyword: t.primaryKeyword, createdAt: t.createdAt })),
    ...arts.map((a): ExistingItem => ({ id: a.id, kind: 'article', status: a.status, headline: a.title, keyword: a.primaryKeyword, createdAt: a.createdAt })),
  ];
}

export type RunSummary = { status: 'completed' | 'failed' | 'skipped'; created: number };

/**
 * Executes one discovery run. Safe to call from several workers at once: only the one that claims the lease proceeds.
 * One domain failing does not discard the others' results; the run fails only when every domain fails.
 */
export async function processTopicRun(db: AnyDb, runId: string, deps: RunDeps): Promise<RunSummary> {
  const now = deps.now?.() ?? new Date();
  const run = await claimRun(db, runId, now);
  if (!run) return { status: 'skipped', created: 0 };

  const errors: { domain: string; message: string; transient: boolean }[] = [];
  const perDomain: { domain: string; created: number; sourcesFound: number; skipped: DomainOutcome['skipped'] }[] = [];
  const usage: UsageReport[] = [];
  let created = 0;

  try {
    const cfg = runConfigSchema.parse(run.config);
    await assertBudget(db, deps.budget, deps.timeZone, now);
    const domains = await db.select().from(domainProfiles).where(and(inArray(domainProfiles.slug, cfg.domainSlugs), eq(domainProfiles.enabled, true)));
    if (!domains.length) throw new Error('None of the selected domains exist or are enabled');
    const wantedEach = Math.max(1, Math.round(cfg.count / domains.length));

    // Saved progress for the dashboard: which domains have finished and how many topics they produced so far.
    // Domains run in parallel, so this counts completions; it does not pretend to know a percentage.
    const progress = { total: domains.length, done: [] as string[], failed: [] as string[], found: 0 };
    const saveProgress = () =>
      db
        .update(topicRuns)
        .set({ result: { progress }, leaseExpiresAt: new Date(Date.now() + LEASE_MINUTES * 60_000) })
        .where(and(eq(topicRuns.id, runId), eq(topicRuns.status, 'running')))
        .catch((e) => console.error('progress write failed', e instanceof Error ? e.message : e));
    await saveProgress();

    const outcomes = await Promise.all(
      domains.map(async (d) => {
        try {
          const outcome = await discoverForDomain(
            { slug: d.slug, name: d.name, audience: d.audience, tone: d.tone, config: domainConfigSchema.parse(d.config) },
            cfg,
            wantedEach,
            { research: deps.research, llm: deps.llm, model: deps.model, weights: deps.weights, existing: await loadExisting(db, d.id, now), now, onUsage: (u) => usage.push(u) },
          );
          progress.done.push(d.name);
          progress.found += outcome.accepted.length;
          await saveProgress();
          return { d, outcome };
        } catch (e) {
          errors.push({ domain: d.slug, message: e instanceof Error ? e.message : String(e), transient: e instanceof ProviderError ? e.transient : false });
          progress.failed.push(d.name);
          await saveProgress();
          return null;
        }
      }),
    );

    for (const o of outcomes) {
      if (!o) continue;
      if (o.outcome.accepted.length) {
        await db.insert(topicCandidates).values(
          o.outcome.accepted.map((c) => ({
            runId,
            domainId: o.d.id,
            headline: c.headline,
            altHeadlines: c.altHeadlines,
            summary: c.summary,
            category: c.category,
            primaryKeyword: c.primaryKeyword,
            secondaryKeywords: c.secondaryKeywords,
            relatedQuestions: c.relatedQuestions,
            searchIntent: c.searchIntent,
            targetAudience: c.targetAudience,
            articleFormat: c.articleFormat,
            rationale: c.rationale,
            contentGap: c.contentGap,
            sources: c.sources,
            scores: c.scores,
            opportunityScore: c.opportunityScore === null ? null : String(c.opportunityScore),
            confidence: c.confidence,
            risks: c.risks,
            normalizedKey: c.normalizedKey,
            similarity: c.similarity,
          })),
        );
      }
      created += o.outcome.accepted.length;
      perDomain.push({ domain: o.d.slug, created: o.outcome.accepted.length, sourcesFound: o.outcome.sourcesFound, skipped: o.outcome.skipped });
    }

    const everyDomainFailed = errors.length > 0 && perDomain.length === 0;
    await db
      .update(topicRuns)
      .set({
        status: everyDomainFailed ? 'failed' : 'completed',
        completedAt: new Date(),
        leaseExpiresAt: null,
        result: { created, domains: perDomain, errors },
        error: everyDomainFailed ? { message: errors.map((e) => `${e.domain}: ${e.message}`).join('; '), errors } : null,
      })
      .where(eq(topicRuns.id, runId));
    return { status: everyDomainFailed ? 'failed' : 'completed', created };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(topicRuns)
      .set({ status: 'failed', completedAt: new Date(), leaseExpiresAt: null, error: { message, budget: e instanceof BudgetExceededError }, result: { created, domains: perDomain, errors } })
      .where(eq(topicRuns.id, runId));
    return { status: 'failed', created };
  } finally {
    // Usage is written after the work so a lost request cannot drop it, and a failed write is logged, not fatal.
    for (const u of usage) await recordUsage(db, u).catch((e) => console.error('usage write failed', e instanceof Error ? e.message : e));
  }
}

/** Puts a failed run back in the queue with a fresh attempt allowance. */
export async function retryRun(db: AnyDb, runId: string): Promise<boolean> {
  const rows = await db
    .update(topicRuns)
    .set({ status: 'queued', attempts: 0, error: null, completedAt: null, leaseExpiresAt: null })
    .where(and(eq(topicRuns.id, runId), eq(topicRuns.status, 'failed')))
    .returning({ id: topicRuns.id });
  return rows.length > 0;
}
