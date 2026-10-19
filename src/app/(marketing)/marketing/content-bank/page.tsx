import { PageHeader } from '@/components/page-header';
import { marketingPage } from '@/lib/access';
import { listPeople, listPosts, toPersonView, toView } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';
import { ContentBank } from './content-bank';

/** Every content piece in one list: review it, open its Drive link, see who it is assigned to. */
export default async function ContentBankPage() {
  await marketingPage();
  const db = await getDb();
  const [posts, people] = await Promise.all([listPosts(db), listPeople(db)]);
  return (
    <>
      <PageHeader title="Content Bank" description="All content in one place, with its draft, status, date, owner and Drive link." />
      <ContentBank posts={posts.map(toView)} people={people.map(toPersonView)} />
    </>
  );
}
