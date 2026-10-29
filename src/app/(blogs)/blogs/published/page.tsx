import { desc, eq } from 'drizzle-orm';
import { Badge, EmptyState, PageHeader, Table } from '@/components/blogs/ui';
import { getDb } from '@/lib/blogs/db/client';
import { articles, publishedPosts } from '@/lib/blogs/db/schema';
import { getSetting } from '@/lib/blogs/settings';
import { formatInZone } from '@/lib/blogs/time';

export const dynamic = 'force-dynamic';

export default async function PublishedPage() {
  const { timezone } = await getSetting('queue');
  const rows = await (await getDb())
    .select({ p: publishedPosts, title: articles.title, category: articles.category })
    .from(publishedPosts)
    .innerJoin(articles, eq(articles.id, publishedPosts.articleId))
    .where(eq(publishedPosts.status, 'published'))
    .orderBy(desc(publishedPosts.publishedAt))
    .limit(100);
  return (
    <>
      <PageHeader title="Published Articles" description="Confirmed publications. Mock posts are labelled." />
      {rows.length ? (
        <Table head={['Title', 'Category', 'Published', 'CMS ID', 'URL']}>
          {rows.map(({ p, title, category }) => (
            <tr key={p.id}>
              <td className="px-4 py-3 font-medium">{title} {p.isMock ? <Badge tone="warn">mock</Badge> : null}</td>
              <td className="px-4 py-3 text-muted">{category ?? '—'}</td>
              <td className="px-4 py-3 whitespace-nowrap">{formatInZone(p.publishedAt, timezone)}</td>
              <td className="px-4 py-3 text-muted">{p.cmsPostId ?? '—'}</td>
              <td className="px-4 py-3">{p.publicUrl && !p.isMock ? <a className="underline underline-offset-2" href={p.publicUrl} target="_blank" rel="noopener noreferrer">Open</a> : '—'}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <EmptyState title="No published articles yet">They appear here once the CMS confirms publication.</EmptyState>
      )}
    </>
  );
}
