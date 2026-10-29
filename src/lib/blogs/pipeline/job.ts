import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { articleAssets, articleRevisions, articleSources, articles, auditLogs, contentJobs, domainProfiles, topicCandidates } from '../db/schema';
import type { AnyDb } from '../db/types';
import { domainConfigSchema } from '../domains/config';
import type { ImageProvider, LlmProvider, ResearchProvider, UsageReport } from '../providers/types';
import { assertBudget, BudgetExceededError, recordUsage } from '../usage';
import { createFeaturedImage, type ImageStorage } from './image';
import { loadAuthors, pickAuthor } from '../authors';
import { claimIssues, removable } from './claim-policy';
import { renderArticleHtml } from './markdown';
import type { ClaimCheck, Draft, Issue, Outline, Seo, SourceDoc, ValidationReport } from './schemas';
import { ProviderError } from '../providers/types';
import { generateSeo, isTransient, PipelineError, repairArticle, researchTopic, verifyClaims, writeArticle, type DomainInput, type StageDeps, type TopicInput } from './stages';
import { removeClaimSentence, slugify } from './text';
import { applyDeterministicFixes, validateArticle, type ExistingArticle } from './validate';

export const JOB_LEASE_MINUTES = 10;
/** No automatic rewrites: they doubled the time and the chances of hitting a busy model. Problems go to a person instead. */
export const MAX_REPAIR_ROUNDS = 0;
export const STAGES = ['research', 'planning', 'writing', 'seo', 'validation', 'image'] as const;
type Stage = (typeof STAGES)[number];

export type JobDeps = {
  research: ResearchProvider;
  llm: LlmProvider;
  image: ImageProvider | null;
  storage: ImageStorage | null;
  models: { writing: string; fast: string; image: string };
  budget: { dailyUsd: number | null; monthlyUsd: number | null };
  timeZone: string;
  now?: () => Date;
  /** How long one invocation may keep working before handing the job back to the queue. */
  budgetMs?: number;
  /** For tests: the source of randomness used to pick an author. */
  random?: () => number;
};

type JobRow = typeof contentJobs.$inferSelect;
export type JobOutcome = 'completed' | 'blocked' | 'failed' | 'retrying' | 'yielded' | 'cancelled' | 'skipped';

/** 30s, 1m, 2m, 4m, then every 5 minutes: busy models usually recover within minutes, so long waits only slow things down. */
export const backoffMs = (attempts: number) => Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

/** Takes a job that is due: queued, retrying after its backoff, or running with an expired lease. Exactly one caller wins. */
export async function claimJob(db: AnyDb, jobId: string, now: Date, force = false): Promise<JobRow | null> {
  const lease = new Date(now.getTime() + JOB_LEASE_MINUTES * 60_000);
  const [row] = await db
    .update(contentJobs)
    .set({ status: 'running', leaseExpiresAt: lease, startedAt: sql`coalesce(${contentJobs.startedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
    .where(
      and(
        eq(contentJobs.id, jobId),
        or(
          // A person pressing Run now skips the remaining wait; the scheduler respects it.
          and(inArray(contentJobs.status, ['queued', 'retrying']), force ? sql`true` : or(sql`${contentJobs.nextRunAt} is null`, lt(contentJobs.nextRunAt, new Date(now.getTime() + 1)))),
          and(eq(contentJobs.status, 'running'), lt(contentJobs.leaseExpiresAt, now)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export async function findDueJobs(db: AnyDb, now: Date, limit = 3): Promise<string[]> {
  const rows = await db
    .select({ id: contentJobs.id })
    .from(contentJobs)
    .where(or(and(inArray(contentJobs.status, ['queued', 'retrying']), or(sql`${contentJobs.nextRunAt} is null`, lt(contentJobs.nextRunAt, new Date(now.getTime() + 1)))), and(eq(contentJobs.status, 'running'), lt(contentJobs.leaseExpiresAt, now))))
    .orderBy(contentJobs.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

type Progress = { stages?: Record<string, { startedAt?: string; completedAt?: string; note?: string }> };

async function setStage(db: AnyDb, job: JobRow, stage: string, patch: Partial<typeof contentJobs.$inferInsert>, note?: { stage: string; text: string }, now = new Date(), progressPatch: Record<string, unknown> = {}) {
  const progress = { ...((job.progress ?? {}) as Progress), ...progressPatch };
  const stages = { ...(progress.stages ?? {}) };
  if (note) stages[note.stage] = { ...stages[note.stage], completedAt: now.toISOString(), note: note.text };
  const [updated] = await db.update(contentJobs).set({ stage, progress: { ...progress, stages }, updatedAt: now, ...patch }).where(eq(contentJobs.id, job.id)).returning();
  return updated;
}

async function loadContext(db: AnyDb, job: JobRow) {
  const [topic] = await db.select().from(topicCandidates).where(eq(topicCandidates.id, job.topicId));
  if (!topic) throw new PipelineError('The topic for this job no longer exists', 'topic_missing');
  const [domainRow] = await db.select().from(domainProfiles).where(eq(domainProfiles.id, topic.domainId));
  const domain: DomainInput = {
    slug: domainRow.slug,
    name: domainRow.name,
    audience: domainRow.audience,
    tone: domainRow.tone,
    geography: domainRow.geography,
    defaultArticleLength: domainRow.defaultArticleLength,
    config: domainConfigSchema.parse(domainRow.config),
  };
  const topicInput: TopicInput = {
    headline: topic.headline,
    summary: topic.summary,
    primaryKeyword: topic.primaryKeyword,
    secondaryKeywords: topic.secondaryKeywords as string[],
    relatedQuestions: topic.relatedQuestions as string[],
    searchIntent: topic.searchIntent,
    targetAudience: topic.targetAudience,
    articleFormat: topic.articleFormat,
    category: topic.category,
    sources: topic.sources as { url: string }[],
  };
  return { topic, domainRow, domain, topicInput };
}

async function loadSources(db: AnyDb, articleId: string): Promise<SourceDoc[]> {
  const rows = await db.select().from(articleSources).where(eq(articleSources.articleId, articleId)).orderBy(articleSources.createdAt);
  return rows
    .map((r) => {
      const ex = r.excerpts as { highlights?: string[]; text?: string; n?: number };
      return { n: ex.n ?? 0, id: `S${ex.n ?? 0}`, url: r.url, title: r.title ?? r.url, publisher: r.publisher, publishedAt: r.publishedAt?.toISOString() ?? null, excerpts: ex.highlights ?? [], text: ex.text ?? '' };
    })
    .sort((a, b) => a.n - b.n);
}

async function otherArticles(db: AnyDb, domainId: string, exceptId: string, withBody: boolean): Promise<ExistingArticle[]> {
  const rows = await db
    .select({ id: articles.id, title: articles.title, slug: articles.slug, body: articles.bodyMarkdown })
    .from(articles)
    .where(and(eq(articles.domainId, domainId), ne(articles.id, exceptId), inArray(articles.status, ['ready', 'scheduled', 'publishing', 'published', 'blocked'])))
    .orderBy(desc(articles.updatedAt))
    .limit(withBody ? 200 : 60);
  return rows.map((r) => ({ id: r.id, title: r.title, slug: r.slug, bodyMarkdown: withBody ? r.body : '' }));
}

async function snapshot(db: AnyDb, articleId: string, reason: string) {
  const [a] = await db.select().from(articles).where(eq(articles.id, articleId));
  const version = (await db.select({ v: sql<number>`coalesce(max(${articleRevisions.version}), 0)` }).from(articleRevisions).where(eq(articleRevisions.articleId, articleId)))[0].v + 1;
  await db.insert(articleRevisions).values({ articleId, version, reason, snapshot: { title: a.title, slug: a.slug, bodyMarkdown: a.bodyMarkdown, excerpt: a.excerpt, seoTitle: a.seoTitle, metaDescription: a.metaDescription, metadata: a.metadata } });
  await db.update(articles).set({ version, updatedAt: new Date() }).where(eq(articles.id, articleId));
}

async function uniqueSlug(db: AnyDb, wanted: string, articleId: string): Promise<string> {
  const base = slugify(wanted) || 'article';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [hit] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.slug, candidate), ne(articles.id, articleId))).limit(1);
    if (!hit) return candidate;
  }
  return `${base}-${articleId.slice(0, 8)}`;
}

const summarize = (issues: Issue[]) => issues.filter((i) => i.severity !== 'minor').map((i) => `${i.code}: ${i.message}`);

/**
 * Advances one job as far as time allows. Each stage saves its result before the job moves on, so a crash,
 * restart or retry resumes at the stage that was interrupted instead of redoing finished work.
 */
export async function runJob(db: AnyDb, jobId: string, deps: JobDeps, opts: { force?: boolean } = {}): Promise<JobOutcome> {
  const clock = () => deps.now?.() ?? new Date();
  const startedAt = clock();
  let job = await claimJob(db, jobId, startedAt, opts.force);
  if (!job) return 'skipped';
  const usage: UsageReport[] = [];
  const stageDeps = { research: deps.research, llm: deps.llm, image: deps.image, models: deps.models, onUsage: (u: UsageReport) => usage.push(u), now: startedAt };
  const budgetMs = deps.budgetMs ?? 170_000;

  try {
    await db.update(topicCandidates).set({ status: 'generating', updatedAt: startedAt }).where(and(eq(topicCandidates.id, job.topicId), eq(topicCandidates.status, 'approved')));
    await assertBudget(db, deps.budget, deps.timeZone, startedAt);

    for (let guard = 0; guard < 20; guard++) {
      const [fresh] = await db.select().from(contentJobs).where(eq(contentJobs.id, jobId));
      if (!fresh || fresh.status === 'cancelled') return 'cancelled';
      job = fresh;
      const stage = job.stage as Stage | 'done';
      if (stage === 'done') {
        await db.update(contentJobs).set({ status: 'completed', completedAt: clock(), leaseExpiresAt: null, error: null }).where(eq(contentJobs.id, jobId));
        return 'completed';
      }
      if (guard > 0 && clock().getTime() - startedAt.getTime() > budgetMs) {
        await db.update(contentJobs).set({ status: 'queued', nextRunAt: clock(), leaseExpiresAt: null }).where(eq(contentJobs.id, jobId));
        return 'yielded';
      }
      const now = clock();
      await db.update(contentJobs).set({ leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MINUTES * 60_000) }).where(eq(contentJobs.id, jobId));

      const result = await runStage(db, job, stage, deps, stageDeps, now);
      // Usage is saved stage by stage so a crash cannot lose what was already spent.
      for (const u of usage.splice(0)) await recordUsage(db, u, jobId).catch((err) => console.error('usage write failed', err instanceof Error ? err.message : err));
      if (result === 'blocked') return 'blocked';
    }
    return 'yielded';
  } catch (e) {
    return handleFailure(db, job, e, clock());
  } finally {
    for (const u of usage) await recordUsage(db, u, jobId).catch((err) => console.error('usage write failed', err instanceof Error ? err.message : err));
  }
}

async function handleFailure(db: AnyDb, job: JobRow, e: unknown, now: Date): Promise<JobOutcome> {
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof PipelineError ? e.code : e instanceof BudgetExceededError ? 'budget' : e && typeof e === 'object' && 'provider' in e ? 'provider_error' : 'unexpected';
  console.error('content job failed', { jobId: job.id, stage: job.stage, code, message });
  if (e instanceof BudgetExceededError) {
    await db.update(contentJobs).set({ status: 'blocked', leaseExpiresAt: null, error: { code: 'budget', message, stage: job.stage }, updatedAt: now }).where(eq(contentJobs.id, job.id));
    return 'blocked';
  }
  const [cur] = await db.select().from(contentJobs).where(eq(contentJobs.id, job.id));
  const articleId = cur?.articleId ?? job.articleId;
  const stage = cur?.stage ?? job.stage;
  const attempts = (cur?.attempts ?? job.attempts) + 1;
  const transient = isTransient(e);
  // A busy provider is not the job's fault: give it more tries, spread out by the backoff (30s, 2m, 8m, then 30m apart).
  const maxAttempts = e instanceof ProviderError && e.transient ? Math.max(job.maxAttempts, 6) : job.maxAttempts;
  if (!transient || attempts >= maxAttempts) {
    await db.update(contentJobs).set({ status: 'failed', attempts, leaseExpiresAt: null, completedAt: now, error: { code, message, stage, attempts, transient }, updatedAt: now }).where(eq(contentJobs.id, job.id));
    // A failure before the article was ever validated leaves it unusable; after that (the image) the article stays as it is.
    if (articleId && stage !== 'image') await db.update(articles).set({ status: 'failed', updatedAt: now }).where(eq(articles.id, articleId));
    return 'failed';
  }
  const retryAt = new Date(now.getTime() + backoffMs(attempts));
  await db.update(contentJobs).set({ status: 'retrying', attempts, nextRunAt: retryAt, leaseExpiresAt: null, error: { code, message, stage, attempts, retryAt: retryAt.toISOString() }, maxAttempts, updatedAt: now }).where(eq(contentJobs.id, job.id));
  return 'retrying';
}

async function runStage(db: AnyDb, job: JobRow, stage: Stage, deps: JobDeps, sd: StageDeps, now: Date): Promise<'continue' | 'blocked'> {
  const ctx = await loadContext(db, job);
  const { topic, domainRow, domain, topicInput } = ctx;
  const progress = (job.progress ?? {}) as Progress;
  void progress;

  if (stage === 'research') {
    let articleId = job.articleId;
    if (!articleId) {
      const [a] = await db
        .insert(articles)
        .values({ topicId: topic.id, domainId: topic.domainId, title: topic.headline, slug: `${slugify(topic.headline)}-${job.id.slice(0, 8)}`, primaryKeyword: topic.primaryKeyword, category: topic.category, searchIntent: topic.searchIntent, status: 'draft', generationConfig: { models: deps.models }, metadata: { author: pickAuthor(await loadAuthors(db), deps.random) } })
        .returning({ id: articles.id });
      articleId = a.id;
      await db.update(contentJobs).set({ articleId }).where(eq(contentJobs.id, job.id));
    }
    const docs = await researchTopic(topicInput, domain, sd);
    await db.transaction(async (tx) => {
      await tx.delete(articleSources).where(eq(articleSources.articleId, articleId!));
      await tx.insert(articleSources).values(
        docs.map((d) => ({ articleId: articleId!, url: d.url, title: d.title, publisher: d.publisher, publishedAt: d.publishedAt ? new Date(d.publishedAt) : null, retrievedAt: now, excerpts: { n: d.n, highlights: d.excerpts, text: d.text }, supportingClaims: [] })),
      );
    });
    await setStage(db, job, 'planning', { articleId }, { stage: 'research', text: `${docs.length} sources from ${new Set(docs.map((d) => d.publisher)).size} publishers` }, now);
    return 'continue';
  }

  const articleId = job.articleId;
  if (!articleId) throw new PipelineError('The job has no article yet', 'state_error');
  const sources = await loadSources(db, articleId);
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId));

  if (stage === 'planning') {
    // No separate AI outline call any more: it doubled the slowest part of the job. The writer structures the article itself;
    // this step only records the title and angle.
    const outline: Outline = { title: topic.headline, angle: topic.summary, sections: [], faqs: [], comparison: null, conclusionPoints: [], internalLinks: [] };
    await db.update(articles).set({ metadata: { ...(article.metadata as object), outline }, title: outline.title, updatedAt: now }).where(eq(articles.id, articleId));
    await setStage(db, job, 'writing', {}, { stage: 'planning', text: 'written directly, no separate outline' }, now);
    return 'continue';
  }

  if (stage === 'writing') {
    const outline = (article.metadata as { outline?: Outline }).outline;
    if (!outline) throw new PipelineError('No outline to write from', 'state_error');
    const draft = await writeArticle(topicInput, domain, outline, sources, sd);
    const fixed = applyDeterministicFixes(draft.bodyMarkdown, domain.slug);
    await db.update(articles).set({ bodyMarkdown: fixed.markdown, metadata: { ...(article.metadata as object), claims: draft.claims, fixes: fixed.changes }, status: 'draft', updatedAt: now }).where(eq(articles.id, articleId));
    await snapshot(db, articleId, 'initial draft');
    await setStage(db, job, 'seo', {}, { stage: 'writing', text: 'draft saved' }, now, { validationRound: 0 });
    return 'continue';
  }

  if (stage === 'seo') {
    const seo = await generateSeo(topicInput, domain, article.title, article.bodyMarkdown, sd);
    const slug = await uniqueSlug(db, seo.slug, articleId);
    await db
      .update(articles)
      .set({
        slug,
        seoTitle: seo.seoTitle,
        metaDescription: seo.metaDescription,
        excerpt: seo.excerpt,
        secondaryKeywords: seo.secondaryKeywords,
        category: seo.category,
        tags: [...new Set([...domain.config.publishing.defaultTags, ...seo.tags])],
        metadata: { ...(article.metadata as object), seo: { imageAlt: seo.imageAlt, imagePrompt: seo.imagePrompt, canonicalNote: seo.canonicalNote, structuredData: seo.structuredData } },
        updatedAt: now,
      })
      .where(eq(articles.id, articleId));
    await setStage(db, job, 'validation', {}, { stage: 'seo', text: `slug ${slug}` }, now);
    return 'continue';
  }

  if (stage === 'validation') {
    return validateStage(db, job, article, domain, domainRow.id, sources, topicInput, sd, now);
  }

  // image
  return imageStage(db, job, article, domain, deps, sd, now);
}

type ArticleRow = typeof articles.$inferSelect;

async function validateStage(db: AnyDb, job: JobRow, article: ArticleRow, domain: DomainInput, domainId: string, sources: SourceDoc[], topic: TopicInput, sd: StageDeps, now: Date): Promise<'continue' | 'blocked'> {
  const meta = article.metadata as { seo?: { imageAlt: string; imagePrompt: string; canonicalNote: string; structuredData: string[] }; claims?: Draft['claims'] };
  const existing = await otherArticles(db, domainId, article.id, true);
  let body = article.bodyMarkdown;
  let claims = meta.claims ?? [];
  const seo: Seo | null = meta.seo
    ? { seoTitle: article.seoTitle ?? '', metaDescription: article.metaDescription ?? '', slug: article.slug, secondaryKeywords: article.secondaryKeywords as string[], excerpt: article.excerpt ?? '', imageAlt: meta.seo.imageAlt, imagePrompt: meta.seo.imagePrompt, category: article.category ?? domain.name, tags: article.tags as string[], canonicalNote: meta.seo.canonicalNote, structuredData: meta.seo.structuredData as Seo['structuredData'] }
    : null;

  // One pass per call: the round number lives on the job, so a crash or a time-budget handover resumes at the same round.
  const round = ((job.progress ?? {}) as Progress & { validationRound?: number }).validationRound ?? 0;
  body = applyDeterministicFixes(body, domain.slug).markdown;

  // The single model call of this pass. Quotes are matched in code against every source.
  // The fact-check is useful but not worth stalling for: if Google is overloaded even after the fallback models, the article
  // finishes without it and is marked for a person to check instead.
  let checks: ClaimCheck[] = [];
  let checkUnavailable: string | null = null;
  try {
    ({ checks } = await verifyClaims(claims, sources, domain, sd));
  } catch (e) {
    if (!isTransient(e)) throw e;
    checkUnavailable = /high demand|503/i.test(String(e)) ? 'Google is overloaded right now' : (e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 160) : String(e));
  }

  // Sentences carrying an unsupported *general* claim are deleted outright (ordinary categories only). Removing text cannot add a false
  // claim, so no further model call is needed; what was removed is recorded so a person can see it.
  const removedClaims = new Set<string>();
  const removedLog: { sentence: string; claim: string }[] = [];
  for (const c of removable(checks, domain.slug)) {
    const r = removeClaimSentence(body, c.text);
    if (r) { body = r.markdown; removedClaims.add(c.text); removedLog.push({ sentence: r.removed, claim: c.text }); }
  }
  if (removedLog.length) {
    claims = claims.filter((c) => !removedClaims.has(c.text));
    await db.update(articles).set({ bodyMarkdown: body, metadata: { ...(article.metadata as object), claims }, updatedAt: now }).where(eq(articles.id, article.id));
    await snapshot(db, article.id, `removed ${removedLog.length} unsupported sentence${removedLog.length === 1 ? '' : 's'}`);
    await db.insert(auditLogs).values({ actor: 'system', action: 'article.sentences_removed', entityType: 'article', entityId: article.id, details: { removed: removedLog } });
  }

  const report: ValidationReport = validateArticle({ title: article.title, bodyMarkdown: body, seo, primaryKeyword: topic.primaryKeyword, sources, claims, domain: { slug: domain.slug, name: domain.name, config: domain.config }, targetWords: domain.defaultArticleLength, existing, round, now });
  const allIssues: Issue[] = [
    ...report.issues,
    ...claimIssues(checks, domain.slug, removedClaims),
    ...(checkUnavailable ? [{ code: 'claims_not_checked', severity: 'major' as const, overridable: true, message: `The automatic fact-check could not run (${checkUnavailable}). Check the facts against the sources before release.` }] : []),
  ];
  report.stats.claims = checks.length;
  report.stats.claimsVerified = checks.filter((c) => c.outcome === 'verified' || c.outcome === 'miscited').length;

  // At most one rewrite, and only for problems that are not simply "a claim I could not confirm".
  const fixable = allIssues.filter((i) => i.severity !== 'minor' && !i.overridable);
  if (fixable.length && round < MAX_REPAIR_ROUNDS) {
    const draft = await repairArticle(domain, body, claims, fixable, sources, sd);
    await db.update(articles).set({ bodyMarkdown: draft.bodyMarkdown, metadata: { ...(article.metadata as object), claims: draft.claims }, updatedAt: now }).where(eq(articles.id, article.id));
    await snapshot(db, article.id, `repair round ${round + 1}: ${[...new Set(fixable.map((b) => b.code))].join(', ')}`);
    await db.update(contentJobs).set({ progress: { ...((job.progress ?? {}) as object), validationRound: round + 1 }, updatedAt: now }).where(eq(contentJobs.id, job.id));
    return 'continue';
  }

  // Nothing is a dead end any more: every remaining problem is shown to a person, who can release the article with a note,
  // re-check it, or rewrite it. Nothing with an open problem moves on without that release.
  const reviewIssues = allIssues.map((i) => (i.severity === 'minor' ? i : { ...i, overridable: true }));
  const flags = reviewIssues.filter((i) => i.severity !== 'minor');
  if (domain.config.validation.requireHumanReview) flags.push({ code: 'human_review_required', severity: 'major', overridable: true, message: `${domain.name} articles always need a person to release them.` });
  const hard: Issue[] = [];
  const final: ValidationReport = {
    ...report,
    issues: [...reviewIssues, ...(domain.config.validation.requireHumanReview ? [flags[flags.length - 1]] : [])],
    passed: !hard.length && !flags.length,
    claimChecks: checks,
    removed: removedLog,
    warnings: allIssues.filter((i) => i.severity === 'minor').length,
  };

  const sourceRefs = sources.map((s) => ({ n: s.n, title: s.title, url: s.url, publisher: s.publisher }));
  const html = renderArticleHtml(body, sourceRefs);
  const status = final.passed ? 'ready' : 'blocked';
  await db.update(articles).set({ bodyMarkdown: body, bodyHtml: html, validation: final, status, metadata: { ...(article.metadata as object), claims }, updatedAt: now }).where(eq(articles.id, article.id));
  // Record which sources back which claims.
  for (const s of sources) {
    const supporting = claims.filter((c) => c.sourceIds.includes(s.id)).map((c) => c.text);
    if (supporting.length) await db.update(articleSources).set({ supportingClaims: supporting }).where(and(eq(articleSources.articleId, article.id), eq(articleSources.url, s.url)));
  }
  await snapshot(db, article.id, final.passed ? 'validated' : 'validation blocked');

  if (final.passed) {
    await setStage(db, job, 'image', {}, { stage: 'validation', text: `passed after ${report.round} repair round(s)` }, now);
    return 'continue';
  }
  const reviewOnly = !hard.length;
  await db
    .update(contentJobs)
    .set({
      status: 'blocked',
      stage: 'validation',
      leaseExpiresAt: null,
      updatedAt: now,
      error: { code: 'validation_blocked', reviewOnly, message: 'Ready for your review: read the article and its flags, then release it, re-check it or rewrite it.', issues: summarize([...hard, ...flags]) },
    })
    .where(eq(contentJobs.id, job.id));
  return 'blocked';
}

async function imageStage(db: AnyDb, job: JobRow, article: ArticleRow, domain: DomainInput, deps: JobDeps, sd: StageDeps, now: Date): Promise<'continue'> {
  const [existing] = await db.select().from(articleAssets).where(and(eq(articleAssets.articleId, article.id), eq(articleAssets.kind, 'featured_image')));
  if (existing && (existing.status === 'generated' || existing.status === 'uploaded') && existing.url) {
    await setStage(db, job, 'done', {}, { stage: 'image', text: 'image already stored' }, now);
    return 'continue';
  }
  const seo = (article.metadata as { seo?: { imageAlt: string; imagePrompt: string } }).seo;
  if (!seo) throw new PipelineError('No image prompt was generated', 'state_error');
  const [asset] = existing
    ? await db.update(articleAssets).set({ status: 'generating', error: null, updatedAt: now }).where(eq(articleAssets.id, existing.id)).returning()
    : await db.insert(articleAssets).values({ articleId: article.id, status: 'generating', altText: seo.imageAlt }).returning();

  try {
    if (!sd.image || !deps.storage) throw new PipelineError('Image generation or storage is not configured', 'no_image_provider');
    await assertBudget(db, deps.budget, deps.timeZone, now);
    const img = await createFeaturedImage({ provider: sd.image, storage: deps.storage, model: deps.models.image, scene: seo.imagePrompt, headline: article.title, articleId: article.id, styleNote: domain.config.prompts?.image });
    sd.onUsage(img.usage);
    await db
      .update(articleAssets)
      .set({ status: 'generated', url: img.url, storageKey: img.storageKey, width: img.width, height: img.height, mimeType: img.mimeType, altText: seo.imageAlt, generationMeta: { model: deps.models.image, bytes: img.bytes, prompt: seo.imagePrompt }, error: null, updatedAt: now })
      .where(eq(articleAssets.id, asset.id));
  } catch (e) {
    // A missing image never holds the article back. It is marked failed (scheduling still needs an image) and can be retried alone.
    const message = e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e);
    await db.update(articleAssets).set({ status: 'failed', error: { message }, updatedAt: now }).where(eq(articleAssets.id, asset.id));
    await setStage(db, job, 'done', {}, { stage: 'image', text: `image failed: ${message.slice(0, 120)}` }, now);
    return 'continue';
  }
  await setStage(db, job, 'done', {}, { stage: 'image', text: 'image stored' }, now);
  return 'continue';
}

// ---------------------------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------------------------
export type Actor = { id: number; email: string };

export async function cancelJob(db: AnyDb, jobId: string, actor: Actor): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db
    .update(contentJobs)
    .set({ status: 'cancelled', leaseExpiresAt: null, completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(contentJobs.id, jobId), inArray(contentJobs.status, ['queued', 'running', 'retrying', 'blocked', 'failed'])))
    .returning();
  if (!row) return { ok: false, reason: 'Only a job that has not finished can be cancelled.' };
  await db.insert(auditLogs).values({ actor: actor.email, action: 'job.cancelled', entityType: 'content_job', entityId: jobId, details: { stage: row.stage } });
  return { ok: true };
}

/** Failed jobs resume at the stage that failed. A job blocked on content problems goes back to writing; one blocked on budget resumes where it stopped. */
export async function retryJob(db: AnyDb, jobId: string, actor: Actor, mode: 'rewrite' | 'recheck' = 'rewrite'): Promise<{ ok: boolean; reason?: string }> {
  const [job] = await db.select().from(contentJobs).where(eq(contentJobs.id, jobId));
  if (!job || !['failed', 'blocked'].includes(job.status)) return { ok: false, reason: 'Only a failed or blocked job can be retried.' };
  const err = (job.error ?? {}) as { code?: string; reviewOnly?: boolean };
  if (mode === 'recheck' && err.code !== 'validation_blocked') return { ok: false, reason: 'Only an article blocked by its quality checks can be re-checked.' };
  // "Re-check" re-runs validation on the saved draft with no rewrite; "rewrite" goes back to the writing stage.
  const recheck = mode === 'recheck';
  const stage = err.code === 'validation_blocked' ? (recheck ? 'validation' : 'writing') : job.stage;
  const [row] = await db
    .update(contentJobs)
    .set({ status: 'queued', stage, attempts: 0, nextRunAt: null, leaseExpiresAt: null, completedAt: null, error: null, updatedAt: new Date(), ...(stage === 'writing' ? { progress: { ...((job.progress ?? {}) as object), validationRound: 0 } } : {}), ...(recheck ? { progress: { ...((job.progress ?? {}) as object), validationRound: MAX_REPAIR_ROUNDS } } : {}) })
    .where(and(eq(contentJobs.id, jobId), inArray(contentJobs.status, ['failed', 'blocked'])))
    .returning();
  if (!row) return { ok: false, reason: 'The job changed state; reload and try again.' };
  if (row.articleId && (stage === 'writing' || recheck)) await db.update(articles).set({ status: recheck ? 'validating' : 'draft', updatedAt: new Date() }).where(eq(articles.id, row.articleId));
  await db.insert(auditLogs).values({ actor: actor.email, action: 'job.retried', entityType: 'content_job', entityId: jobId, details: { resumeAt: stage, mode } });
  return { ok: true };
}

/** Releases an article that is blocked only by risk flags (for example a domain that always needs review). */
export async function releaseReview(db: AnyDb, articleId: string, actor: Actor, comment: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(contentJobs).where(and(eq(contentJobs.articleId, articleId), eq(contentJobs.status, 'blocked'))).for('update');
    const err = (job?.error ?? {}) as { code?: string; reviewOnly?: boolean };
    if (!job || err.code !== 'validation_blocked' || !err.reviewOnly) return { ok: false, reason: 'This article is not waiting for review. Blocked content problems must be fixed, not overridden.' };
    const [a] = await tx.select().from(articles).where(eq(articles.id, articleId));
    const validation = { ...(a.validation as object), passed: true, release: { by: actor.email, at: new Date().toISOString(), comment } };
    await tx.update(articles).set({ status: 'ready', validation, updatedAt: new Date() }).where(eq(articles.id, articleId));
    await tx.update(contentJobs).set({ status: 'queued', stage: 'image', attempts: 0, nextRunAt: null, error: null, updatedAt: new Date() }).where(eq(contentJobs.id, job.id));
    await tx.insert(auditLogs).values({ actor: actor.email, action: 'article.review_released', entityType: 'article', entityId: articleId, details: { comment, issues: err } });
    return { ok: true };
  });
}

/** Generates the featured image again for a finished article whose image failed. The article itself is not touched. */
export async function retryImage(db: AnyDb, articleId: string, actor: Actor): Promise<{ ok: boolean; reason?: string }> {
  const [asset] = await db.select().from(articleAssets).where(and(eq(articleAssets.articleId, articleId), eq(articleAssets.kind, 'featured_image')));
  if (asset && asset.status !== 'failed') return { ok: false, reason: 'The image has not failed.' };
  const [row] = await db
    .update(contentJobs)
    .set({ status: 'queued', stage: 'image', attempts: 0, nextRunAt: null, leaseExpiresAt: null, completedAt: null, error: null, updatedAt: new Date() })
    .where(and(eq(contentJobs.articleId, articleId), inArray(contentJobs.status, ['completed', 'failed'])))
    .returning({ id: contentJobs.id });
  if (!row) return { ok: false, reason: 'No finished job was found for this article.' };
  await db.insert(auditLogs).values({ actor: actor.email, action: 'job.image_retried', entityType: 'article', entityId: articleId, details: { jobId: row.id } });
  return { ok: true };
}
