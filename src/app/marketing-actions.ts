'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireMarketing } from '@/lib/access';
import { createPost, deletePost, toView, updatePost, type PostInput, type PostView } from '@/lib/content-calendar';

/** Every call here is checked on the server: only the Marketing profile (or an administrator) can use them, whatever page sent it. */
export type PostResult = { ok: true; post: PostView } | { ok: false; error: string };

function refresh() {
  revalidatePath('/marketing/calendar');
  revalidatePath('/marketing/overview');
}

export async function createPostAction(input: Partial<Record<keyof PostInput, unknown>>): Promise<PostResult> {
  await requireMarketing();
  const r = await createPost(await getDb(), input ?? {});
  if (!r.ok) return r;
  refresh();
  return { ok: true, post: toView(r.post) };
}

/** Saves the editor, or one change (a status, a new date): what isn't sent is kept as it was. */
export async function updatePostAction(id: number, patch: Partial<Record<keyof PostInput, unknown>>): Promise<PostResult> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false, error: 'Unknown post.' };
  const r = await updatePost(await getDb(), id, patch ?? {});
  if (!r.ok) return r;
  refresh();
  return { ok: true, post: toView(r.post) };
}

/** Dragging a post to a date (or back to the drafts with an empty date). */
export async function movePostAction(id: number, date: string): Promise<PostResult> {
  return updatePostAction(id, { scheduledOn: typeof date === 'string' ? date : '' });
}

export async function deletePostAction(id: number): Promise<{ ok: boolean }> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false };
  await deletePost(await getDb(), id);
  refresh();
  return { ok: true };
}
