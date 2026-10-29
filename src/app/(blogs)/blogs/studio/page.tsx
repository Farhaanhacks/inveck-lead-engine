import { and, desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { AutoRefresh } from '@/components/blogs/auto-refresh';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Badge, EmptyState, Notice, PageHeader, StageSteps, StateLine, StatusBadge, Table } from '@/components/blogs/ui';
import { getDb } from '@/lib/blogs/db/client';
import { articleAssets, articles, contentJobs, topicCandidates } from '@/lib/blogs/db/schema';
import { getSetting } from '@/lib/blogs/settings';
import { jobState } from '@/lib/blogs/status';
import { formatInZone } from '@/lib/blogs/time';
import { cancel, recheck, retry, runNow } from './actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type JobError = { code?: string; message?: string; reviewOnly?: boolean; issues?: string[] };

export default async function StudioPage({ searchParams }: PageProps<'/blogs/studio'>) {
  const { saved, error } = await searchParams;
  const db = await getDb();
  const [{ timezone }, jobs, items, failedImages] = await Promise.all([
    getSetting('queue'),
    db
      .select({ j: contentJobs, headline: topicCandidates.headline })
      .from(contentJobs)
      .innerJoin(topicCandidates, eq(topicCandidates.id, contentJobs.topicId))
      .orderBy(desc(contentJobs.updatedAt))
      .limit(30),
    db.select().from(articles).where(inArray(articles.status, ['ready', 'blocked', 'draft', 'validating', 'failed'])).orderBy(desc(articles.updatedAt)).limit(50),
    db.select({ articleId: articleAssets.articleId }).from(articleAssets).where(and(eq(articleAssets.kind, 'featured_image'), eq(articleAssets.status, 'failed'))),
  ]);
  const now = new Date();
  const imageFailed = new Set(failedImages.map((r) => r.articleId));
  const withState = jobs.map(({ j, headline }) => ({ j, headline, st: jobState(j, now, { imageFailed: !!j.articleId && imageFailed.has(j.articleId) }) }));
  const active = withState.some((x) => x.st.active);
  const exceptions = withState.filter(({ j }) => ['blocked', 'failed'].includes(j.status));
  const fmt = (d?: Date) => (d ? formatInZone(d, timezone) : undefined);

  return (
    <>
      <PageHeader title="Article Studio" />
      <div className="space-y-6">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}

        {exceptions.length ? (
          <section aria-labelledby="exceptions">
            <h2 id="exceptions" className="section-title">Needs your attention ({exceptions.length})</h2>
            <ul className="space-y-3">
              {exceptions.map(({ j, headline, st }) => {
                const err = (j.error ?? {}) as JobError;
                return (
                  <li key={j.id} id={`job-${j.id}`} className="card p-4 text-sm">
                    <p className="font-medium">{headline}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3"><StageSteps stage={j.stage} tone={st.tone} /></div>
                    <div className="mt-2"><StateLine state={st} at={fmt(st.at)} /></div>
                    {err.issues?.length ? <ul className="mt-2 list-disc pl-5 text-xs text-muted">{err.issues.slice(0, 6).map((x) => <li key={x}>{x}</li>)}</ul> : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {j.articleId ? <Link href={`/blogs/studio/${j.articleId}`} className="btn-primary">{err.reviewOnly ? 'Review article' : 'Open article'}</Link> : null}
                      {err.code === 'validation_blocked' ? <form action={recheck.bind(null, j.id)}><SubmitButton pendingLabel="Starting check…">Re-check only</SubmitButton></form> : null}
                      <form action={retry.bind(null, j.id)}><SubmitButton pendingLabel="Queuing…">{err.code === 'validation_blocked' ? 'Rewrite and re-check' : 'Retry'}</SubmitButton></form>
                      <form action={cancel.bind(null, j.id)}><SubmitButton pendingLabel="Cancelling…">Cancel job</SubmitButton></form>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="jobs">
          <div className="mb-2 flex items-center justify-between"><h2 id="jobs" className="section-title !mb-0">Generation jobs</h2><AutoRefresh active={active} /></div>
          {withState.length ? (
            <Table head={['Topic', 'Step', 'State', 'Updated', '']}>
              {withState.map(({ j, headline, st }) => (
                <tr key={j.id} id={`job-${j.id}`} className="align-top">
                  <td className="px-4 py-3 font-medium">
                    {j.articleId ? <Link href={`/blogs/studio/${j.articleId}`}>{headline}</Link> : headline}
                  </td>
                  <td className="px-4 py-3"><StageSteps stage={j.stage} tone={st.tone} compact /></td>
                  <td className="max-w-sm px-4 py-3"><StateLine state={st} at={fmt(st.at)} /></td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{formatInZone(j.updatedAt, timezone)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {['queued', 'retrying'].includes(j.status) ? <form action={runNow.bind(null, j.id)}><SubmitButton primary pendingLabel="Starting…">Run now</SubmitButton></form> : null}
                      {['queued', 'running', 'retrying'].includes(j.status) ? <form action={cancel.bind(null, j.id)}><SubmitButton pendingLabel="Cancelling…">Cancel</SubmitButton></form> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No generation jobs">Approve a topic to start one.</EmptyState>
          )}
        </section>

        <section aria-labelledby="articles">
          <h2 id="articles" className="section-title">Articles</h2>
          {items.length ? (
            <Table head={['Title', 'Category', 'Status', 'Version', 'Updated']}>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-3 font-medium"><Link href={`/blogs/studio/${a.id}`}>{a.title}</Link></td>
                  <td className="px-4 py-3 text-muted">{a.category ?? '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                  <td className="px-4 py-3 text-muted"><Badge>v{a.version}</Badge></td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{formatInZone(a.updatedAt, timezone)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No articles yet" />
          )}
        </section>
      </div>
    </>
  );
}
