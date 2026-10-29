import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Notice, PageHeader } from '@/components/blogs/ui';
import { getDb } from '@/lib/blogs/db/client';
import { topicCandidates } from '@/lib/blogs/db/schema';
import { edit } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function EditTopicPage({ params, searchParams }: PageProps<'/blogs/approvals/[id]/edit'>) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t] = await (await getDb()).select().from(topicCandidates).where(eq(topicCandidates.id, id)).limit(1);
  if (!t) notFound();
  const locked = t.status !== 'pending';
  const save = edit.bind(null, t.id);

  return (
    <>
      <PageHeader title="Edit topic" description="Editing is possible before approval. Changes are logged." actions={<Link href="/blogs/approvals" className="btn">Back</Link>} />
      <div className="space-y-4">
        {error ? <Notice tone="danger" title={String(error)} /> : null}
        {locked ? <Notice tone="warn" title={`This topic is ${t.status}, so its subject is locked.`}>Cancel its job to change the subject.</Notice> : null}
        <form action={save} className="card grid gap-4 p-5 md:grid-cols-2">
          <fieldset disabled={locked} className="contents">
            <label className="flex flex-col gap-1 text-sm md:col-span-2">Headline<input name="headline" className="field" defaultValue={t.headline} required minLength={15} maxLength={160} /></label>
            <label className="flex flex-col gap-1 text-sm md:col-span-2">Summary<textarea name="summary" rows={4} className="field" defaultValue={t.summary} required minLength={40} maxLength={700} /></label>
            <label className="flex flex-col gap-1 text-sm">Primary keyword<input name="primaryKeyword" className="field" defaultValue={t.primaryKeyword} required /></label>
            <label className="flex flex-col gap-1 text-sm">Category<input name="category" className="field" defaultValue={t.category ?? ''} required /></label>
            <label className="flex flex-col gap-1 text-sm">Search intent
              <select name="searchIntent" className="field" defaultValue={t.searchIntent ?? 'informational'}>
                {['informational', 'commercial', 'transactional', 'navigational'].map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">Article format<input name="articleFormat" className="field" defaultValue={t.articleFormat ?? ''} required /></label>
            <label className="flex flex-col gap-1 text-sm md:col-span-2">Target audience<input name="targetAudience" className="field" defaultValue={t.targetAudience ?? ''} required /></label>
            <label className="flex flex-col gap-1 text-sm md:col-span-2">Secondary keywords (one per line)
              <textarea name="secondaryKeywords" rows={3} className="field font-mono text-xs" defaultValue={(t.secondaryKeywords as string[]).join('\n')} />
            </label>
            <div className="md:col-span-2"><SubmitButton primary pendingLabel="Saving…">Save changes</SubmitButton></div>
          </fieldset>
        </form>
      </div>
    </>
  );
}
