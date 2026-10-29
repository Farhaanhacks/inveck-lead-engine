import 'server-only';
import { requireBlogs } from '../access';

/** The signed-in Blogs user (or the administrator) as the audit trail and approvals record them: their Inveck id and username. */
export async function blogActor(): Promise<{ id: number; email: string; name: string }> {
  const user = await requireBlogs();
  return { id: user.id, email: user.username, name: user.name };
}
