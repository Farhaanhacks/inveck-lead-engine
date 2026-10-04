import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, tasks, users } from '@/lib/db/schema';
import { ensureSequences, FIND_NEXT_STEP, loadTodayTasks, nextDue } from '@/lib/tasks';
import { saveContactEdit } from '@/lib/contact-edit';

let db: Db;
let owner: number;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  owner = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const SUNDAY = '2026-10-04';
const MONDAY = '2026-10-05';
const addLead = async (values: Partial<typeof leads.$inferInsert>) =>
  (await db.insert(leads).values({ company: 'Unique Shell', city: 'Coimbatore', segment: 'Manufacturing', ownerId: owner, qualified: true, ...values }).returning())[0];

describe('leads go from the Leads list to Today on their own', () => {
  it('a lead ready for approval gets its first call, WhatsApp, email and LinkedIn steps on the next working day', async () => {
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'Ananda Kumar', contactTitle: 'Works Manager', contactLinkedin: 'https://in.linkedin.com/in/ananda' });
    await ensureSequences(db, SUNDAY);
    // A Sunday: nothing is due today, and the page says when the steps start.
    expect(await loadTodayTasks(db, owner, SUNDAY)).toEqual([]);
    expect(await nextDue(db, owner, SUNDAY)).toEqual({ day: MONDAY, companies: 1 });
    const monday = await loadTodayTasks(db, owner, MONDAY);
    expect(monday.map((t) => t.task.kind).sort()).toEqual(['call', 'email', 'linkedin', 'whatsapp']);
    expect(monday.every((t) => t.lead.id === l.id)).toBe(true);
  });

  it('a lead waiting for a contact is on Today too, with a step to find one; naming someone starts the sequence', async () => {
    const l = await addLead({ status: 'Needs Manual Contact' });
    await ensureSequences(db, SUNDAY);
    const monday = await loadTodayTasks(db, owner, MONDAY);
    expect(monday.map((t) => [t.lead.id, t.task.step, t.task.title])).toEqual([[l.id, FIND_NEXT_STEP, 'Find the person to contact (plant head, else a P2 process owner)']]);
    // Run again: no second find step.
    await ensureSequences(db, SUNDAY);
    expect((await db.select().from(tasks).where(eq(tasks.leadId, l.id))).length).toBe(1);

    // The team names someone: ready for approval, the find step closes and the sequence starts.
    await saveContactEdit(db, l.id, { contactName: 'Ravi K', contactTitle: 'Plant Head', contactPhone: '9876543210', contactEmail: '', contactLinkedin: '' });
    await ensureSequences(db, MONDAY);
    const open = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), isNull(tasks.doneAt)));
    expect(open.some((t) => t.step === FIND_NEXT_STEP)).toBe(false);
    expect(open.map((t) => t.kind)).toContain('call');
    expect((await loadTodayTasks(db, owner, MONDAY)).some((t) => t.lead.id === l.id && t.task.kind === 'call')).toBe(true);
  });

  it('a named contact not yet confirmed at the site: the step asks to confirm them, or find someone', async () => {
    await addLead({ status: 'Needs Manual Contact', contactName: 'Srihari K.R' });
    await ensureSequences(db, MONDAY);
    const [t] = await loadTodayTasks(db, owner, MONDAY);
    expect(t.task.title).toBe("Confirm Srihari K.R is at the Coimbatore site, or find the person to contact");
  });
});
