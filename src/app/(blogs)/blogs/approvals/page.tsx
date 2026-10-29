import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { AutoRefresh } from '@/components/blogs/auto-refresh';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Badge, EmptyState, Notice, PageHeader, StageSteps, StateLine } from '@/components/blogs/ui';
import { jobState } from '@/lib/blogs/status';
import { getDb } from '@/lib/blogs/db/client';
import { contentJobs, domainProfiles, topicCandidates } from '@/lib/blogs/db/schema';
import { DIMENSION_LABELS, DIMENSIONS, type Dimension } from '@/lib/blogs/discovery/scoring';
import type { Match } from '@/lib/blogs/discovery/dedup';
import type { SourceRef } from '@/lib/blogs/discovery/engine';
import { getSetting } from '@/lib/blogs/settings';
import { formatInZone } from '@/lib/blogs/time';
import { approve, reject } from './actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Scores = Record<string, Dimension> & { explanation?: string; trendEvidence?: string };

const CONF_TONE = { high: 'ok', medium: 'warn', low: 'danger' } as const;

export default async function ApprovalsPage({ searchParams }: PageProps<'/blogs/approvals'>) {
  const { saved, error, job: newJobId } = await searchParams;
  const db = await getDb();
  const { timezone } = await getSetting('queue');
  const [pending, decided] = await Promise.all([
    db
      .select({ t: topicCandidates, domain: domainProfiles.name })
      .from(topicCandidates)
      .innerJoin(domainProfiles, eq(domainProfiles.id, topicCandidates.domainId))
      .where(eq(topicCandidates.status, 'pending'))
      .orderBy(desc(topicCandidates.opportunityScore), desc(topicCandidates.createdAt))
      .limit(50),
    db
      .select({ t: topicCandidates, job: contentJobs })
      .from(topicCandidates)
      .leftJoin(contentJobs, eq(contentJobs.topicId, topicCandidates.id))
      .where(inArray(topicCandidates.status, ['approved', 'generating']))
      .orderBy(desc(topicCandidates.updatedAt))
      .limit(10),
  ]);
  const now = new Date();
  const active = decided.some((d) => d.job && jobState(d.job, now).active);

  return (
    <>
      <PageHeader title="Topic Approvals" description="Approving a topic starts one article job." />
      <div className="space-y-6">
        {saved ? (
          <Notice tone="ok" title={String(saved)}>
            {typeof newJobId === 'string' && /^[0-9a-f-]{36}$/i.test(newJobId) ? <Link href={`/studio#job-${newJobId}`}>Track it in Article Studio</Link> : null}
          </Notice>
        ) : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}

        {pending.length ? (
          <ul className="space-y-4">
            {pending.map(({ t }) => {
              const scores = t.scores as Scores;
              const sources = t.sources as SourceRef[];
              const matches = ((t.similarity as { matches?: Match[] }).matches ?? []).filter((m) => m.overridden);
              const risks = t.risks as string[];
              const alts = t.altHeadlines as string[];
              const secondary = t.secondaryKeywords as string[];
              const questions = t.relatedQuestions as string[];
              return (
                <li key={t.id} className="card p-5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {t.category ? <span>{t.category}</span> : null}
                    <span>· {t.searchIntent}</span>
                    <span>· {t.articleFormat}</span>
                    <span className="ml-auto">Generated {formatInZone(t.createdAt, timezone)}</span>
                  </div>
                  <h2 className="mt-2 text-lg font-semibold tracking-tight">{t.headline}</h2>
                  {alts.length ? <ul className="mt-1 list-disc pl-5 text-sm text-muted">{alts.map((a) => <li key={a}>{a}</li>)}</ul> : null}
                  <p className="mt-3 text-sm">{t.summary}</p>

                  <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                    <div><dt className="text-xs text-muted">Primary keyword</dt><dd className="font-medium">{t.primaryKeyword}</dd>
                      {secondary.length ? <dd className="text-xs text-muted">{secondary.join(' · ')}</dd> : null}</div>
                    <div><dt className="text-xs text-muted">Target audience</dt><dd>{t.targetAudience}</dd></div>
                    <div><dt className="text-xs text-muted">Why now</dt><dd>{t.rationale}</dd></div>
                    <div><dt className="text-xs text-muted">Content gap</dt><dd>{t.contentGap}</dd></div>
                  </dl>
                  {questions.length ? <p className="mt-3 text-xs text-muted">Related questions: {questions.join(' · ')}</p> : null}

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <div><span className="text-xs text-muted">Opportunity score </span><span className="text-xl font-semibold tabular-nums">{t.opportunityScore === null ? 'Not scored' : Number(t.opportunityScore).toFixed(0)}</span></div>
                    {t.confidence ? <Badge tone={CONF_TONE[t.confidence as keyof typeof CONF_TONE]}>{t.confidence} confidence</Badge> : null}
                    <span className="text-xs text-muted">Prioritisation heuristic, not a forecast.</span>
                  </div>

                  {risks.length ? (
                    <div className="mt-3 rounded-lg border border-warn/35 bg-warn-soft px-3 py-2 text-sm">
                      <p className="font-medium">Risks to check</p>
                      <ul className="list-disc pl-5 text-muted">{risks.map((r) => <li key={r}>{r}</li>)}</ul>
                    </div>
                  ) : null}
                  {matches.length ? (
                    <p className="mt-3 text-xs text-muted">Resembles older content ({matches.map((m) => m.headline).join('; ')}) but rests on newer reporting, so it was allowed.</p>
                  ) : null}

                  <div className="mt-4 grid gap-2 md:grid-cols-2">
                    <details className="rounded-md border border-border px-3 py-2 text-sm">
                      <summary className="cursor-pointer font-medium">Sources ({sources.length})</summary>
                      <ul className="mt-2 space-y-2">
                        {sources.map((s) => (
                          <li key={s.url}>
                            <a className="underline underline-offset-2" href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
                            <p className="text-xs text-muted">{s.publisher ?? 'unknown publisher'} · {s.publishedAt ? new Date(s.publishedAt).toISOString().slice(0, 10) : 'date unknown'}</p>
                            {s.excerpt ? <p className="mt-0.5 text-xs text-muted">“{s.excerpt.slice(0, 220)}”</p> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <details className="rounded-md border border-border px-3 py-2 text-sm">
                      <summary className="cursor-pointer font-medium">Scoring explanation</summary>
                      <ul className="mt-2 space-y-2">
                        {DIMENSIONS.map((k) => {
                          const d = scores[k];
                          if (!d) return null;
                          return (
                            <li key={k}>
                              <span className="font-medium">{DIMENSION_LABELS[k]}:</span>{' '}
                              {d.score === null ? <span className="text-muted">unavailable</span> : <span className="tabular-nums">{d.score}</span>}{' '}
                              <Badge tone={d.basis === 'actual' ? 'ok' : d.basis === 'estimated' ? 'warn' : 'neutral'}>{d.basis}</Badge>
                              <p className="text-xs text-muted">{d.note}</p>
                            </li>
                          );
                        })}
                      </ul>
                      {scores.explanation ? <p className="mt-2 text-xs text-muted">{scores.explanation}</p> : null}
                      {scores.trendEvidence ? <p className="mt-1 text-xs text-muted">Trend evidence cited: {scores.trendEvidence}</p> : null}
                    </details>
                  </div>

                  <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
                    <form action={approve.bind(null, t.id)} className="flex items-end gap-2">
                      <label className="sr-only" htmlFor={`c-${t.id}`}>Comment</label>
                      <input id={`c-${t.id}`} name="comment" className="field w-48" placeholder="Optional comment" maxLength={300} />
                      <SubmitButton primary pendingLabel="Approving…">Approve</SubmitButton>
                    </form>
                    <form action={reject.bind(null, t.id)}><SubmitButton pendingLabel="Rejecting…">Reject</SubmitButton></form>
                    <Link href={`/blogs/approvals/${t.id}/edit`} className="btn">Edit</Link>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No topics awaiting approval">Run Topic Discovery to get new recommendations.</EmptyState>
        )}

        {decided.length ? (
          <section aria-labelledby="inflight">
            <div className="mb-2 flex items-center justify-between"><h2 id="inflight" className="section-title !mb-0">Approved topics</h2><AutoRefresh active={active} /></div>
            <ul className="card divide-y divide-border text-sm">
              {decided.map(({ t, job }) => (
                <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 space-y-1.5">
                    <p className="font-medium">{t.headline}</p>
                    {job ? <StageSteps stage={job.stage} tone={jobState(job, now).tone} /> : null}
                  </div>
                  {job ? (
                    <div className="flex flex-col items-end gap-1 text-right">
                      <StateLine state={jobState(job, now)} />
                      <Link href={job.articleId ? `/blogs/studio/${job.articleId}` : `/studio#job-${job.id}`} className="text-xs">Open in Article Studio</Link>
                    </div>
                  ) : <Badge>no job</Badge>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
