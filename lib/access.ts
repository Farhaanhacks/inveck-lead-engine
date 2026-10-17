import 'server-only';
import { redirect } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from './db';
import { leads } from './db/schema';
import { getCurrentUser, requireUser, type SessionUser } from './users';

/** For pages only administrators see. Team members are sent back to their own list. */
export async function adminPage(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/today');
  return user;
}

/** For server actions that only administrators may run. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'admin') throw new Error('Administrators only');
  return user;
}

/** The owner a person's lists are limited to: a team member sees only their own leads, an administrator sees all (null). */
export function ownerScope(user: Pick<SessionUser, 'id' | 'role'>): number | null {
  return user.role === 'admin' ? null : user.id;
}

/** Whether the logged-in person may look at and change this lead: administrators any, team members their own. */
export async function mayActOn(leadId: number): Promise<boolean> {
  const user = await requireUser();
  if (user.role === 'admin') return true;
  if (!leadId) return false;
  const rows = await getDb().then((db) => db.select({ id: leads.id }).from(leads).where(and(eq(leads.id, leadId), eq(leads.ownerId, user.id))));
  return rows.length > 0;
}

/** The part of a list of lead ids the logged-in person may act on. */
export async function ownedIds(ids: number[]): Promise<number[]> {
  const user = await requireUser();
  if (user.role === 'admin' || !ids.length) return ids;
  const db = await getDb();
  const rows = await db.select({ id: leads.id }).from(leads).where(and(inArray(leads.id, ids), eq(leads.ownerId, user.id)));
  return rows.map((r) => r.id);
}
