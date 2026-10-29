import { desc, eq } from 'drizzle-orm';
import { AutoRefresh } from '@/components/blogs/auto-refresh';
import Link from 'next/link';
import { SubmitButton } from '@/components/blogs/submit-button';
import { EmptyState, Notice, PageHeader, StateLine, Table } from '@/components/blogs/ui';
import { runState } from '@/lib/blogs/status';
import { getDb } from '@/lib/blogs/db/client';
import { domainProfiles, topicRuns } from '@/lib/blogs/db/schema';
import { INVECK_SLUG, profileIsReady } from '@/lib/blogs/seed';
import { missingDiscoveryKeys } from '@/lib/blogs/discovery/live';
import { getSetting } from '@/lib/blogs/settings';
import { formatInZone } from '@/lib/blogs/time';
import { retryDiscovery, startDiscovery } from './actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type RunResult = { created?: number; domains?: { domain: string; created: number; sourcesFound: number; skipped: { headline: string; reason: string }[] }[]; errors?: { domain: string; message: string }[] };

export default async function TopicDiscoveryPage({ searchParams }: PageProps<'/blogs/topics'>) {
  const { saved, error } = await searchParams;
  const db = await getDb();
  const [[profile], runs, { timezone }] = await Promise.all([
    db.select().from(domainProfiles).where(eq(domainProfiles.slug, INVECK_SLUG)),
    db.select().from(topicRuns).orderBy(desc(topicRuns.createdAt)).limit(20),
    getSetting('queue'),
  ]);
  const missing = missingDiscoveryKeys();
  const ready = !!profile && profileIsReady(profile);
  const now = new Date();
  const busy = runs.some((r) => runState(r, now).active);

  return (
    <>
      <PageHeader title="Topic Discovery" description="Research topics for the Inveck blog, then approve the ones worth writing." />
      <div className="space-y-6">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}
        {!ready ? <Notice tone="warn" title="Set up the Inveck profile first">Topic discovery stays off until the blog profile says who the articles are for and in what tone. <Link href="/blogs/settings">Open Settings & Prompts</Link>.</Notice> : null}
        {missing.length ? <Notice tone="warn" title={`${missing.join(' and ')} not configured`}>Discovery needs both providers.</Notice> : null}

        <form action={startDiscovery} className="card grid gap-4 p-5 md:grid-cols-2" aria-label="Run topic discovery">
          <input type="hidden" name="domain" value={INVECK_SLUG} />
          <label className="flex flex-col gap-1 text-sm">Market / geography<input name="geography" className="field" defaultValue="Global" required /></label>
          <label className="flex flex-col gap-1 text-sm">Optional topic focus<input name="focus" className="field" placeholder="e.g. small-business AI tools" maxLength={200} /></label>
          <label className="flex flex-col gap-1 text-sm">Time window
            <select name="windowDays" className="field" defaultValue="7"><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
          </label>
          <label className="flex flex-col gap-1 text-sm">Total suggestions<input name="count" className="field" type="number" min={1} max={10} defaultValue={5} required /></label>
          <div className="md:col-span-2"><SubmitButton primary pendingLabel="Starting…" disabled={missing.length > 0 || !ready}>Run Topic Discovery</SubmitButton></div>
        </form>

        <section aria-labelledby="runs">
          <div className="mb-2 flex items-center justify-between"><h2 id="runs" className="section-title !mb-0">Runs</h2><AutoRefresh active={busy} /></div>
          {runs.length ? (
            <Table head={['Started', 'State', 'Details', '']}>
              {runs.map((r) => {
                const res = r.result as RunResult;
                const st = runState(r, now);
                const skipped = res.domains?.flatMap((d) => d.skipped) ?? [];
                return (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-3 whitespace-nowrap text-muted">{formatInZone(r.createdAt, timezone)}</td>
                    <td className="px-4 py-3"><StateLine state={st} /></td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {r.status === 'completed' && (res.created ?? 0) > 0 ? <Link href="/blogs/approvals">Review in Topic Approvals</Link> : null}
                      {skipped.length ? (
                        <details className="mt-1"><summary className="cursor-pointer">{skipped.length} skipped</summary>
                          <ul className="mt-1 list-disc pl-4">{skipped.slice(0, 12).map((s, i) => <li key={i}>{s.headline}: {s.reason}</li>)}</ul>
                        </details>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === 'failed' ? <form action={retryDiscovery.bind(null, r.id)}><SubmitButton pendingLabel="Retrying…">Retry</SubmitButton></form> : null}
                    </td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <EmptyState title="No discovery runs yet" />
          )}
        </section>
      </div>
    </>
  );
}
