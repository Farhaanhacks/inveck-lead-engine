import { and, desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/blogs/auto-refresh';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Badge, EmptyState, Notice, PageHeader, StageSteps, StateLine, StatusBadge } from '@/components/blogs/ui';
import { jobState, postState, stageLabel } from '@/lib/blogs/status';
import { getDb } from '@/lib/blogs/db/client';
import { articleAssets, articleRevisions, articleSources, articles, contentJobs, publishedPosts } from '@/lib/blogs/db/schema';
import { getCmsAdapter } from '@/lib/blogs/cms';
import type { Issue, ValidationReport } from '@/lib/blogs/pipeline/schemas';
import { getSetting } from '@/lib/blogs/settings';
import { formatInZone } from '@/lib/blogs/time';
import { release, retryImageAction, setAuthor } from '../actions';
import { authorBoxHtml, loadAuthors, resolveAuthor } from '@/lib/blogs/authors';
import { cancelSchedule, reschedule, retryPublish, schedule } from '../../publishing/actions';

export const dynamic = 'force-dynamic';

const TONE = { critical: 'danger', major: 'warn', minor: 'neutral' } as const;

export default async function ArticlePage({ params, searchParams }: PageProps<'/blogs/studio/[id]'>) {
  const { id } = await params;
  const { saved, error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const [a] = await db.select().from(articles).where(eq(articles.id, id));
  if (!a) notFound();
  const { timezone } = await getSetting('queue');
  const [sources, assets, revisions, [job], posts] = await Promise.all([
    db.select().from(articleSources).where(eq(articleSources.articleId, id)).orderBy(articleSources.createdAt),
    db.select().from(articleAssets).where(eq(articleAssets.articleId, id)),
    db.select({ version: articleRevisions.version, reason: articleRevisions.reason, createdAt: articleRevisions.createdAt }).from(articleRevisions).where(eq(articleRevisions.articleId, id)).orderBy(desc(articleRevisions.version)),
    db.select().from(contentJobs).where(and(eq(contentJobs.articleId, id))).orderBy(desc(contentJobs.createdAt)).limit(1),
    db.select().from(publishedPosts).where(eq(publishedPosts.articleId, id)).orderBy(desc(publishedPosts.createdAt)),
  ]);
  const post = posts[0];
  const authors = await loadAuthors(db);
  const author = resolveAuthor((a.metadata as { author?: unknown }).author, authors);
  const adapter = getCmsAdapter();
  const here = `/blogs/studio/${id}`;
  const report = a.validation as Partial<ValidationReport>;
  const issues: Issue[] = report.issues ?? [];
  const image = assets.find((x) => x.kind === 'featured_image');
  const jobErr = (job?.error ?? {}) as { code?: string; reviewOnly?: boolean };
  const canRelease = job?.status === 'blocked' && jobErr.code === 'validation_blocked' && jobErr.reviewOnly;
  const save = release.bind(null, a.id);
  const now = new Date();
  const jState = job ? jobState(job, now, { imageFailed: image?.status === 'failed' }) : null;
  const pState = post && post.status !== 'cancelled' ? postState(post, now) : null;
  const stageNotes = Object.entries(((job?.progress ?? {}) as { stages?: Record<string, { completedAt?: string; note?: string }> }).stages ?? {})
    .filter(([, v]) => v.completedAt)
    .sort((x, y) => (x[1].completedAt! < y[1].completedAt! ? -1 : 1));
  const fmt = (d?: Date) => (d ? formatInZone(d, timezone) : undefined);

  return (
    <>
      <PageHeader title={a.title} description={a.excerpt ?? undefined} actions={<Link href="/blogs/studio" className="btn">Back</Link>} />
      <div className="space-y-6">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={a.status} /> <Badge>v{a.version}</Badge>
          {a.category ? <span className="text-muted">{a.category}</span> : null}
          <span className="text-muted">/{a.slug}</span>
          <span className="ml-auto text-xs text-muted">Updated {formatInZone(a.updatedAt, timezone)}</span>
        </div>

        {job && jState ? (
          <section className="card p-4" aria-labelledby="generation">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="generation" className="section-title !mb-0">Generation</h2>
              <AutoRefresh active={jState.active || !!pState?.active} />
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <StageSteps stage={job.stage} tone={jState.tone} />
              <StateLine state={jState} at={fmt(jState.at)} />
            </div>
            {stageNotes.length ? (
              <ol className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-2">
                {stageNotes.map(([stage, v]) => (
                  <li key={stage}><span className="font-medium text-foreground">{stageLabel(stage)}</span>: {v.note ?? 'done'} · {formatInZone(v.completedAt!, timezone)}</li>
                ))}
              </ol>
            ) : null}
          </section>
        ) : null}

        {canRelease ? (
          <section className="card border-warn/50 p-4" aria-labelledby="review">
            <h2 id="review" className="text-sm font-semibold">Waiting for your review</h2>
            <p className="mt-1 text-sm text-muted">Read the article and the flags below, then release it. Your note is logged.</p>
            <form action={save} className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-sm">Review note<input name="comment" className="field" required minLength={5} maxLength={400} placeholder="What you checked" /></label>
              <SubmitButton primary pendingLabel="Releasing…">Release for publishing</SubmitButton>
            </form>
          </section>
        ) : null}


        {a.status === 'ready' || (post && ['scheduled', 'delayed', 'failed', 'publishing'].includes(post.status)) || post?.status === 'published' ? (
          <section className="card p-4" aria-labelledby="publishing">
            <h2 id="publishing" className="text-sm font-semibold">Publishing</h2>
            {adapter.isMock ? <p className="mt-1 text-xs text-warn">Mock mode: publishing is simulated locally. Nothing reaches the live site.</p> : null}
            {a.status === 'ready' && (!post || ['cancelled', 'failed'].includes(post.status)) ? (
              <form action={schedule.bind(null, a.id)} className="mt-3 grid gap-3 md:grid-cols-4">
                <fieldset className="md:col-span-4 flex flex-wrap gap-4 text-sm">
                  <legend className="sr-only">Publishing mode</legend>
                  <label className="flex items-center gap-2"><input type="radio" name="mode" value="queue" defaultChecked /> Next free slot in the automatic queue</label>
                  <label className="flex items-center gap-2"><input type="radio" name="mode" value="scheduled" /> At a specific time</label>
                  <label className="flex items-center gap-2"><input type="radio" name="mode" value="immediate" /> Publish now</label>
                </fieldset>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">Date and time ({timezone})<input name="at" type="datetime-local" className="field" /></label>
                <label className="flex flex-col gap-1 text-sm">Priority (higher goes first)<input name="priority" type="number" min={0} max={10} defaultValue={0} className="field" /></label>
                <div className="flex items-end"><SubmitButton primary pendingLabel="Scheduling…">Schedule</SubmitButton></div>
              </form>
            ) : null}
            {post && post.status !== 'cancelled' ? (
              <div className="mt-3 space-y-2 text-sm">
                {pState ? <StateLine state={pState} at={fmt(pState.at)} /> : null}
                <p className="text-xs text-muted">
                  {post.status === 'published'
                    ? <>{post.isMock ? 'Simulated' : 'Published'} {formatInZone(post.publishedAt, timezone)}{post.publicUrl && !post.isMock ? <> · <a href={post.publicUrl} target="_blank" rel="noopener noreferrer">Open on site</a> · CMS id {post.cmsPostId}</> : null}</>
                    : <>Scheduled for {formatInZone(post.scheduledFor, timezone)}{post.isMock ? ' · mock mode' : ''}</>}
                </p>
                {['scheduled', 'delayed'].includes(post.status) ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <form action={reschedule.bind(null, post.id, here)} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="mode" value="scheduled" />
                      <label className="flex flex-col gap-1 text-xs">New time ({timezone})<input name="at" type="datetime-local" className="field" required /></label>
                      <SubmitButton pendingLabel="Saving…">Reschedule</SubmitButton>
                    </form>
                    <form action={cancelSchedule.bind(null, post.id, here)}><SubmitButton pendingLabel="Cancelling…">Cancel schedule</SubmitButton></form>
                  </div>
                ) : null}
                {post.status === 'failed' ? <form action={retryPublish.bind(null, post.id, here)}><SubmitButton primary pendingLabel="Queuing…">Retry publishing</SubmitButton></form> : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="card flex flex-wrap items-end justify-between gap-3 p-4" aria-labelledby="author">
          <div>
            <h2 id="author" className="section-title !mb-1">Author</h2>
            {author ? (
              <p className="text-sm"><span className="font-medium">{author.name}</span> <span className="text-muted">· {author.designation}</span> · <a href={author.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a></p>
            ) : (
              <p className="text-sm text-muted">Not assigned yet. One is picked at random when it is published.</p>
            )}
          </div>
          <form action={setAuthor.bind(null, a.id)} className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">Change author
              <select name="authorId" className="field" defaultValue={author?.id ?? authors[0]?.id}>
                {authors.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.designation})</option>)}
              </select>
            </label>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </form>
        </section>

        <section aria-labelledby="checks">
          <h2 id="checks" className="section-title">Quality checks</h2>
          {report.stats ? (
            <p className="mb-2 text-xs text-muted">{report.stats.words} words (target about {report.stats.targetWords}) · {report.stats.citedSources} sources cited · {report.stats.claimsVerified}/{report.stats.claims} claims confirmed against source text · {report.round ?? 0} repair round(s)</p>
          ) : null}
          {issues.length ? (
            <div className="space-y-4">
              {([
                ['Blocking: must be fixed before this can publish', issues.filter((i) => i.severity !== 'minor' && !i.overridable)],
                ['Needs a person to review and release', issues.filter((i) => i.severity !== 'minor' && i.overridable)],
                ['Warnings: recorded, not blocking', issues.filter((i) => i.severity === 'minor')],
              ] as const).map(([title, list]) =>
                list.length ? (
                  <div key={title}>
                    <h3 className="mb-1 text-xs font-semibold text-muted">{title} ({list.length})</h3>
                    <ul className="card divide-y divide-border text-sm">
                      {list.map((i, n) => (
                        <li key={n} className="px-4 py-2">
                          <div className="flex flex-wrap items-start gap-2"><Badge tone={TONE[i.severity]}>{i.severity}</Badge><span className="font-mono text-xs text-muted">{i.code}</span><span>{i.message}</span></div>
                          {i.claim ? (
                            <p className="mt-1 text-xs text-muted">
                              {i.claim.risk === 'protected' ? 'Protected claim (figure, quotation or sensitive category)' : 'General statement'} · cited {i.claim.sourceIds.join(', ') || 'none'}
                              {i.claim.supportedBy?.length ? ` · supported by ${i.claim.supportedBy.join(', ')}` : ''}
                              {i.claim.quote ? <> · evidence: “{i.claim.quote.slice(0, 160)}”</> : null}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              {report.removed?.length ? (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-muted">Sentences the system removed ({report.removed.length})</h3>
                  <ul className="card divide-y divide-border text-sm">
                    {report.removed.map((r, n) => <li key={n} className="px-4 py-2"><span className="line-through decoration-danger/60">{r.sentence}</span></li>)}
                  </ul>
                  <p className="mt-1 text-xs text-muted">Not supported by the sources, so deleted rather than rewritten. The earlier text is in the revision history.</p>
                </div>
              ) : null}
            </div>
          ) : report.checkedAt ? (
            <Notice tone="ok" title="No issues found" />
          ) : (
            <EmptyState title="Not validated yet" />
          )}
        </section>

        <section aria-labelledby="image">
          <h2 id="image" className="section-title">Featured image</h2>
          {image?.url ? (
            // Plain <img>: the file is already optimised WebP in our own storage bucket.
            // eslint-disable-next-line @next/next/no-img-element
            <figure className="card overflow-hidden"><img src={image.url} alt={image.altText ?? ''} width={image.width ?? 1600} height={image.height ?? 900} className="h-auto w-full max-w-2xl" /><figcaption className="px-4 py-2 text-xs text-muted">Alt text: {image.altText}</figcaption></figure>
          ) : image?.status === 'failed' ? (
            <Notice tone="danger" title="Image generation failed">{(image.error as { message?: string } | null)?.message ?? 'No details recorded.'} The article is unaffected.
              <form action={retryImageAction.bind(null, a.id)} className="mt-2"><SubmitButton pendingLabel="Starting…">Retry image</SubmitButton></form>
            </Notice>
          ) : (
            <EmptyState title="No image yet">Created after the article passes its checks.</EmptyState>
          )}
        </section>

        <section aria-labelledby="preview">
          <h2 id="preview" className="section-title">Preview</h2>
          {a.bodyHtml ? (
            // Sanitised server-side by renderArticleHtml (allow-listed tags, http(s) links only).
            <article className="card prose-article max-w-3xl p-6 text-[15px] leading-7 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-3 [&_sup]:text-xs [&_table]:my-3 [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: a.bodyHtml + (author ? authorBoxHtml(author) : '') }} />
          ) : (
            <EmptyState title="No rendered article yet" />
          )}
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="sources">
            <h2 id="sources" className="section-title">Sources ({sources.length})</h2>
            <ul className="card divide-y divide-border text-sm">
              {sources.map((s) => (
                <li key={s.id} className="px-4 py-2"><a className="underline underline-offset-2" href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a><p className="text-xs text-muted">{s.publisher} · retrieved {formatInZone(s.retrievedAt, timezone)} · {(s.supportingClaims as string[]).length} claims</p></li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="revisions">
            <h2 id="revisions" className="section-title">Revision history</h2>
            <ul className="card divide-y divide-border text-sm">
              {revisions.map((r) => <li key={r.version} className="px-4 py-2"><Badge>v{r.version}</Badge> {r.reason} <span className="text-xs text-muted">· {formatInZone(r.createdAt, timezone)}</span></li>)}
              {!revisions.length ? <li className="px-4 py-2 text-muted">No revisions yet.</li> : null}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
