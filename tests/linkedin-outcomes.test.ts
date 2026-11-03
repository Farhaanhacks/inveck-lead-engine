import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { SCHEMA_STATEMENTS } from '@/lib/db/migrate';
import { activities, leads, tasks, users } from '@/lib/db/schema';
import { ensureSequences, istDay, loadTodayTasks } from '@/lib/tasks';
import { loadFunnel } from '@/lib/followups';
import { followUpsDue, startFollowUpSequence } from '@/lib/follow-up-sequence';
import { LI_NEGATIVE, LI_NEUTRAL, LI_NOT_ACTIVE, LI_POSITIVE, LI_REPLIED_LEGACY } from '@/lib/linkedin-outcomes';
import { statusFromOutcome } from '@/lib/linkedin-activity';
import { cleanMedium, cleanOutcome, LINKEDIN_FILTER_OUTCOMES, LINKEDIN_OUTCOMES, loadTracker, matchesOutcome, OUTCOMES_BY_MEDIUM, CALL_FEEDBACK, MAIL_OUTCOMES, inDayRange } from '@/lib/tracker';

const me = { id: 0, role: 'bda' as const, name: 'Puja', username: 'puja@inveck', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const lead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
  (await db.insert(leads).values({ company: 'Hosur Gears', segment: 'Manufacturing', status: 'Contacted', ownerId: me.id, contactName: 'Ravi Shah', contactPhone: '9876543210', contactEmail: 'r@h.in', ...extra }).returning())[0];
const step = (leadId: number, kind: 'call' | 'whatsapp' | 'email' | 'linkedin', extra: Partial<typeof tasks.$inferInsert> = {}) =>
  db.insert(tasks).values({ leadId, ownerId: me.id, kind, step: 'Follow-up 1', title: `Follow-up 1: ${kind}`, dueDate: istDay(), slot: 'day', followUpRound: 1, ...extra }).returning().then((r) => r[0]);
const setOutcome = async (id: number, value: string) => (await import('@/app/team-actions')).updateTrackerFieldAction(id, 'linkedinOutcome', value);
const open = (leadId: number) => db.select().from(tasks).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt)));

describe('the LinkedIn outcome choices', () => {
  it('replace "Replied" with Positive, Negative and Neutral, and rename "Not on LinkedIn"', () => {
    expect([...LINKEDIN_OUTCOMES]).toEqual(['Not sent', 'Request sent', 'Accepted', 'LinkedIn – Positive Response', 'LinkedIn – Negative Response', 'Neutral', 'No response', 'Not Active on LinkedIn']);
    expect(LINKEDIN_OUTCOMES as readonly string[]).not.toContain('Replied');
    expect(LINKEDIN_OUTCOMES as readonly string[]).not.toContain('Not on LinkedIn');
    // A saved, unclassified "Replied" can still be found by the filter.
    expect(LINKEDIN_FILTER_OUTCOMES).toContain('Replied');
  });

  it('the picker takes the new values and refuses the removed ones', async () => {
    const l = await lead();
    for (const v of [LI_POSITIVE, LI_NEUTRAL, LI_NOT_ACTIVE]) expect(await setOutcome(l.id, v)).toEqual({ ok: true });
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].linkedinOutcome).toBe(LI_NOT_ACTIVE);
    expect((await setOutcome(l.id, 'Replied')).ok).toBe(false);
    expect((await setOutcome(l.id, 'Not on LinkedIn')).ok).toBe(false);
  });

  it('the one-time rename changes only "Not on LinkedIn"; saved "Replied" and everything else stay, history included', async () => {
    const a = await lead({ company: 'A', linkedinOutcome: 'Not on LinkedIn' });
    const b = await lead({ company: 'B', linkedinOutcome: 'Replied' });
    const c = await lead({ company: 'C', linkedinOutcome: 'Request sent' });
    await db.insert(activities).values({ leadId: b.id, kind: 'note', text: 'LinkedIn outcome: Replied' });
    for (const statement of SCHEMA_STATEMENTS) await db.execute(sql.raw(statement));
    const by = async (id: number) => (await db.select().from(leads).where(eq(leads.id, id)))[0].linkedinOutcome;
    expect([await by(a.id), await by(b.id), await by(c.id)]).toEqual([LI_NOT_ACTIVE, LI_REPLIED_LEGACY, 'Request sent']);
    expect((await db.select().from(activities).where(eq(activities.leadId, b.id))).map((x) => x.text)).toEqual(['LinkedIn outcome: Replied']);
  });

  it('an unclassified "Replied" is still a response (not guessed positive or negative) and shows as such in the tracker', async () => {
    expect(statusFromOutcome('Replied')).toBe('response_received');
    const l = await lead({ linkedinOutcome: 'Replied' });
    expect((await loadTracker(db, me.id)).find((r) => r.lead.id === l.id)).toMatchObject({ linkedinOutcome: 'Replied', pointOfContact: 'LinkedIn' });
    // It is not removed from follow-ups: only an explicit negative response does that.
    await step(l.id, 'call');
    expect((await open(l.id)).length).toBe(1);
  });

  it('a lead with no LinkedIn address shows Not Active on LinkedIn', async () => {
    const l = await lead({ contactLinkedin: '' });
    expect((await loadTracker(db, me.id)).find((r) => r.lead.id === l.id)?.linkedinOutcome).toBe(LI_NOT_ACTIVE);
  });
});

describe('what each response does to follow-ups', () => {
  it('Negative: its open steps are cancelled, it leaves Today and the follow-up list, and nothing more is scheduled; a promised callback stays', async () => {
    const l = await lead();
    await step(l.id, 'call');
    await step(l.id, 'whatsapp');
    await step(l.id, 'email', { step: 'Follow-up 2', followUpRound: 2, dueDate: '2099-01-01' });
    const callback = await step(l.id, 'call', { step: 'Promised callback', title: 'Promised callback', followUpRound: 0, priority: true });
    expect((await loadFunnel(db, me.id)).some((c) => c.lead.id === l.id)).toBe(true);
    expect(await setOutcome(l.id, LI_NEGATIVE)).toEqual({ ok: true });

    const left = await open(l.id);
    expect(left.map((t) => t.id)).toEqual([callback.id]);
    const closed = await db.select().from(tasks).where(and(eq(tasks.leadId, l.id), eq(tasks.outcome, 'closed')));
    expect(closed.length).toBe(3);
    expect((await db.select().from(activities).where(eq(activities.leadId, l.id))).some((a) => a.text.startsWith('Negative response on LinkedIn: removed from follow-ups; 3 open steps cancelled'))).toBe(true);
    // Not on Today (but the callback still is), not in the funnel, not due.
    expect((await loadTodayTasks(db, me.id, istDay())).map((t) => t.task.id)).toEqual([callback.id]);
    expect((await loadFunnel(db, me.id)).some((c) => c.lead.id === l.id)).toBe(false);
    expect((await followUpsDue(db, istDay())).some((x) => x.lead.id === l.id)).toBe(false);
  });

  it('Negative: nothing is scheduled for it afterwards, by any route', async () => {
    const withNoSteps = await lead({ status: 'Approved', contactName: 'Asha', linkedinOutcome: LI_NEGATIVE });
    const noContact = await lead({ company: 'Nobody Ltd', status: 'Approved', contactName: '', linkedinOutcome: LI_NEGATIVE });
    expect(await startFollowUpSequence(db, withNoSteps.id)).toBeNull();
    await ensureSequences(db, istDay());
    expect(await open(withNoSteps.id)).toEqual([]);
    expect(await open(noContact.id)).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.leadId, withNoSteps.id))).length).toBe(0);
    // A lead not marked negative is planned as before.
    const fine = await lead({ company: 'Fine Co', status: 'Approved', contactName: 'Meera' });
    await ensureSequences(db, istDay());
    expect((await open(fine.id)).length).toBeGreaterThan(0);
  });

  it('Negative: a CA firm gets no waiting step or rounds after its request is logged, and "accepted" never overwrites the response', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const form = (v: Record<string, string | number>) => Object.entries(v).reduce((f, [k, x]) => (f.set(k, String(x)), f), new FormData());
    const ca = await lead({ company: 'Sugam & Co', segment: 'CA Firms', status: 'Approved', contactLinkedin: 'https://in.linkedin.com/in/x', linkedinOutcome: LI_NEGATIVE });
    const first = await step(ca.id, 'linkedin', { step: 'Day 1', title: 'Send the LinkedIn connection request', followUpRound: 0 });
    expect(await completeTaskAction(form({ id: first.id, outcome: 'sent' }))).toMatchObject({ ok: true });
    expect((await db.select().from(tasks).where(eq(tasks.leadId, ca.id))).length).toBe(1);
    expect((await db.select().from(leads).where(eq(leads.id, ca.id)))[0].linkedinOutcome).toBe(LI_NEGATIVE);
  });

  it('Positive, Neutral and the old Replied change nothing about follow-ups: they continue as before', async () => {
    for (const outcome of [LI_POSITIVE, LI_NEUTRAL, LI_REPLIED_LEGACY]) {
      const l = await lead({ company: `Co ${outcome}`, linkedinOutcome: outcome });
      await step(l.id, 'call');
      await step(l.id, 'email');
      expect(await setOutcome(l.id, outcome === LI_REPLIED_LEGACY ? LI_POSITIVE : outcome)).toEqual({ ok: true });
      expect((await open(l.id)).length).toBe(2);
      expect((await loadTodayTasks(db, me.id, istDay())).filter((t) => t.lead.id === l.id).length).toBe(2);
      expect((await loadFunnel(db, me.id)).some((c) => c.lead.id === l.id)).toBe(true);
    }
  });
});

describe('the Medium and Outcome filters', () => {
  it('Outcome lists only the chosen medium; Call and Email keep their existing outcomes', () => {
    expect(OUTCOMES_BY_MEDIUM.call.map((o) => o.value)).toEqual(['none', ...CALL_FEEDBACK]);
    expect(OUTCOMES_BY_MEDIUM.email.map((o) => o.value)).toEqual([...MAIL_OUTCOMES]);
    const li = OUTCOMES_BY_MEDIUM.linkedin.map((o) => o.label);
    expect(li).toEqual(expect.arrayContaining([LI_POSITIVE, LI_NEGATIVE, LI_NEUTRAL, LI_NOT_ACTIVE, 'Replied (not classified)']));
    expect(li).not.toContain('Interested');
    expect(OUTCOMES_BY_MEDIUM.call.map((o) => o.label)).not.toContain(LI_NEGATIVE);
  });

  it('changing the medium drops an outcome that is not its own', () => {
    expect(cleanMedium('linkedin')).toBe('linkedin');
    expect(cleanMedium('fax')).toBe('');
    expect(cleanOutcome('linkedin', LI_NEGATIVE)).toBe(LI_NEGATIVE);
    expect(cleanOutcome('call', LI_NEGATIVE)).toBe('');
    expect(cleanOutcome('email', 'Interested')).toBe('');
    expect(cleanOutcome('', 'Sent')).toBe('');
  });

  it('filters the saved data of each medium, with the date filter beside it', async () => {
    const day = async (company: string, extra: Partial<typeof leads.$inferInsert>, createdAt: string) => {
      const l = await lead({ company, ...extra });
      await db.update(leads).set({ createdAt: new Date(createdAt) }).where(eq(leads.id, l.id));
      return l;
    };
    const a = await day('Alpha', { linkedinOutcome: LI_NEGATIVE, callFeedback: 'Interested', mailOutcome: 'Sent' }, '2026-11-02T06:00:00Z');
    const b = await day('Beta', { linkedinOutcome: LI_POSITIVE, callFeedback: 'Not interested', mailOutcome: 'Bounced' }, '2026-11-10T06:00:00Z');
    const c = await day('Gamma', { linkedinOutcome: 'Replied', contactLinkedin: '' }, '2026-11-12T06:00:00Z');
    const rows = await loadTracker(db, me.id);
    const pick = (medium: 'call' | 'linkedin' | 'email', outcome: string, from = '', to = '') =>
      rows.filter((r) => matchesOutcome(r, medium, outcome) && inDayRange(r.lead.createdAt, from, to)).map((r) => r.lead.company).sort();
    expect(pick('linkedin', LI_NEGATIVE)).toEqual(['Alpha']);
    expect(pick('linkedin', LI_POSITIVE)).toEqual(['Beta']);
    expect(pick('linkedin', 'Replied')).toEqual(['Gamma']);
    expect(pick('call', 'Interested')).toEqual(['Alpha']);
    expect(pick('call', 'none')).toEqual(['Gamma']);
    expect(pick('email', 'Bounced')).toEqual(['Beta']);
    // With dates: only the leads added in the range.
    expect(pick('linkedin', LI_POSITIVE, '2026-11-01', '2026-11-05')).toEqual([]);
    expect(pick('linkedin', LI_POSITIVE, '2026-11-08', '2026-11-11')).toEqual(['Beta']);
    // No outcome picked: the medium alone leaves everything in.
    expect(pick('email', '')).toHaveLength(rows.length);
    void a; void b; void c;
  });
});
