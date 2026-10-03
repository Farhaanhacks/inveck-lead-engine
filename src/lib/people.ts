import { and, eq, ne } from 'drizzle-orm';
import type { Db } from './db';
import { leads, people, type NewPerson } from './db/schema';
import { logActivity } from './activity';

/** Replaces what research found at a lead's company; people the sales team added stay. */
export async function savePeople(db: Db, leadId: number, found: Omit<NewPerson, 'leadId'>[]): Promise<void> {
  await db.delete(people).where(and(eq(people.leadId, leadId), ne(people.source, 'Added by the team')));
  if (found.length) await db.insert(people).values(found.map((p) => ({ ...p, leadId })));
}

/** Makes someone at the company the lead's main contact. */
export async function makePrimary(db: Db, personId: number, opts: { byTeam?: boolean } = {}): Promise<number | null> {
  const [p] = await db.select().from(people).where(eq(people.id, personId));
  if (!p) return null;
  await db.update(people).set({ isPrimary: false }).where(eq(people.leadId, p.leadId));
  await db.update(people).set({ isPrimary: true }).where(eq(people.id, p.id));
  await db
    .update(leads)
    .set({
      contactName: p.name,
      contactTitle: p.title,
      contactEmail: p.email,
      contactPhone: p.phone,
      contactLinkedin: p.linkedin,
      emailStatus: p.emailStatus,
      // Someone new: checked on LinkedIn again.
      contactCheckedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, p.leadId));
  await logActivity(db, p.leadId, 'contact', `Main contact changed to ${[p.name, p.title].filter(Boolean).join(', ')}${opts.byTeam ? ' (chosen by the team)' : ''}`);
  return p.leadId;
}
