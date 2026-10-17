import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, people } from '@/lib/db/schema';
import { saveContactEdit } from '@/lib/contact-edit';
import { makePrimary } from '@/lib/people';
import { reconcileContactStatus } from '@/lib/contact-status';

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

const addLead = async (values: Partial<typeof leads.$inferInsert> = {}) =>
  (await db.insert(leads).values({ company: 'Hosur Gears', city: 'Hosur', segment: 'Manufacturing', status: 'Needs Manual Contact', ...values }).returning())[0];
const statusOf = async (id: number) => (await db.select().from(leads).where(eq(leads.id, id)))[0].status;
const edit = (o: Partial<{ contactName: string; contactTitle: string; contactPhone: string; contactEmail: string; contactLinkedin: string }>) => ({
  contactName: '',
  contactTitle: '',
  contactPhone: '',
  contactEmail: '',
  contactLinkedin: '',
  ...o,
});

describe('the status follows the contact after every change', () => {
  it('a contact with a LinkedIn typed in by the team makes a waiting lead ready for approval', async () => {
    const l = await addLead();
    await saveContactEdit(db, l.id, edit({ contactName: 'Karthik R', contactTitle: 'Plant Head', contactLinkedin: 'https://in.linkedin.com/in/karthik-r' }));
    expect(await statusOf(l.id)).toBe('Awaiting Approval');
  });

  it('the contact cleared: a lead ready for approval waits for a contact again', async () => {
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'Karthik R', contactLinkedin: 'https://in.linkedin.com/in/karthik-r' });
    await saveContactEdit(db, l.id, edit({}));
    expect(await statusOf(l.id)).toBe('Needs Manual Contact');
  });

  it('the team making someone the main contact makes the lead ready', async () => {
    const l = await addLead();
    const [p] = await db.insert(people).values({ leadId: l.id, name: 'Karthik R', title: 'Plant Head', linkedin: 'https://in.linkedin.com/in/karthik-r', source: 'LinkedIn', location: 'Chennai, Tamil Nadu, India' }).returning();
    await makePrimary(db, p.id, { byTeam: true });
    expect(await statusOf(l.id)).toBe('Awaiting Approval');
  });

  it('switched automatically to someone checked and placed at this site: ready', async () => {
    const l = await addLead();
    const [p] = await db.insert(people).values({ leadId: l.id, name: 'Karthik R', title: 'Plant Head', linkedin: 'https://in.linkedin.com/in/karthik-r', source: 'LinkedIn', location: 'Hosur, Tamil Nadu, India', checkedAt: new Date() }).returning();
    await makePrimary(db, p.id);
    expect(await statusOf(l.id)).toBe('Awaiting Approval');
  });

  it('someone checked at the company in another Indian city is still the contact: ready', async () => {
    const l = await addLead();
    const [p] = await db.insert(people).values({ leadId: l.id, name: 'Srihari K.R', title: 'CEO', linkedin: 'https://in.linkedin.com/in/srihari', source: 'LinkedIn', location: 'Chennai, Tamil Nadu, India', checkedAt: new Date() }).returning();
    await makePrimary(db, p.id);
    expect(await statusOf(l.id)).toBe('Awaiting Approval');
    // And with no way to reach them, nor does a name alone.
    const l2 = await addLead({ contactName: 'Nobody Reachable', contactVerifiedAt: new Date() });
    expect(await reconcileContactStatus(db, l2.id)).toBeNull();
  });

  it('never moves a lead already in outreach: Contacted, Replied, Meeting Booked and Won keep their stage', async () => {
    for (const status of ['Contacted', 'Replied', 'Meeting Booked', 'Won'] as const) {
      const l = await addLead({ status, contactName: 'Karthik R', contactLinkedin: 'https://in.linkedin.com/in/karthik-r', contactVerifiedAt: new Date() });
      await saveContactEdit(db, l.id, edit({ contactName: 'Someone New', contactTitle: 'Plant Head', contactLinkedin: 'https://in.linkedin.com/in/someone-new' }));
      expect(await statusOf(l.id)).toBe(status);
      await saveContactEdit(db, l.id, edit({}));
      expect(await statusOf(l.id)).toBe(status);
      const [p] = await db.insert(people).values({ leadId: l.id, name: 'Third Person', title: 'Plant Head', linkedin: 'https://in.linkedin.com/in/third', source: 'LinkedIn', location: 'Hosur', checkedAt: new Date() }).returning();
      await makePrimary(db, p.id, { byTeam: true });
      expect(await statusOf(l.id)).toBe(status);
    }
  });
});

describe('people INVECK does not contact are set aside, never deleted', () => {
  it('directors (not the MD), HR and people abroad are hidden; a main contact among them is replaced', async () => {
    const { purgeUnwanted } = await import('@/lib/verify-contacts');
    const l = await addLead({ status: 'Awaiting Approval', contactName: 'Morgan Grumley', contactTitle: 'Logistics Manager', contactLinkedin: 'https://www.linkedin.com/in/morgan' });
    await db.insert(people).values([
      { leadId: l.id, name: 'Morgan Grumley', title: 'Logistics Manager', linkedin: 'https://www.linkedin.com/in/morgan', location: 'Greater Sioux Falls Area', source: 'LinkedIn', isPrimary: true },
      { leadId: l.id, name: 'Manju Deepak', title: 'HR & Admin', linkedin: 'https://in.linkedin.com/in/manju', location: 'Pune', source: 'LinkedIn' },
      { leadId: l.id, name: 'Ravi Director', title: 'Executive Director', linkedin: 'https://in.linkedin.com/in/ravi', location: 'Pune', source: 'LinkedIn' },
      { leadId: l.id, name: 'Asha MD', title: 'Managing Director', linkedin: 'https://in.linkedin.com/in/asha', location: 'Pune', source: 'LinkedIn' },
      { leadId: l.id, name: 'Team Pick', title: 'HR Manager', source: 'Sales team' },
    ]);
    expect(await purgeUnwanted(db)).toBe(3);
    const rows = Object.fromEntries((await db.select().from(people).where(eq(people.leadId, l.id))).map((p) => [p.name, p]));
    for (const name of ['Morgan Grumley', 'Manju Deepak', 'Ravi Director']) expect(rows[name]).toMatchObject({ passedReason: 'excluded', isPrimary: false });
    expect(rows['Morgan Grumley'].whyNot).toContain('outside India');
    expect(rows['Asha MD'].passedReason).toBe('');
    expect(rows['Team Pick'].passedReason).toBe('');
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(after.contactName).not.toBe('Morgan Grumley');
  });
});
