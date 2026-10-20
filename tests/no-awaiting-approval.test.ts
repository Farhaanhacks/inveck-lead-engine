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
