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
    // Saving plans from the real day, so look on the day the first call is due.
    const firstCall = open.filter((t) => t.kind === 'call').map((t) => t.dueDate).sort()[0];
    expect((await loadTodayTasks(db, owner, firstCall)).some((t) => t.lead.id === l.id && t.task.kind === 'call')).toBe(true);
  });

  it('a named contact not yet confirmed at the site: the step asks to confirm them, or find someone', async () => {
    await addLead({ status: 'Needs Manual Contact', contactName: 'Srihari K.R' });
    await ensureSequences(db, MONDAY);
    const [t] = await loadTodayTasks(db, owner, MONDAY);
    expect(t.task.title).toBe("Confirm Srihari K.R is at the Coimbatore site, or find the person to contact");
  });

  it('the "next steps" count is the companies Today will show that day: not deleted, rejected or set-aside leads', async () => {
    const shown = await addLead({ status: 'Awaiting Approval', contactName: 'A', contactLinkedin: 'https://in.linkedin.com/in/a' });
    const rejected = await addLead({ company: 'Gone Co', status: 'Awaiting Approval', contactName: 'B', contactLinkedin: 'https://in.linkedin.com/in/b' });
    const deleted = await addLead({ company: 'Deleted Co', status: 'Awaiting Approval', contactName: 'C', contactLinkedin: 'https://in.linkedin.com/in/c' });
    await ensureSequences(db, SUNDAY);
    await db.update(leads).set({ status: 'Rejected' }).where(eq(leads.id, rejected.id));
    // A lead deleted the old way, leaving its planned steps behind.
    await db.delete(leads).where(eq(leads.id, deleted.id));
    const monday = await loadTodayTasks(db, owner, MONDAY);
    expect(new Set(monday.map((t) => t.lead.id))).toEqual(new Set([shown.id]));
    expect(await nextDue(db, owner, SUNDAY)).toEqual({ day: MONDAY, companies: 1 });
  });
});

describe('calling again after no answer: the day split at 2 pm IST', () => {
  it('before 2 pm: again at 5 pm today; from 2 pm: again at 9 am the next working day', async () => {
    const { callAgainAt } = await import('@/lib/tasks');
    // Monday 5 Oct 2026, India time.
    expect(callAgainAt(new Date('2026-10-05T10:00:00+05:30'))).toEqual({ day: '2026-10-05', slot: 'evening' });
    expect(callAgainAt(new Date('2026-10-05T13:59:00+05:30'))).toEqual({ day: '2026-10-05', slot: 'evening' });
    expect(callAgainAt(new Date('2026-10-05T18:00:00+05:30'))).toEqual({ day: '2026-10-06', slot: 'morning' });
    // Friday evening: Monday morning.
    expect(callAgainAt(new Date('2026-10-09T18:00:00+05:30'))).toEqual({ day: '2026-10-12', slot: 'morning' });
    // A Saturday: Monday morning.
    expect(callAgainAt(new Date('2026-10-10T10:00:00+05:30'))).toEqual({ day: '2026-10-12', slot: 'morning' });
  });

  it('a 5 pm call shows on Today from 5 pm (listed as later today before that); a 9 am call from 9 am', async () => {
    const { laterToday } = await import('@/lib/tasks');
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'A', contactLinkedin: 'https://in.linkedin.com/in/a' });
    await db.insert(tasks).values([
      { leadId: l.id, ownerId: owner, kind: 'call', step: 'Call again', title: 'Call again at 5 pm', dueDate: MONDAY, slot: 'evening' },
    ]);
    const at = (h: string) => new Date(`${MONDAY}T${h}:00+05:30`);
    expect((await loadTodayTasks(db, owner, MONDAY, at('10:00'))).length).toBe(0);
    expect((await laterToday(db, owner, MONDAY, at('10:00'))).map((t) => t.lead.id)).toEqual([l.id]);
    expect((await loadTodayTasks(db, owner, MONDAY, at('17:05'))).length).toBe(1);
    expect(await laterToday(db, owner, MONDAY, at('17:05'))).toEqual([]);
    await db.update(tasks).set({ slot: 'morning', title: 'Call again at 9 am' }).where(eq(tasks.leadId, l.id));
    expect((await loadTodayTasks(db, owner, MONDAY, at('08:30'))).length).toBe(0);
    expect((await loadTodayTasks(db, owner, MONDAY, at('09:00'))).length).toBe(1);
  });
});
