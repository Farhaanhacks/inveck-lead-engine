import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { getDb, type Db } from './db';
import { users, type User } from './db/schema';
import { authDisabled, readSession, SESSION_COOKIE } from './auth';
import { checkPassword, normaliseUsername } from './passwords';

export { BDA_NAMES, checkPassword, DEFAULT_PASSWORD, hashPassword, MIN_PASSWORD_LENGTH, normaliseUsername } from './passwords';

export async function verifyLogin(db: Db, username: string, password: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(and(eq(users.username, normaliseUsername(username)), eq(users.active, true)));
  // Check a hash even for unknown names, so the answer takes the same time.
  const ok = await checkPassword(password, user?.passwordHash ?? 'scrypt$00$00');
  return user && ok ? user : null;
}

export type SessionUser = { id: number; name: string; username: string; role: 'admin' | 'bda'; mustChangePassword: boolean };

/** The shared-password login (and local development without one): sees everything. */
export const ADMIN_USER: SessionUser = { id: 0, name: 'Admin', username: 'admin', role: 'admin', mustChangePassword: false };

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  if (authDisabled()) return ADMIN_USER;
  const subject = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!subject) return null;
  if (subject === 'admin') return ADMIN_USER;
  const id = Number(subject.slice(1));
  if (!Number.isInteger(id)) return null;
  const db = await getDb();
  const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.active, true)));
  return u ? { id: u.id, name: u.name, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword } : null;
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not logged in');
  return user;
}

export async function listBdas(db: Db) {
  return db.select({ id: users.id, name: users.name, username: users.username }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id);
}
