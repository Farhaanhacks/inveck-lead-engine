import { redirect } from 'next/navigation';
import { adminPage } from '@/lib/access';

/** Research activity now lives on the dashboard; old links still work. */
export default async function RunsPage({ searchParams }: PageProps<'/runs'>) {
  await adminPage();
  const id = Number((await searchParams).id);
  redirect(id ? `/?run=${id}#activity` : '/#activity');
}
