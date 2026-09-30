import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from './db';
import { leads, settings, users } from './db/schema';

/**
 * Gives every lead without an owner to the team in turn: the first to Parimal, the next to
 * Anuradha, then Anchal, then Puja, and round again. Inbound and engine-found leads share the order.
 */
export async function assignUnowned(db: Db): Promise<number> {
  const team = await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'bda'), eq(users.active, true))).orderBy(users.id);
  if (!team.length) return 0;
  const waiting = await db.select({ id: leads.id }).from(leads).where(isNull(leads.ownerId)).orderBy(leads.id).limit(2000);
  if (!waiting.length) return 0;

  const [pointer] = await db.select().from(settings).where(eq(settings.key, 'rrNext'));
  let n = Number((pointer?.value as { n?: number } | undefined)?.n ?? 0) || 0;
  const byOwner = new Map<number, number[]>();
  for (const lead of waiting) {
    const owner = team[n % team.length].id;
    n++;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), lead.id]);
  }
  // Only leads still without an owner: a second call at the same moment can't take them back.
  for (const [owner, ids] of byOwner) await db.update(leads).set({ ownerId: owner }).where(and(inArray(leads.id, ids), isNull(leads.ownerId)));
  const value = { n: n % team.length };
  await db.insert(settings).values({ key: 'rrNext', value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return waiting.length;
}
