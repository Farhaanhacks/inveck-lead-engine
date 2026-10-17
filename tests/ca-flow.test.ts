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
    expect(await companyProgress(db, me.id, today())).toEqual({ done: 1, total: 1, backlog: 0 });
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
    // The unanswered call started the follow-up sequence (its own tasks); the CA flow's own steps are separate.
    const flow = async () => (await open(l.id)).filter((t) => t.followUpRound === 0);
    expect((await flow()).map((t) => t.step).sort()).toEqual([CA_FALLBACK_STEP, CA_WAITING_STEP].sort());
    await completeTaskAction(form({ id: fallback.find((t) => t.kind === 'email')!.id, outcome: 'done' }));
    expect(await flow()).toEqual([]);
    expect((await open(l.id)).filter((t) => t.followUpRound > 0)).toHaveLength(15);
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
    expect([DAILY_COMPANY_TARGET, DAILY_CA_TARGET]).toEqual([20, 20]);
    expect(['Puja', 'Anchal', 'Parimal', 'Anuradha'].map(worksCaFirms)).toEqual([true, true, false, false]);
    const l = await caLead();
    const first = await start(l.id);
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    expect(await companyProgress(db, me.id, today(), { ca: true })).toEqual({ done: 1, total: 1, backlog: 0 });
    expect(await companyProgress(db, me.id, today(), { ca: false })).toEqual({ done: 0, total: 0, backlog: 0 });
  });
});

describe('a connected call with a callback for today', () => {
  it('does not put a call back on the list straight away', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const { notYet } = await import('@/lib/tasks');
    const l = await caLead({ company: 'WareIQ Test', segment: '3PL', status: 'Contacted' });
    await ensureSequences(db, today());
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), eq(tasks.step, 'Day 1')));
    const call = (await open(l.id)).find((t) => t.kind === 'call' && t.dueDate === today())!;
    await completeTaskAction(form({ id: call.id, outcome: 'connected', note: 'Asked to call back', feedback: 'Call back later', callbackDate: today() }));
    const cb = (await open(l.id)).find((t) => t.priority)!;
    expect(cb.slot === 'evening' || cb.dueDate > today()).toBe(true);
    // Not due on Today right now (only from 5 pm, or a later day).
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date())) % 24;
    if (hour < 17) expect(cb.dueDate > today() || notYet(cb, today(), new Date())).toBe(true);
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

describe('adding an email from Today', () => {
  it('the first email is the contact\'s; more are kept beside it, never twice', async () => {
    const { saveFoundDetailAction } = await import('@/app/team-actions');
    const l = await caLead({ company: 'Mail Works', segment: 'Manufacturing', contactEmail: '' });
    await saveFoundDetailAction(form({ id: l.id, field: 'contactEmail', value: 'Ravi@MailWorks.com' }));
    await saveFoundDetailAction(form({ id: l.id, field: 'contactEmail', value: 'sales@mailworks.com' }));
    await saveFoundDetailAction(form({ id: l.id, field: 'contactEmail', value: 'sales@mailworks.com' }));
    await saveFoundDetailAction(form({ id: l.id, field: 'contactEmail', value: 'not an email' }));
    const [lead] = await db.select().from(leads).where(eq(leads.id, l.id));
    expect(lead.contactEmail).toBe('ravi@mailworks.com');
    expect(lead.emailStatus).toBe('entered by the team');
    const extra = (await db.select().from(people).where(eq(people.leadId, l.id))).filter((p) => p.name === 'Other email');
    expect(extra.map((p) => p.email)).toEqual(['sales@mailworks.com']);
  });
});

describe('a CA reach-out is a firm someone was actually reached at', () => {
  it('no LinkedIn, no contact found and the email skipped: the firm is done, but no reach-out', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await caLead({ contactLinkedin: '' });
    const first = await start(l.id);
    await completeTaskAction(form({ id: first.id, outcome: 'skipped' }));
    const left = await open(l.id);
    await completeTaskAction(form({ id: left.find((t) => t.kind === 'call')!.id, outcome: 'no_contact' }));
    await completeTaskAction(form({ id: left.find((t) => t.kind === 'email')!.id, outcome: 'skipped' }));
    expect(await open(l.id)).toEqual([]);
    expect(await companyProgress(db, me.id, today(), { ca: true })).toEqual({ done: 0, total: 0, backlog: 0 });
  });
});

describe('backlog', () => {
  it('a step due yesterday and done today counts as done today, and as backlog cleared', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await caLead();
    const first = await start(l.id);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.update(tasks).set({ dueDate: yesterday }).where(eq(tasks.id, first.id));
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    expect(await companyProgress(db, me.id, today(), { ca: true })).toEqual({ done: 1, total: 1, backlog: 1 });
  });
});

describe('every way of reaching out tried: the company is done for the day', () => {
  it('an unanswered call still counts; the 5 pm call-back it set up does not keep the company open', async () => {
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await caLead({ company: 'Gear Works Tried', segment: 'Manufacturing' });
    await ensureSequences(db, today());
    await db.update(tasks).set({ dueDate: today() }).where(and(eq(tasks.leadId, l.id), eq(tasks.step, 'Day 1')));
    const day1 = (await open(l.id)).filter((t) => t.step === 'Day 1');
    const outcome = { call: 'no_answer', whatsapp: 'sent', email: 'done', linkedin: 'sent' } as const;
    for (const t of day1) await completeTaskAction(form({ id: t.id, outcome: outcome[t.kind] }));
    // Whatever time the test runs, a same-day call-back is waiting.
    await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'call', step: 'Call again', title: 'Call again at 5 pm: no answer this morning', dueDate: today(), slot: 'evening', note: 'auto-retry:1' });
    const { markCompanyDay } = await import('@/lib/tasks');
    expect(await markCompanyDay(db, l.id, me.id)).toBe(true);
    expect((await companyProgress(db, me.id, today())).done).toBe(1);
  });
});

describe('choosing the tier by hand', () => {
  it('the tier picked when editing the contact is kept; "from the designation" clears it', async () => {
    const { updateContactAction } = await import('@/app/team-actions');
    const l = await caLead({ company: 'Tier Works', segment: 'Manufacturing' });
    const tier = async () => (await db.select().from(leads).where(eq(leads.id, l.id)))[0].contactTier;
    await updateContactAction(form({ id: l.id, contactName: 'Asha Rao', contactTitle: 'Senior Executive', contactPhone: '9800000001', contactLinkedin: l.contactLinkedin, contactTier: 'P1' }));
    expect(await tier()).toBe('P1');
    await updateContactAction(form({ id: l.id, contactName: 'Asha Rao', contactTitle: 'Senior Executive', contactPhone: '9800000001', contactLinkedin: l.contactLinkedin, contactTier: 'P9' }));
    expect(await tier()).toBe('');
  });
});

describe('a tier for any point of contact', () => {
  it('the tier picked when adding a point of contact is kept, and goes with them when they become the main contact', async () => {
    const { addPointOfContactAction, makePrimaryAction } = await import('@/app/actions');
    const l = await caLead({ company: 'Sugam Group', segment: 'Manufacturing' });
    await addPointOfContactAction(form({ id: l.id, name: 'Neha P', title: 'Senior Executive', phone: '9800000009', email: '', linkedin: '', tier: 'P2' }));
    const [neha] = (await db.select().from(people).where(eq(people.leadId, l.id))).filter((p) => p.name === 'Neha P');
    expect(neha.tier).toBe('P2');
    await makePrimaryAction(form({ id: l.id, personId: neha.id }));
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].contactTier).toBe('P2');
  });
});


describe('the follow-up funnel', () => {
  it('puts each company in its stage from the same steps Today uses, and its buttons move it on', async () => {
    const { loadFunnel } = await import('@/lib/followups');
    const { moveFromFunnelAction } = await import('@/app/followup-actions');
    const { completeTaskAction } = await import('@/app/team-actions');
    const stageOf = async (id: number) => (await loadFunnel(db, me.id, today())).find((c) => c.lead.id === id)?.stage;

    // A CA firm: due today, then waiting for LinkedIn once the request is sent.
    const ca = await caLead();
    const first = await start(ca.id);
    expect(await stageOf(ca.id)).toBe('today');
    await completeTaskAction(form({ id: first.id, outcome: 'sent' }));
    expect(await stageOf(ca.id)).toBe('waiting');

    // A company whose steps are all done with no reply: no reply yet.
    const quiet = await caLead({ company: 'Quiet Works', segment: 'Manufacturing', status: 'Contacted' });
    await db.insert(tasks).values({ leadId: quiet.id, ownerId: me.id, kind: 'call', step: 'Follow-up 3', title: 'call', dueDate: today(), slot: 'day', doneAt: new Date(), outcome: 'no_answer' });
    expect(await stageOf(quiet.id)).toBe('finished');

    // They replied: in conversation; then won.
    await moveFromFunnelAction(form({ id: quiet.id, stage: 'Replied' }));
    expect(await stageOf(quiet.id)).toBe('conversation');
    await moveFromFunnelAction(form({ id: quiet.id, stage: 'Won' }));
    expect(await stageOf(quiet.id)).toBeUndefined();
    expect((await db.select().from(leads).where(eq(leads.id, quiet.id)))[0].status).toBe('Won');
    // Not a stage the funnel moves to: nothing happens.
    await moveFromFunnelAction(form({ id: ca.id, stage: 'Disqualified' }));
    expect((await db.select().from(leads).where(eq(leads.id, ca.id)))[0].status).not.toBe('Disqualified');
  });
});

describe('saving the contact form never wipes the saved email', () => {
  it('the Today and lead-page contact forms have no email field: the email stays (and goes when the person changes)', async () => {
    const { updateContactAction, saveFoundDetailAction } = await import('@/app/team-actions');
    const l = await caLead({ company: 'Asian Paints', segment: 'Manufacturing', contactName: 'Harish Lade', contactTitle: 'VP Supply Chain' });
    await saveFoundDetailAction(form({ id: l.id, field: 'contactEmail', value: 'harish@asianpaints.com' }));
    const email = async () => (await db.select().from(leads).where(eq(leads.id, l.id)))[0].contactEmail;
    expect(await email()).toBe('harish@asianpaints.com');
    // Edit point of contact: a new number and a tier, no email field on the form.
    await updateContactAction(form({ id: l.id, contactName: 'Harish Lade', contactTitle: 'VP Supply Chain', contactPhone: '9892301071', contactLinkedin: l.contactLinkedin, contactTier: 'P1' }));
    expect(await email()).toBe('harish@asianpaints.com');
    // Someone else named: the previous person's email doesn't carry over.
    await updateContactAction(form({ id: l.id, contactName: 'Amardeep Jain', contactTitle: 'Factory Head', contactPhone: '', contactLinkedin: '' }));
    expect(await email()).toBe('');
  });
});

describe('a LinkedIn request in the follow-up rounds when none was sent', () => {
  it('adds one for a company worked today whose contact has no request yet; never twice, never after one was sent', async () => {
    const { ensureLinkedinSteps } = await import('@/lib/tasks');
    const { completeTaskAction } = await import('@/app/team-actions');
    const l = await caLead({ company: 'Wonder Cement', segment: 'Manufacturing', status: 'Contacted' });
    // Day 1's request was skipped; Follow-up 1 is today with a call, WhatsApp and email only.
    await db.insert(tasks).values([
      { leadId: l.id, ownerId: me.id, kind: 'linkedin', step: 'Day 1', title: 'Send the LinkedIn connection request', dueDate: '2026-10-01', doneAt: new Date('2026-10-01T06:00:00Z'), outcome: 'skipped' },
      { leadId: l.id, ownerId: me.id, kind: 'call', step: 'Follow-up 1', title: 'Follow-up 1: call', dueDate: today() },
      { leadId: l.id, ownerId: me.id, kind: 'email', step: 'Follow-up 1', title: 'Follow-up 1: email', dueDate: today() },
    ]);
    expect(await ensureLinkedinSteps(db, me.id, today())).toBe(1);
    expect(await ensureLinkedinSteps(db, me.id, today())).toBe(0);
    const li = (await open(l.id)).find((t) => t.kind === 'linkedin')!;
    expect(li).toMatchObject({ step: 'Follow-up 1', dueDate: today() });
    await completeTaskAction(form({ id: li.id, outcome: 'sent' }));
    expect(await ensureLinkedinSteps(db, me.id, today())).toBe(0);
    // A company without a LinkedIn profile gets none.
    const noLi = await caLead({ company: 'No Profile Co', segment: 'Manufacturing', status: 'Contacted', contactLinkedin: '' });
    await db.insert(tasks).values({ leadId: noLi.id, ownerId: me.id, kind: 'call', step: 'Follow-up 1', title: 'call', dueDate: today() });
    expect(await ensureLinkedinSteps(db, me.id, today())).toBe(0);
  });
});
