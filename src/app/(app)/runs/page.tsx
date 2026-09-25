import { redirect } from 'next/navigation';

/** Research activity now lives on the dashboard; old links still work. */
export default async function RunsPage({ searchParams }: PageProps<'/runs'>) {
  const id = Number((await searchParams).id);
  redirect(id ? `/?run=${id}#activity` : '/#activity');
}
