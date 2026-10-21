import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { contactLinkedin, leads, people, users } from '@/lib/db/schema';
import { LINKEDIN_STATUSES, LINKEDIN_STATUS_LABEL, loadLinkedinActivity, saveLinkedinActivity, statusFromOutcome } from '@/lib/linkedin-activity';

const me = { id: 0, role: 'bda' as 'bda' | 'admin', name: 'Puja' };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

let db: Db;
let owner: number;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  const bdas = await db.select().from(users).where(eq(users.role, 'bda'));
  owner = bdas[0].id;
  me.id = owner;
  me.role = 'bda';
});
const setup = async () => {
  const [l] = await db.insert(leads).values({ company: 'Hosur Gears', segment: 'Manufacturing', status: 'Contacted', ownerId: owner, contactName: 'Ravi Kumar' }).returning();
  const [a] = await db.insert(people).values({ leadId: l.id, name: 'Ravi Kumar', isPrimary: true }).returning();
  const [b] = await db.insert(people).values({ leadId: l.id, name: 'Asha Rao', title: 'Inventory Manager' }).returning();
  return { l, a, b };
};

describe('LinkedIn activity per contact', () => {
  it('has the six statuses, in order', () => {
    expect(LINKEDIN_STATUSES.map((s) => LINKEDIN_STATUS_LABEL[s])).toEqual(['Not started', 'Connection request sent', 'Connection accepted', 'Message sent', 'Follow-up sent', 'Response received']);
  });

  it('saves status and remarks against that contact, and survives a reload; another contact is untouched', async () => {
    const { l, a, b } = await setup();
    expect((await saveLinkedinActivity(db, { leadId: l.id, personId: a.id, status: 'request_sent', remarks: '  Sent on Monday  ', userId: owner })).ok).toBe(true);
    expect((await saveLinkedinActivity(db, { leadId: l.id, personId: b.id, status: 'accepted', remarks: 'Accepted, will message', userId: owner })).ok).toBe(true);
    // Updating one again never changes the other.
    await saveLinkedinActivity(db, { leadId: l.id, personId: a.id, status: 'message_sent', remarks: 'Sent the profile', userId: owner });
    const saved = await loadLinkedinActivity(db, [l.id]);
    expect(saved.get(`${l.id}:${a.id}`)).toEqual({ status: 'message_sent', remarks: 'Sent the profile' });
    expect(saved.get(`${l.id}:${b.id}`)).toEqual({ status: 'accepted', remarks: 'Accepted, will message' });
    expect(await db.select().from(contactLinkedin)).toHaveLength(2);
  });

  it('refuses a status that is not one of the six, remarks that are too long, and a contact from another company', async () => {
    const { l, a } = await setup();
    const other = (await db.insert(leads).values({ company: 'Other Co', segment: 'Manufacturing', ownerId: owner }).returning())[0];
    expect((await saveLinkedinActivity(db, { leadId: l.id, personId: a.id, status: 'liked', remarks: '', userId: owner })).ok).toBe(false);
    expect((await saveLinkedinActivity(db, { leadId: l.id, personId: a.id, status: 'accepted', remarks: 'x'.repeat(1001), userId: owner })).ok).toBe(false);
    expect((await saveLinkedinActivity(db, { leadId: other.id, personId: a.id, status: 'accepted', remarks: '', userId: owner })).ok).toBe(false);
    expect(await db.select().from(contactLinkedin)).toEqual([]);
  });

  it('shows what the lead tracker already says until someone sets it here', () => {
    expect(statusFromOutcome('Request sent')).toBe('request_sent');
    expect(statusFromOutcome('Accepted')).toBe('accepted');
    expect(statusFromOutcome('Replied')).toBe('response_received');
    for (const o of ['', 'Not sent', 'No response', 'Not on LinkedIn']) expect(statusFromOutcome(o)).toBe('not_started');
  });

  it("only the company's owner (or an administrator) can save", async () => {
    const { l, a } = await setup();
    const { saveLinkedinActivityAction } = await import('@/app/linkedin-activity-actions');
    expect(await saveLinkedinActivityAction(l.id, a.id, 'accepted', 'ok')).toEqual({ ok: true });
    const other = (await db.select().from(users).where(eq(users.role, 'bda')))[1];
    me.id = other.id;
    expect(await saveLinkedinActivityAction(l.id, a.id, 'message_sent', 'nope')).toMatchObject({ ok: false });
    me.role = 'admin';
    expect(await saveLinkedinActivityAction(l.id, a.id, 'follow_up_sent', 'admin')).toEqual({ ok: true });
    expect((await loadLinkedinActivity(db, [l.id])).get(`${l.id}:${a.id}`)?.status).toBe('follow_up_sent');
  });

  it('a lead whose main contact has no people row is kept under person 0', async () => {
    const [l] = await db.insert(leads).values({ company: 'Sheet CA', segment: 'CA Firms', ownerId: owner }).returning();
    expect((await saveLinkedinActivity(db, { leadId: l.id, personId: 0, status: 'request_sent', remarks: '', userId: owner })).ok).toBe(true);
    expect((await loadLinkedinActivity(db, [l.id])).get(`${l.id}:0`)?.status).toBe('request_sent');
  });
});
