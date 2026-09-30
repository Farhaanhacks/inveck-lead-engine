import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { users } from './db/schema';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const DEFAULT_PASSWORD = 'inveck123';
export const BDA_NAMES = ['Parimal', 'Anuradha', 'Anchal', 'Puja'];
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** "Parimal@inveck", " parimal " and "PARIMAL@INVECK" are all parimal@inveck. */
export function normaliseUsername(input: string): string {
  const s = input.trim().toLowerCase();
  return s.includes('@') ? s : `${s}@inveck`;
}

/** The team, created once on a database that has no users yet. Everyone starts with the same password. */
export async function seedUsers(db: Db) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  if (n > 0) return;
  for (const name of BDA_NAMES) {
    await db.insert(users).values({ username: normaliseUsername(name), name, role: 'bda', passwordHash: await hashPassword(DEFAULT_PASSWORD), mustChangePassword: true });
  }
}

