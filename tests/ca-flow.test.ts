import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, people, tasks, users } from '@/lib/db/schema';
import { CA_FALLBACK_STEP, CA_WAITING_STEP, companyProgress, ensureSequences, istDay, loadTodayTasks, nextWorkingDay } from '@/lib/tasks';
import { KnownBranches } from '@/lib/branches';
import { importContactSheet, parseContactSheet } from '@/lib/contact-import';

// Server actions outside Next: the signed-in person and the cache hooks are stand-ins.
const me = { id: 0, role: 'bda' as const, name: 'Puja' };
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

const today = () => istDay();
const form = (v: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries(v)) f.set(k, String(x));
  return f;
};
const open = async (leadId: number) => db.select().from(tasks).where(and(eq(tasks.leadId, leadId), isNull(tasks.doneAt)));
const caLead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
  (
    await db
      .insert(leads)
      .values({ company: 'Test & Associates', segment: 'CA Firms', status: 'Awaiting Approval', ownerId: me.id, contactName: 'Asha Rao', contactTitle: 'Partner', contactPhone: '9800000001', contactLinkedin: 'https://in.linkedin.com/in/asha-rao', ...extra })
      .returning()
  )[0];
/** Plans the firm's steps and puts the first one on today (whatever day the test runs). */
const start = async (leadId: number) => {
  await ensureSequences(db, today());
  await db.update(tasks).set({ dueDate: today() }).where(eq(tasks.leadId, leadId));
  return (await open(leadId))[0];
};

describe('CA firms on Today', () => {
  it('start with only a LinkedIn request', async () => {
    const l = await caLead();
    await ensureSequences(db, today());
    const plan = await open(l.id);
    expect(plan.map((t) => t.kind)).toEqual(['linkedin']);
  });

  it('request sent: waits for acceptance; accepted ends the firm, and Undo brings everything back', async () => {
    const { completeTaskAction, undoTaskAction } = await import('@/app/team-actions');
    const l = await caLead();
    const first = await start(l.id);
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    let left = await open(l.id);
    expect(left.find((t) => t.step === CA_WAITING_STEP)?.dueDate).toBe(today());
    expect(left.filter((t) => t.step === CA_FALLBACK_STEP).map((t) => [t.kind, t.dueDate]).sort()).toEqual(
      [['call', nextWorkingDay(today())], ['email', nextWorkingDay(today())], ['whatsapp', nextWorkingDay(today())]].sort(),
    );
    // Sending the request is the day's work: the firm counts as done today, still waiting on LinkedIn.
    expect(await companyProgress(db, me.id, today())).toEqual({ done: 1, total: 1 });
    expect((await loadTodayTasks(db, me.id, today())).map((t) => t.task.step)).toEqual([CA_WAITING_STEP]);

    // "accepted" fits only the waiting step.
    await completeTaskAction(form({ id: left.find((t) => t.kind === 'call')!.id, outcome: 'accepted' }));
    expect((await open(l.id)).length).toBe(4);

    const waiting = left.find((t) => t.step === CA_WAITING_STEP)!;
    await completeTaskAction(form({ id: waiting.id, outcome: 'accepted' }));
    expect(await open(l.id)).toEqual([]);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].linkedinOutcome).toBe('Accepted');

    await undoTaskAction(form({ id: waiting.id }));
    expect((await open(l.id)).length).toBe(4);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].linkedinOutcome).toBe('Request sent');

    // Undoing the request takes away the wait and the call, WhatsApp and email it set up.
    await undoTaskAction(form({ id: first.id }));
    left = await open(l.id);
    expect(left.map((t) => t.id)).toEqual([first.id]);
    // Sent again: set up once, not twice.
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    expect((await open(l.id)).length).toBe(4);
  });

  it('not accepted: the call, WhatsApp and email the next day finish the firm (no call-again days)', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await caLead();
    const first = await start(l.id);
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    // The next working day has come.
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), eq(tasks.step, CA_FALLBACK_STEP)));
    const fallback = (await open(l.id)).filter((t) => t.step === CA_FALLBACK_STEP);
    await completeTaskAction(form({ id: fallback.find((t) => t.kind === 'call')!.id, outcome: 'no_answer' }));
    await completeTaskAction(form({ id: fallback.find((t) => t.kind === 'whatsapp')!.id, outcome: 'sent' }));
    expect((await open(l.id)).map((t) => t.step).sort()).toEqual([CA_FALLBACK_STEP, CA_WAITING_STEP].sort());
    await completeTaskAction(form({ id: fallback.find((t) => t.kind === 'email')!.id, outcome: 'done' }));
    expect(await open(l.id)).toEqual([]);
  });

  it('no LinkedIn: the call, WhatsApp and email come the same day, with nothing to wait for', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await caLead({ contactLinkedin: '' });
    const first = await start(l.id);
    await completeTaskAction(form({ id: first.id, outcome: 'skipped' }));
    const left = await open(l.id);
    expect(left.map((t) => [t.kind, t.dueDate]).sort()).toEqual([['call', today()], ['email', today()], ['whatsapp', today()]].sort());
  });

  it('other companies keep the full plan', async () => {
    const l = await caLead({ company: 'Gear Works', segment: 'Manufacturing' });
    await ensureSequences(db, today());
    expect(new Set((await open(l.id)).map((t) => t.kind))).toEqual(new Set(['call', 'whatsapp', 'email', 'linkedin']));
  });
});

describe('importing a researched list with its points of contact', () => {
  const sheet = [
    ['Firm', 'Phone', 'Email', 'Matched partner / proprietor', 'Role', 'LinkedIn 1', 'LinkedIn 2', 'LinkedIn 3'],
    ['ALPHA & CO', '9800000002', 'alpha@example.com', '1. Ravi Kumar\n2. Meena Iyer (LinkedIn: Meena I)', 'Partner', 'https://in.linkedin.com/in/ravi-k', 'in.linkedin.com/in/meena-i', ''],
    ['BETA ASSOCIATES', '9800000003, 080 2222 3333', 'beta@example.com', '1. Suresh B', 'Proprietor', 'https://in.linkedin.com/in/suresh-b', '', ''],
    ['', '', '', '', '', '', '', ''],
  ];

  it('reads every firm, its numbers and each person with their own LinkedIn', () => {
    const { rows, error } = parseContactSheet(sheet);
    expect(error).toBe('');
    expect(rows).toHaveLength(2);
    expect(rows[0].people).toEqual([
      { name: 'Ravi Kumar', title: 'Partner', linkedin: 'https://in.linkedin.com/in/ravi-k' },
      { name: 'Meena Iyer', title: 'Partner', linkedin: 'https://in.linkedin.com/in/meena-i' },
    ]);
    expect(rows[1].phones).toEqual(['9800000003', '080 2222 3333']);
    expect(parseContactSheet([['Name', 'Phone']]).error).toContain('Firm');
  });

  it('adds each firm once with every point of contact; the main contact is the first person, confirmed', async () => {
    const { rows } = parseContactSheet(sheet);
    const known = new KnownBranches([], []);
    const r = await importContactSheet(db, rows, { segment: 'CA Firms', ownerId: me.id, known, by: 'Puja' });
    expect(r).toEqual({ added: 2, skipped: [] });
    const [alpha] = await db.select().from(leads).where(eq(leads.company, 'ALPHA & CO'));
    expect(alpha).toMatchObject({ contactName: 'Ravi Kumar', contactPhone: '9800000002', contactEmail: 'alpha@example.com', fitOverride: '', ownerId: me.id });
    expect(alpha.contactVerifiedAt).not.toBeNull();
    const alphaPeople = await db.select().from(people).where(eq(people.leadId, alpha.id));
    expect(alphaPeople.map((p) => [p.name, p.isPrimary, p.linkedin]).sort()).toEqual(
      [['Meena Iyer', false, 'https://in.linkedin.com/in/meena-i'], ['Ravi Kumar', true, 'https://in.linkedin.com/in/ravi-k']].sort(),
    );
    const [beta] = await db.select().from(leads).where(eq(leads.company, 'BETA ASSOCIATES'));
    // The second number is kept as a point of contact of its own.
    expect((await db.select().from(people).where(eq(people.leadId, beta.id))).some((p) => p.phone === '080 2222 3333')).toBe(true);
    // The same list again adds nothing.
    expect(await importContactSheet(db, rows, { segment: 'CA Firms', ownerId: me.id, known: new KnownBranches(await db.select().from(leads), []), by: 'Puja' })).toEqual({
      added: 0,
      skipped: ['ALPHA & CO', 'BETA ASSOCIATES'],
    });
  });

  it('the team can add another number, email or LinkedIn to a company', async () => {
    const { addPointOfContactAction } = await import('@/app/actions');
    const l = await caLead();
    await addPointOfContactAction(form({ id: l.id, name: '', phone: '022 4000 5000', email: '', linkedin: '' }));
    await addPointOfContactAction(form({ id: l.id, name: 'Kiran S', title: 'Partner', phone: '', email: 'kiran@example.com', linkedin: 'in.linkedin.com/in/kiran-s' }));
    // Not a number, an address or a LinkedIn link: nothing is added.
    await addPointOfContactAction(form({ id: l.id, name: 'X', phone: 'call me', email: '', linkedin: '' }));
    const list = await db.select().from(people).where(eq(people.leadId, l.id));
    expect(list.map((p) => [p.name, p.phone, p.email, p.linkedin, p.source]).sort()).toEqual(
      [
        ['Kiran S', '', 'kiran@example.com', 'https://in.linkedin.com/in/kiran-s', 'Added by the team'],
        ['Other number', '022 4000 5000', '', '', 'Added by the team'],
      ].sort(),
    );
  });
});

describe('more than one number for a contact', () => {
  it('helpers: add without duplicates, drop the first, put it back', async () => {
    const { addPhone, dropFirstPhone, putPhoneBack, splitPhones } = await import('@/lib/phones');
    expect(addPhone('', '98450 12345')).toBe('98450 12345');
    expect(addPhone('98450 12345', '080 2222 3333')).toBe('98450 12345, 080 2222 3333');
    expect(addPhone('98450 12345', '+91 9845012345')).toBe('98450 12345');
    expect(splitPhones('98450 12345, 080 2222 3333 / 9900011122')).toEqual(['98450 12345', '080 2222 3333', '9900011122']);
    expect(dropFirstPhone('98450 12345, 080 2222 3333')).toEqual({ removed: '98450 12345', rest: '080 2222 3333' });
    expect(putPhoneBack('080 2222 3333', '98450 12345')).toBe('98450 12345, 080 2222 3333');
    const { whatsappLink } = await import('@/lib/talk');
    expect(whatsappLink('98450 12345, 080 2222 3333', 'hi')).toContain('wa.me/919845012345');
  });

  it('Today saves a second number; a wrong number removes only the one dialled and the next is called today', async () => {
    const { saveFoundDetailAction, completeTaskAction, undoTaskAction } = await import('@/app/team-actions');
    const l = await caLead({ company: 'Gear Works', segment: 'Manufacturing', contactPhone: '' });
    await saveFoundDetailAction(form({ id: l.id, field: 'contactPhone', value: '98450 12345' }));
    await saveFoundDetailAction(form({ id: l.id, field: 'contactPhone', value: '080 2222 3333' }));
    const phone = async () => (await db.select().from(leads).where(eq(leads.id, l.id)))[0].contactPhone;
    expect(await phone()).toBe('98450 12345, 080 2222 3333');

    await ensureSequences(db, today());
    await db.update(tasks).set({ dueDate: today() }).where(eq(tasks.leadId, l.id));
    const call = (await open(l.id)).find((t) => t.kind === 'call')!;
    await completeTaskAction(form({ id: call.id, outcome: 'wrong_number' }));
    expect(await phone()).toBe('080 2222 3333');
    const next = (await open(l.id)).find((t) => t.kind === 'call' && t.title === 'Call the next number');
    expect(next?.dueDate).toBe(today());
    // Not "Wrong number" on the tracker while a number is left to try.
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].callFeedback).toBe('');

    await undoTaskAction(form({ id: call.id }));
    expect(await phone()).toBe('98450 12345, 080 2222 3333');
    expect((await open(l.id)).some((t) => t.title === 'Call the next number')).toBe(false);
  });
});

describe('daily counts for the people who work CA firms', () => {
  it('CA firms count on their own card; the companies card counts the rest', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const { worksCaFirms, DAILY_COMPANY_TARGET, DAILY_CA_TARGET } = await import('@/lib/tasks');
    expect([DAILY_COMPANY_TARGET, DAILY_CA_TARGET]).toEqual([40, 20]);
    expect(['Puja', 'Anchal', 'Parimal', 'Anuradha'].map(worksCaFirms)).toEqual([true, true, false, false]);
    const l = await caLead();
    const first = await start(l.id);
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    expect(await companyProgress(db, me.id, today(), { ca: true })).toEqual({ done: 1, total: 1 });
    expect(await companyProgress(db, me.id, today(), { ca: false })).toEqual({ done: 0, total: 0 });
  });
});

describe('call outcomes: demo completed, client onboarded, already a client', () => {
  const connect = async (feedback: string) => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const { clients } = await import('@/lib/db/schema');
    const l = await caLead({ company: `Gear Works ${feedback}`, segment: 'Manufacturing', status: 'Contacted' });
    await ensureSequences(db, today());
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), eq(tasks.step, 'Day 1')));
    const call = (await open(l.id)).find((t) => t.kind === 'call' && t.dueDate === today())!;
    await completeTaskAction(form({ id: call.id, outcome: 'connected', note: 'Spoke with them', feedback }));
    const [after] = await db.select().from(leads).where(eq(leads.id, l.id));
    const onSheet = (await db.select().from(clients)).some((c) => c.company === l.company);
    return { status: after.status, callFeedback: after.callFeedback, open: await open(l.id), onSheet };
  };

  it('Demo completed: Meeting Booked, the later rounds stop', async () => {
    const r = await connect('Demo completed');
    expect(r.status).toBe('Meeting Booked');
    expect(r.callFeedback).toBe('Demo completed');
    expect(r.open.every((t) => t.dueDate <= today())).toBe(true);
    expect(r.onSheet).toBe(false);
  });

  it('Client onboarded: Won, on the clients sheet, nothing more goes out', async () => {
    const r = await connect('Client onboarded');
    expect(r.status).toBe('Won');
    expect(r.onSheet).toBe(true);
    expect(r.open).toEqual([]);
  });

  it('Already a client: Existing Client, on the clients sheet, nothing more goes out', async () => {
    const r = await connect('Already a client');
    expect(r.status).toBe('Existing Client');
    expect(r.onSheet).toBe(true);
    expect(r.open).toEqual([]);
  });
});
