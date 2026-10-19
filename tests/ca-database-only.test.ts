import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, sheetFirms, tasks, users } from '@/lib/db/schema';
import { KnownBranches } from '@/lib/branches';
import { importContactSheet } from '@/lib/contact-import';
import { approveSheetLeadsOnce } from '@/lib/ca-sheet';
import { reconcileContactStatus } from '@/lib/contact-status';
import { ensureSequences, isFirstContact, loadTodayTasks, istDay } from '@/lib/tasks';
import { tidyContacts, verifyContacts } from '@/lib/verify-contacts';

let db: Db;
let owner: number;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  owner = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const firm = { company: 'Mehta & Co', website: '', city: 'Pune', phones: ['9822012345'], emails: [], people: [], remark: 'Services: audit' };
const importFirm = async (status?: 'Approved') => {
  const r = await importContactSheet(db, [firm], { segment: 'CA Firms', ownerId: owner, known: new KnownBranches([], []), by: 'the Google Sheet', ...(status ? { status } : {}) });
  return r.ids[0];
};

describe('CA firms from the database', () => {
  it('start Approved with only what the sheet had: nothing is invented for a blank field', async () => {
    const id = await importFirm('Approved');
    const [l] = await db.select().from(leads).where(eq(leads.id, id));
    expect(l).toMatchObject({ status: 'Approved', contactName: '', contactTitle: '', contactEmail: '', contactLinkedin: '', contactPhone: '9822012345', city: 'Pune' });
  });

  it('show on Today as fresh leads (a LinkedIn request first) even with no person named, and stay Approved', async () => {
    const id = await importFirm('Approved');
    await ensureSequences(db, istDay());
    await db.update(tasks).set({ dueDate: istDay() }).where(eq(tasks.leadId, id));
    const items = await loadTodayTasks(db, owner, istDay());
    expect(items.map((i) => [i.lead.id, i.task.kind, i.task.step])).toEqual([[id, 'linkedin', 'Day 1']]);
    expect(items.every((i) => isFirstContact(i.task))).toBe(true);
    // A contact change never sends it back to waiting for a person, and no find-a-contact step appears.
    expect(await reconcileContactStatus(db, id)).toBeNull();
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('Approved');
    expect((await db.select().from(tasks).where(eq(tasks.leadId, id))).some((t) => t.step === 'Find the next person')).toBe(false);
  });

  it('are never looked up or tidied: no contact search runs for them', async () => {
    const id = await importFirm('Approved');
    const searched: string[] = [];
    const svc = { fetch: (async (url: string, init?: RequestInit) => { searched.push(String(init?.body ?? url)); return new Response(JSON.stringify({ organic: [] }), { status: 200 }); }) as typeof fetch, keys: { serper: 'k' }, settings: (await import('@/lib/settings')).settingsSchema.parse({}) } as never;
    await verifyContacts(db, svc, { limit: 50 });
    expect(searched.join(' ')).not.toContain('Mehta');
    expect(await tidyContacts(db, {})).not.toContain(id);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].contactCheckedAt).toBeNull();
  });

  it('firms taken before this rule are approved once, and only sheet firms', async () => {
    const id = await importFirm();
    const { settings } = await import('@/lib/db/schema');
    await db.delete(settings).where(eq(settings.key, 'caApprovedV1'));
    const [sheet] = [{ sourceKey: 'icai:1', company: 'Mehta & Co', ownerId: owner, leadId: id, assignedOn: istDay() }];
    await db.insert(sheetFirms).values(sheet);
    const manual = (await db.insert(leads).values({ company: 'Hand Added CA', segment: 'CA Firms', status: 'Awaiting Approval', ownerId: owner }).returning())[0];
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('New');
    await approveSheetLeadsOnce(db);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('Approved');
    expect((await db.select().from(leads).where(eq(leads.id, manual.id)))[0].status).toBe('Awaiting Approval');
    // Once only: a lead moved on later isn't pulled back to Approved.
    await db.update(leads).set({ status: 'Contacted' }).where(eq(leads.id, id));
    await approveSheetLeadsOnce(db);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('Contacted');
    expect(await db.select().from(tasks).where(and(eq(tasks.leadId, id), isNull(tasks.doneAt)))).toBeDefined();
  });
});
