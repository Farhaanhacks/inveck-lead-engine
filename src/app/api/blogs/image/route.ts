import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/users';
import { getDb } from '@/lib/blogs/db/client';
import { imageStore } from '@/lib/blogs/db/schema';

export const dynamic = 'force-dynamic';

/** A featured image from the blog's own table, for Blogs users and administrators only (the proxy checks the session too). */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user || (user.role !== 'blogs' && user.role !== 'admin')) return Response.json({ error: 'Not allowed' }, { status: 403 });
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!/^articles\/[0-9a-f-]{36}\/[a-z0-9.-]+$/i.test(key)) return Response.json({ error: 'Not found' }, { status: 404 });
  const [row] = await (await getDb()).select().from(imageStore).where(eq(imageStore.key, key));
  if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
  return new Response(new Uint8Array(row.bytes), { headers: { 'content-type': row.mimeType, 'cache-control': 'private, max-age=3600' } });
}
