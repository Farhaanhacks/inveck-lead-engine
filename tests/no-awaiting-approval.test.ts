import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, LEAD_STATUSES, PIPELINE_STAGES } from '@/lib/db/schema';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { scoreLead } from '@/lib/pipeline/scoring';
import { EMPTY_CONTACT } from '@/lib/pipeline/contacts';

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

describe('Awaiting Approval is gone (20 Oct 2026)', () => {
  it('is no longer a status or a pipeline stage; a lead that passes the ICP check with a contact is Approved', () => {
    expect(LEAD_STATUSES as readonly string[]).not.toContain('Awaiting Approval');
    expect(PIPELINE_STAGES as readonly string[]).not.toContain('Awaiting Approval');
    expect(scoreLead(8, { ...EMPTY_CONTACT, name: 'Ravi Kumar', linkedin: 'https://in.linkedin.com/in/ravi-kumar' }, 'no email found').status).toBe('Approved');
  });

  it('leads still in it become Approved once, with a note on their timeline; nothing else moves', async () => {
    const [waiting] = await db.insert(leads).values({ company: 'Waiting Co', segment: 'Manufacturing', status: 'New' }).returning();
    const [contacted] = await db.insert(leads).values({ company: 'Talking Co', segment: 'Manufacturing', status: 'Contacted' }).returning();
    // As the database holds it from before: a status the app can no longer write.
    await db.execute(sql`UPDATE leads SET status = 'Awaiting Approval' WHERE id = ${waiting.id}`);
    const conversion = SCHEMA_STATEMENTS.filter((s) => s.includes("WHERE status = 'Awaiting Approval'"));
    expect(conversion).toHaveLength(2);
    for (let run = 0; run < 2; run++) for (const s of conversion) await db.execute(sql.raw(s));
    const status = async (id: number) => (await db.select({ s: leads.status }).from(leads).where(eq(leads.id, id)))[0].s;
    expect(await status(waiting.id)).toBe('Approved');
    expect(await status(contacted.id)).toBe('Contacted');
    // One note, however often startup runs it.
    const notes = await db.select().from(activities).where(eq(activities.leadId, waiting.id));
    expect(notes.map((n) => [n.kind, n.stage, n.text])).toEqual([['approved', 'Approved', 'Approved: Awaiting Approval was removed, so a company that passed the ICP check is Approved']]);
    expect(await db.select().from(activities).where(eq(activities.leadId, contacted.id))).toEqual([]);
  });
});

describe('Needs Review and Needs Manual Contact are gone too (20 Oct 2026)', () => {
  it('are no longer statuses', () => {
    expect(LEAD_STATUSES as readonly string[]).not.toContain('Needs Review');
    expect(LEAD_STATUSES as readonly string[]).not.toContain('Needs Manual Contact');
  });

  it('leads still in them move on once, with a note: unconfirmed fit Disqualified, no contact Deleted (restorable), a CA firm Approved', async () => {
    const { retireRemovedStatuses, NO_CONTACT_FOUND } = await import('@/lib/retired-statuses');
    const { restoreLead } = await import('@/lib/follow-up-sequence');
    const add = async (company: string, segment: string, status: string, extra: Record<string, unknown> = {}) => {
      const [l] = await db.insert(leads).values({ company, segment, status: 'New', ...extra }).returning();
      await db.execute(sql`UPDATE leads SET status = ${status} WHERE id = ${l.id}`);
      return l.id;
    };
    const review = await add('Unsure Co', 'Manufacturing', 'Needs Review', { fitStatus: 'review', fitDecision: 'Needs review: the website shows no plant' });
    const nobody = await add('Nobody Co', 'Manufacturing', 'Needs Manual Contact');
    const firm = await add('Mehta & Co', 'CA Firms', 'Needs Manual Contact');
    expect(await retireRemovedStatuses(db)).toEqual({ disqualified: 1, deleted: 1, approved: 1 });
    expect(await retireRemovedStatuses(db)).toEqual({ disqualified: 0, deleted: 0, approved: 0 });
    const get = async (id: number) => (await db.select().from(leads).where(eq(leads.id, id)))[0];
    expect(await get(review)).toMatchObject({ status: 'Disqualified', fitStatus: 'review', fitDecision: 'ICP fit not confirmed: the website shows no plant' });
    expect(await get(nobody)).toMatchObject({ status: 'Deleted', statusBeforeDelete: 'Approved', deletedReason: NO_CONTACT_FOUND });
    expect((await get(firm)).status).toBe('Approved');
    const notes = (await db.select().from(activities).where(eq(activities.leadId, review))).map((a) => a.text);
    expect(notes).toEqual(['Disqualified: Needs Review was removed. ICP fit not confirmed: the website shows no plant']);
    // Restored by a person: back to Approved, never to the removed status.
    await restoreLead(db, nobody, 'Admin');
    expect((await get(nobody)).status).toBe('Approved');
  });
});
