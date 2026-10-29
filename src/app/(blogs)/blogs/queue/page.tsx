import { asc, desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { AutoRefresh } from '@/components/blogs/auto-refresh';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Badge, EmptyState, Notice, PageHeader, StateLine, Table } from '@/components/blogs/ui';
import { postState } from '@/lib/blogs/status';
import { getCmsAdapter } from '@/lib/blogs/cms';
import { getDb } from '@/lib/blogs/db/client';
import { articles, publishedPosts } from '@/lib/blogs/db/schema';
import { getSetting } from '@/lib/blogs/settings';
import { formatInZone } from '@/lib/blogs/time';
import { cancelSchedule, retryPublish, runPublishNow } from '../publishing/actions';
import { saveQueueConfig } from '../settings/actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export default async function QueuePage({ searchParams }: PageProps<'/blogs/queue'>) {
  const { saved, error } = await searchParams;
  const q = await getSetting('queue');
  const adapter = getCmsAdapter();
  const rows = await (await getDb())
    .select({ p: publishedPosts, title: articles.title })
    .from(publishedPosts)
    .innerJoin(articles, eq(articles.id, publishedPosts.articleId))
    .where(inArray(publishedPosts.status, ['scheduled', 'publishing', 'delayed', 'failed']))
    .orderBy(desc(publishedPosts.priority), asc(publishedPosts.scheduledFor))
    .limit(100);
  const w = q.windows[0] ?? { start: '09:00', end: '21:00' };
  const here = '/blogs/queue';
  const now = new Date();
  const active = rows.some(({ p }) => postState(p, now).active);

  return (
    <>
      <PageHeader
        title="Publishing Queue"
        description="Queue rules and posts waiting to publish."
        actions={<form action={runPublishNow.bind(null, here)}><SubmitButton pendingLabel="Running…">Run publisher now</SubmitButton></form>}
      />
      <div className="space-y-6">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}
        {adapter.isMock ? <Notice tone="warn" title="Mock mode">Publishing is simulated. Posts are labelled mock and never count as published.</Notice> : null}

        <form action={saveQueueConfig} className="card grid gap-4 p-5 md:grid-cols-3" aria-label="Automatic queue rules">
          <label className="flex flex-col gap-1 text-sm">Timezone<input name="timezone" className="field" defaultValue={q.timezone} required /></label>
          <label className="flex flex-col gap-1 text-sm">Target articles per day<input name="targetPerDay" type="number" min={1} max={50} className="field" defaultValue={q.targetPerDay} required /></label>
          <label className="flex flex-col gap-1 text-sm">Hard daily limit<input name="maxPerDay" type="number" min={1} max={50} className="field" defaultValue={q.maxPerDay} required /></label>
          <label className="flex flex-col gap-1 text-sm">Window opens<input name="windowStart" type="time" className="field" defaultValue={w.start} required /></label>
          <label className="flex flex-col gap-1 text-sm">Window closes<input name="windowEnd" type="time" className="field" defaultValue={w.end} required /></label>
          <label className="flex flex-col gap-1 text-sm">Minimum minutes between posts<input name="minIntervalMinutes" type="number" min={1} className="field" defaultValue={q.minIntervalMinutes} required /></label>
          <label className="flex flex-col gap-1 text-sm">Max concurrent publishing jobs<input name="maxConcurrentJobs" type="number" min={1} max={10} className="field" defaultValue={q.maxConcurrentJobs} required /></label>
          <label className="flex items-center gap-2 text-sm md:col-span-2"><input name="autoSlotApproved" type="checkbox" defaultChecked={q.autoSlotApproved} /> New validated articles take the next free slot automatically</label>
          <div className="md:col-span-3"><SubmitButton primary pendingLabel="Saving…">Save queue rules</SubmitButton></div>
        </form>

        <section aria-labelledby="waiting">
          <div className="mb-2 flex items-center justify-between"><h2 id="waiting" className="section-title !mb-0">Waiting to publish</h2><AutoRefresh active={active} /></div>
          {rows.length ? (
            <Table head={['Scheduled for', 'Article', 'State', '']}>
              {rows.map(({ p, title }) => (
                <tr key={p.id} className="align-top">
                  <td className="px-4 py-3 whitespace-nowrap">{formatInZone(p.scheduledFor, q.timezone)}{p.priority ? <Badge>priority {p.priority}</Badge> : null}</td>
                  <td className="px-4 py-3 font-medium"><Link className="underline underline-offset-2" href={`/blogs/studio/${p.articleId}`}>{title}</Link>{p.isMock ? <> <Badge tone="warn">mock</Badge></> : null}</td>
                  <td className="max-w-sm px-4 py-3"><StateLine state={postState(p, now)} at={postState(p, now).at ? formatInZone(postState(p, now).at!, q.timezone) : undefined} /></td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {p.status === 'failed' ? <form action={retryPublish.bind(null, p.id, here)}><SubmitButton pendingLabel="Queuing…">Retry</SubmitButton></form> : null}
                      {['scheduled', 'delayed', 'failed'].includes(p.status) ? <form action={cancelSchedule.bind(null, p.id, here)}><SubmitButton pendingLabel="Cancelling…">Cancel</SubmitButton></form> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="The queue is empty">Schedule a ready article from Article Studio. Only articles that passed their checks and have an image can publish.</EmptyState>
          )}
        </section>
      </div>
    </>
  );
}
