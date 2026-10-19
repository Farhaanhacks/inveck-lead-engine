import { PageHeader } from '@/components/page-header';
import { marketingPage } from '@/lib/access';
import { listPeople, toPersonView } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';
import { PeopleManager } from './people-manager';

/** The people content can be assigned to. */
export default async function PeoplePage() {
  await marketingPage();
  const people = (await listPeople(await getDb())).map(toPersonView);
  return (
    <>
      <PageHeader title="People" description="Who content can be assigned to. They appear in the content form's Assigned to list." />
      <PeopleManager initial={people} />
    </>
  );
}
