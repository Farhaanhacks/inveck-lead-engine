import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { users } from './db/schema';
import { hashPassword } from './passwords';
import { listProducts, setUserProducts } from './config';

/**
 * Team members created from Configuration are BDAs only (never an administrator or Marketing). The login is their email,
 * lowercased: an email already used by any user is refused, so nobody is made twice. The starting password is random,
 * shown once to the administrator and stored only hashed; the person must change it at first login.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const temporaryPassword = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export async function createBda(db: Db, input: { name: string; email: string; productIds: number[] }): Promise<{ ok: true; id: number; password: string } | { ok: false; error: string }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const email = input.email.trim().toLowerCase();
  if (!name) return { ok: false, error: 'Enter the BDA\'s name.' };
  if (name.length > 80) return { ok: false, error: 'The name is too long.' };
  if (!EMAIL.test(email)) return { ok: false, error: 'Enter a valid email address: it is their login.' };
  const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${email}`);
  if (taken) return { ok: false, error: `${email} already has a login. Nobody is created twice.` };
  const products = (await listProducts(db)).filter((p) => p.active && input.productIds.includes(p.id));
  if (!products.length) return { ok: false, error: 'Choose at least one product for this BDA.' };
  const password = temporaryPassword();
  const [row] = await db.insert(users).values({ username: email, name, role: 'bda', passwordHash: await hashPassword(password), mustChangePassword: true }).returning({ id: users.id });
  await setUserProducts(db, row.id, products.map((p) => p.id));
  return { ok: true, id: row.id, password };
}

/** Turns a BDA's login off or on (never an administrator or Marketing). Their leads and history stay as they are. */
export async function setBdaActive(db: Db, userId: number, active: boolean): Promise<boolean> {
  const rows = await db.update(users).set({ active }).where(sql`${users.id} = ${userId} and ${users.role} = 'bda'`).returning({ id: users.id });
  return rows.length > 0;
}

void eq;
