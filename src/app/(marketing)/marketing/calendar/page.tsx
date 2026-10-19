import { marketingPage } from '@/lib/access';
import { listPeople, listPosts, listTodos, toPersonView, toTodoView, toView } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';
import { istDay } from '@/lib/tasks';
import { CalendarBoard } from './calendar-board';

export default async function ContentCalendarPage() {
  await marketingPage();
  const db = await getDb();
  const [posts, people, todos] = await Promise.all([listPosts(db), listPeople(db), listTodos(db)]);
  return <CalendarBoard initialPosts={posts.map(toView)} people={people.map(toPersonView)} initialTodos={todos.map(toTodoView)} today={istDay()} />;
}
