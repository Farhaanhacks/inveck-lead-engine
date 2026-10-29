import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Raw bytes (featured images are kept in the blog database, not in an outside storage bucket). */
const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType: () => 'bytea',
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : typeof v === 'string' && v.startsWith('\\x') ? Buffer.from(v.slice(2), 'hex') : Buffer.from(v as string)),
  toDriver: (v) => v,
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Status vocabularies live here so the database, the code and the UI share one list. */
export const TOPIC_RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export const TOPIC_STATUSES = ['pending', 'approved', 'rejected', 'generating', 'published', 'duplicate'] as const;
export const JOB_STAGES = ['research', 'planning', 'writing', 'seo', 'validation', 'image', 'publishing', 'done'] as const;
export const JOB_STATUSES = ['queued', 'running', 'retrying', 'blocked', 'failed', 'cancelled', 'completed'] as const;
export const ARTICLE_STATUSES = ['draft', 'validating', 'blocked', 'ready', 'scheduled', 'publishing', 'published', 'failed'] as const;
export const ASSET_STATUSES = ['pending', 'generating', 'generated', 'uploading', 'uploaded', 'failed'] as const;
export const POST_STATUSES = ['scheduled', 'publishing', 'published', 'delayed', 'failed', 'cancelled'] as const;

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

/**
 * The one profile the blog area writes for: Inveck. (The table keeps the shape Article Basket used for each of its sites, but
 * there is exactly one row here, slug 'inveck', and nothing to add or remove.)
 */
export const domainProfiles = pgTable('blog_profile', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  audience: text('audience').notNull(),
  geography: text('geography').notNull().default('Global'),
  locale: text('locale').notNull().default('en'),
  tone: text('tone').notNull(),
  defaultArticleLength: integer('default_article_length').notNull().default(1200),
  /** Research sources, formats, SEO rules, restricted claims, evidence standards, linking, categories, tags, validation. See DomainConfig. */
  config: jsonb('config').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const topicRuns = pgTable(
  'blog_topic_runs',
  {
    id: id(),
    status: text('status').notNull().default('queued'),
    domainIds: jsonb('domain_ids').notNull().default([]),
    config: jsonb('config').notNull().default({}),
    error: jsonb('error'),
    /** What the run produced: per-domain counts, skipped duplicates, failures. */
    result: jsonb('result').notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    /** A worker holds the run until this time; after it passes, another worker may take over. */
    leaseExpiresAt: ts('lease_expires_at'),
    requestedBy: integer('requested_by'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [check('blog_topic_runs_status_chk', inList('status', TOPIC_RUN_STATUSES)), index('blog_topic_runs_status_idx').on(t.status, t.createdAt)],
);

export const topicCandidates = pgTable(
  'blog_topic_candidates',
  {
    id: id(),
    runId: uuid('run_id').references(() => topicRuns.id, { onDelete: 'set null' }),
    domainId: uuid('domain_id').notNull().references(() => domainProfiles.id),
    headline: text('headline').notNull(),
    altHeadlines: jsonb('alt_headlines').notNull().default([]),
    summary: text('summary').notNull(),
    category: text('category'),
    primaryKeyword: text('primary_keyword').notNull(),
    secondaryKeywords: jsonb('secondary_keywords').notNull().default([]),
    relatedQuestions: jsonb('related_questions').notNull().default([]),
    searchIntent: text('search_intent'),
    targetAudience: text('target_audience'),
    articleFormat: text('article_format'),
    rationale: text('rationale'),
    contentGap: text('content_gap'),
    /** [{url, title, publisher, publishedAt}] */
    sources: jsonb('sources').notNull().default([]),
    /** Per-dimension {score, basis: 'actual'|'estimated'|'unavailable', note}. A missing metric is never stored as 0. */
    scores: jsonb('scores').notNull().default({}),
    opportunityScore: numeric('opportunity_score', { precision: 5, scale: 2 }),
    confidence: text('confidence'),
    risks: jsonb('risks').notNull().default([]),
    /** Normalised keyword key plus similarity matches found at creation. */
    normalizedKey: text('normalized_key').notNull(),
    similarity: jsonb('similarity').notNull().default({}),
    status: text('status').notNull().default('pending'),
    editedAt: ts('edited_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('blog_topic_candidates_status_chk', inList('status', TOPIC_STATUSES)),
    check('blog_topic_candidates_confidence_chk', sql`confidence is null or confidence in ('low', 'medium', 'high')`),
    index('blog_topic_candidates_status_idx').on(t.status, t.createdAt),
    index('blog_topic_candidates_key_idx').on(t.normalizedKey),
    index('blog_topic_candidates_run_idx').on(t.runId),
  ],
);

export const topicApprovals = pgTable(
  'blog_topic_approvals',
  {
    id: id(),
    topicId: uuid('topic_id').notNull().references(() => topicCandidates.id, { onDelete: 'cascade' }),
    adminId: integer('admin_id').notNull(),
    decision: text('decision').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [check('blog_topic_approvals_decision_chk', inList('decision', ['approved', 'rejected', 'edited'])), index('blog_topic_approvals_topic_idx').on(t.topicId)],
);

export const articles = pgTable(
  'blog_articles',
  {
    id: id(),
    topicId: uuid('topic_id').references(() => topicCandidates.id, { onDelete: 'set null' }),
    domainId: uuid('domain_id').notNull().references(() => domainProfiles.id),
    title: text('title').notNull(),
    slug: text('slug').notNull().unique(),
    bodyMarkdown: text('body_markdown').notNull().default(''),
    bodyHtml: text('body_html'),
    excerpt: text('excerpt'),
    seoTitle: text('seo_title'),
    metaDescription: text('meta_description'),
    primaryKeyword: text('primary_keyword'),
    secondaryKeywords: jsonb('secondary_keywords').notNull().default([]),
    searchIntent: text('search_intent'),
    category: text('category'),
    tags: jsonb('tags').notNull().default([]),
    /** Outline, internal-link suggestions, structured-data recommendations, canonical. */
    metadata: jsonb('metadata').notNull().default({}),
    /** Latest validation report: per-check status, severity and evidence. */
    validation: jsonb('validation').notNull().default({}),
    generationConfig: jsonb('generation_config').notNull().default({}),
    status: text('status').notNull().default('draft'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('blog_articles_status_chk', inList('status', ARTICLE_STATUSES)), index('blog_articles_status_idx').on(t.status, t.updatedAt)],
);

export const articleRevisions = pgTable(
  'blog_article_revisions',
  {
    id: id(),
    articleId: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('blog_article_revisions_version_uq').on(t.articleId, t.version)],
);

export const contentJobs = pgTable(
  'blog_content_jobs',
  {
    id: id(),
    topicId: uuid('topic_id').notNull().references(() => topicCandidates.id),
    articleId: uuid('article_id').references(() => articles.id, { onDelete: 'set null' }),
    stage: text('stage').notNull().default('research'),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** Set while a worker holds the job; a stale lease lets another worker take it over. */
    leaseExpiresAt: ts('lease_expires_at'),
    nextRunAt: ts('next_run_at'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    error: jsonb('error'),
    /** Stage-by-stage progress for the dashboard. */
    progress: jsonb('progress').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('blog_content_jobs_stage_chk', inList('stage', JOB_STAGES)),
    check('blog_content_jobs_status_chk', inList('status', JOB_STATUSES)),
    // One live job per topic; regeneration must first cancel or finish the previous job.
    uniqueIndex('blog_content_jobs_one_active_per_topic')
      .on(t.topicId)
      .where(sql`status in ('queued', 'running', 'retrying', 'blocked')`),
    index('blog_content_jobs_pickup_idx').on(t.status, t.nextRunAt),
  ],
);

export const articleSources = pgTable(
  'blog_article_sources',
  {
    id: id(),
    articleId: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    publisher: text('publisher'),
    publishedAt: ts('published_at'),
    retrievedAt: ts('retrieved_at').notNull().defaultNow(),
    /** Excerpts or structured evidence kept as data, never as instructions. */
    excerpts: jsonb('excerpts').notNull().default([]),
    /** Which article claims this source supports. */
    supportingClaims: jsonb('supporting_claims').notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('blog_article_sources_article_url_uq').on(t.articleId, t.url)],
);

export const articleAssets = pgTable(
  'blog_article_assets',
  {
    id: id(),
    articleId: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('featured_image'),
    storageKey: text('storage_key'),
    url: text('url'),
    cmsMediaId: text('cms_media_id'),
    altText: text('alt_text'),
    width: integer('width'),
    height: integer('height'),
    mimeType: text('mime_type'),
    generationMeta: jsonb('generation_meta').notNull().default({}),
    /** Image status is tracked apart from the article's own status. */
    status: text('status').notNull().default('pending'),
    error: jsonb('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('blog_article_assets_status_chk', inList('status', ASSET_STATUSES)), index('blog_article_assets_article_idx').on(t.articleId)],
);

export const publishedPosts = pgTable(
  'blog_published_posts',
  {
    id: id(),
    articleId: uuid('article_id').notNull().references(() => articles.id),
    adapter: text('adapter').notNull(),
    /** True when the adapter was a mock. A mock post is never shown as a real publication. */
    isMock: boolean('is_mock').notNull().default(false),
    cmsPostId: text('cms_post_id'),
    publicUrl: text('public_url'),
    status: text('status').notNull().default('scheduled'),
    priority: integer('priority').notNull().default(0),
    scheduledFor: ts('scheduled_for'),
    publishedAt: ts('published_at'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: ts('next_attempt_at'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    lastError: jsonb('last_error'),
    syncDetails: jsonb('sync_details').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('blog_published_posts_status_chk', inList('status', POST_STATUSES)),
    // One non-cancelled post per article stops a retry from creating a second post.
    uniqueIndex('blog_published_posts_one_live_per_article')
      .on(t.articleId)
      .where(sql`status in ('scheduled', 'publishing', 'published', 'delayed')`),
    index('blog_published_posts_due_idx').on(t.status, t.scheduledFor),
  ],
);

export const analyticsSnapshots = pgTable(
  'blog_analytics_snapshots',
  {
    id: id(),
    articleId: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    source: text('source').notNull(),
    // Nullable on purpose: unavailable is not zero.
    impressions: integer('impressions'),
    clicks: integer('clicks'),
    ctr: numeric('ctr', { precision: 8, scale: 6 }),
    avgPosition: numeric('avg_position', { precision: 8, scale: 2 }),
    sessions: integer('sessions'),
    engagedSessions: integer('engaged_sessions'),
    engagementSeconds: integer('engagement_seconds'),
    returningVisitors: integer('returning_visitors'),
    extra: jsonb('extra').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('blog_analytics_snapshots_uq').on(t.articleId, t.date, t.source)],
);

export const auditLogs = pgTable(
  'blog_audit_logs',
  {
    id: id(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    details: jsonb('details').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('blog_audit_logs_entity_idx').on(t.entityType, t.entityId), index('blog_audit_logs_created_idx').on(t.createdAt)],
);

/** Scoring weights, publishing queue rules, timezone, budgets. One row per setting key. */
export const appSettings = pgTable('blog_app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

/** Per-job provider usage. Cost is an estimate unless the provider reports it. */
export const usageEvents = pgTable(
  'blog_usage_events',
  {
    id: id(),
    jobId: uuid('job_id').references(() => contentJobs.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model'),
    operation: text('operation').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    requests: integer('requests').notNull().default(1),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 }),
    costBasis: text('cost_basis').notNull().default('unknown'),
    createdAt: createdAt(),
  },
  (t) => [index('blog_usage_events_created_idx').on(t.createdAt), index('blog_usage_events_job_idx').on(t.jobId)],
);

/** Featured images, kept here (the blog's own tables) and served to signed-in Blogs users only; the CMS gets the bytes when publishing. */
export const imageStore = pgTable('blog_image_store', {
  key: text('key').primaryKey(),
  bytes: bytea('bytes').notNull(),
  mimeType: text('mime_type').notNull(),
  createdAt: createdAt(),
});
