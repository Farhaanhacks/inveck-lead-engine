'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireMarketing } from '@/lib/access';
import { addPerson, addTodo, completeTodo, createPost, deletePost, deleteTodo, moveTodo, removePerson, renamePerson, toPersonView, toTodoView, toView, updatePost, type PostInput, type PostView } from '@/lib/content-calendar';
import type { PersonView, TodoView } from '@/lib/content-meta';

/** Every call here is checked on the server: only the Marketing profile (or an administrator) can use them, whatever page sent it. */
export type PostResult = { ok: true; post: PostView } | { ok: false; error: string };

function refresh() {
  // The whole Marketing area: the reminder at the top of every page reads these too.
  revalidatePath('/marketing', 'layout');
}

const refreshAll = refresh;

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

// ─── People ───

export async function addPersonAction(name: string): Promise<{ ok: true; person: PersonView } | { ok: false; error: string }> {
  await requireMarketing();
  const r = await addPerson(await getDb(), name);
  if (!r.ok) return r;
  refreshAll();
  return { ok: true, person: toPersonView(r.person) };
}

export async function renamePersonAction(id: number, name: string): Promise<{ ok: true; person: PersonView } | { ok: false; error: string }> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false, error: 'Unknown person.' };
  const r = await renamePerson(await getDb(), id, name);
  if (!r.ok) return r;
  refreshAll();
  return { ok: true, person: toPersonView(r.person) };
}

/** Removes the person from the list; content assigned to them stays, unassigned. */
export async function removePersonAction(id: number): Promise<{ ok: boolean }> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false };
  await removePerson(await getDb(), id);
  refreshAll();
  return { ok: true };
}

// ─── To-dos ───

export type TodoResult = { ok: true; todo: TodoView } | { ok: false; error: string };

export async function addTodoAction(text: string): Promise<TodoResult> {
  await requireMarketing();
  const r = await addTodo(await getDb(), text);
  return r.ok ? { ok: true, todo: toTodoView(r.todo) } : r;
}

export async function moveTodoAction(id: number, date: string): Promise<TodoResult> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false, error: 'Unknown to-do.' };
  const r = await moveTodo(await getDb(), id, date);
  return r.ok ? { ok: true, todo: toTodoView(r.todo) } : r;
}

export async function completeTodoAction(id: number): Promise<{ ok: boolean }> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false };
  return { ok: await completeTodo(await getDb(), id) };
}

/** Deletes a to-do for good (a completed one, once it has been shown for a moment; or one removed by hand). */
export async function deleteTodoAction(id: number): Promise<{ ok: boolean }> {
  await requireMarketing();
  if (!Number.isInteger(id)) return { ok: false };
  await deleteTodo(await getDb(), id);
  return { ok: true };
}
