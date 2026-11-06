import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, tasks, users } from '@/lib/db/schema';
import { istDay } from '@/lib/tasks';
import { loadFunnel } from '@/lib/followups';

let db: Db;
let me = 0;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  me = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const at = (iso: string) => new Date(iso);
const task = (leadId: number, kind: 'call' | 'whatsapp' | 'email', extra: Partial<typeof tasks.$inferInsert>) =>
  db.insert(tasks).values({ leadId, ownerId: me, kind, step: 'Day 1', title: `Day 1: ${kind}`, dueDate: istDay(), slot: 'day', ...extra });

describe('what a follow-up card knows', () => {
  it('carries the lead\'s own saved remark and call remark (the Tracker fields), and the latest call outcome even when a message was logged after it', async () => {
    const [l] = await db.insert(leads).values({ company: 'Hosur Gears', segment: 'Manufacturing', status: 'Contacted', ownerId: me, contactName: 'Ravi', remark: 'Prefers WhatsApp after 4 pm', callRemark: 'Asked to call back after the audit' }).returning();
    await task(l.id, 'call', { doneAt: at('2026-11-02T10:00:00Z'), outcome: 'no_answer' });
    await task(l.id, 'whatsapp', { doneAt: at('2026-11-03T10:00:00Z'), outcome: 'sent' });
    await task(l.id, 'email', { step: 'Follow-up 1', title: 'Follow-up 1: email', followUpRound: 1, dueDate: '2099-01-01' });
    const card = (await loadFunnel(db, me, istDay())).find((c) => c.lead.id === l.id)!;
    // The notes are the lead's saved fields, as written (nothing copied or rewritten).
    expect(card.lead.remark).toBe('Prefers WhatsApp after 4 pm');
    expect(card.lead.callRemark).toBe('Asked to call back after the audit');
    // The last thing logged is the WhatsApp; the call before it is still shown as the last call.
    expect(card.last?.kind).toBe('whatsapp');
    expect(card.lastCall).toMatchObject({ kind: 'call', outcome: 'no_answer' });
  });

  it('shows the right outcome for each way a call can end, never a skipped or ticked-off call', async () => {
    const outcomes = ['busy', 'wrong_number', 'connected', 'no_contact'] as const;
    for (const outcome of outcomes) {
      const [l] = await db.insert(leads).values({ company: `Co ${outcome}`, segment: 'Manufacturing', status: 'Contacted', ownerId: me }).returning();
      await task(l.id, 'call', { doneAt: at('2026-11-02T10:00:00Z'), outcome });
      await task(l.id, 'call', { step: 'Follow-up 1', title: 'skipped', followUpRound: 1, doneAt: at('2026-11-04T10:00:00Z'), outcome: 'skipped' });
      await task(l.id, 'call', { step: 'Follow-up 2', title: 'closed', followUpRound: 2, doneAt: at('2026-11-05T10:00:00Z'), outcome: 'closed' });
      await task(l.id, 'email', { step: 'Follow-up 3', title: 'later', followUpRound: 3, dueDate: '2099-01-01' });
      const card = (await loadFunnel(db, me, istDay())).find((c) => c.lead.id === l.id)!;
      expect(card.lastCall?.outcome).toBe(outcome);
    }
  });

  it('a lead with no call logged has no last call, and a lead with no remarks has empty remark fields (so nothing is shown)', async () => {
    const [l] = await db.insert(leads).values({ company: 'Fresh Forge', segment: 'Manufacturing', status: 'Contacted', ownerId: me }).returning();
    await task(l.id, 'email', { step: 'Follow-up 1', title: 'Follow-up 1: email', followUpRound: 1, dueDate: '2099-01-01' });
    const card = (await loadFunnel(db, me, istDay())).find((c) => c.lead.id === l.id)!;
    expect(card.lastCall).toBeNull();
    expect([card.lead.remark, card.lead.callRemark]).toEqual(['', '']);
  });

  it('a remark saved earlier is still the same text after the lead moves into the follow-ups (nothing is overwritten)', async () => {
    const [l] = await db.insert(leads).values({ company: 'Early Note Co', segment: 'Manufacturing', status: 'Approved', ownerId: me, remark: 'Met at the expo', callRemark: '' }).returning();
    await task(l.id, 'call', { doneAt: at('2026-11-02T10:00:00Z'), outcome: 'no_answer' });
    const { startFollowUpSequence } = await import('@/lib/follow-up-sequence');
    await startFollowUpSequence(db, l.id, at('2026-11-02T10:00:00Z'));
    const card = (await loadFunnel(db, me, istDay())).find((c) => c.lead.id === l.id)!;
    expect(card.lead.remark).toBe('Met at the expo');
    expect(card.lastCall?.outcome).toBe('no_answer');
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].remark).toBe('Met at the expo');
  });
});
