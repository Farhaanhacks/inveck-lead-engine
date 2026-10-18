import { marketingPage } from '@/lib/access';
import { listPosts, toView } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';
import { istDay } from '@/lib/tasks';
import { CalendarBoard } from './calendar-board';

export default async function ContentCalendarPage() {
  await marketingPage();
  const posts = await listPosts(await getDb());
  return <CalendarBoard initialPosts={posts.map(toView)} today={istDay()} />;
}
