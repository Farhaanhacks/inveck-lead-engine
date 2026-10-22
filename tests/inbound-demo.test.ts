import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { inboundDemoRows, leadMeetings, leads, tasks, users } from '@/lib/db/schema';
import { cursorOf, parseSheet, parseWhen, resolveBdas, rowKeyOf, rowProblem, slotOf, sourceDetails, sourceLine, syncInboundDemos } from '@/lib/inbound-demo';
import { hashPassword } from '@/lib/passwords';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const NOW = new Date('2026-10-22T05:00:00Z');
const HEAD = ['submitted_at', 'kind', 'persona', 'name', 'email', 'phone', 'company', 'location', 'source', 'answers', 'page', 'landing', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'li_fat_id', 'gclid', 'received_at'];
const row = (o: Record<string, string>) => HEAD.map((h) => o[h] ?? '');
const R = (name: string, email: string, extra: Record<string, string> = {}) => row({ submitted_at: '2026-10-22T04:00:00.000Z', kind: 'demo', persona: 'Manufacturing', name, email, phone: '+91 98450 12345', company: `${name} Works`, location: 'pune', source: 'Social Media', answers: 'Plants / locations: 2 to 5 | ERP or system in use: SAP', utm_source: 'linkedin', utm_medium: 'paid', utm_campaign: 'oct', ...extra });

describe('reading the sheet', () => {
  it('maps by header, not by column position, and keeps every column', () => {
    const p = parseSheet([['Email', 'Name', 'Mystery Column'], ['a@b.com', 'Asha', 'kept']]);
    expect(p.rows[0].cells).toEqual({ email: 'a@b.com', name: 'Asha', mystery_column: 'kept' });
    expect(parseSheet([['x', 'y']]).error).toMatch(/no "email" column/);
    expect(sourceDetails(p.rows[0].cells).find((d) => d.label === 'mystery column')?.value).toBe('kept');
  });

  it('turns away formulas, (ignore) rows and rows with no usable email', () => {
    expect(rowProblem({ name: '=1+1 TEST', email: 'a@b.com', company: '' })).toMatch(/formula/);
    expect(rowProblem({ name: 'TEST LEAD (ignore)', email: 'a@b.com', company: '' })).toMatch(/ignore/);
    expect(rowProblem({ name: 'Asha', email: 'nope', company: '' })).toMatch(/email/);
    expect(rowProblem({ name: 'Asha', email: 'a@b.com', company: 'Acme' })).toBe('');
  });

  it('the key is who, when and which form: an identical re-submission is one', () => {
    const a = { submitted_at: '2026-10-22T07:28:13.488Z', email: 'N@x.com', kind: 'demo', landing: '/features/' };
    expect(rowKeyOf(a)).toBe(rowKeyOf({ ...a, email: 'n@x.com', landing: '' }));
    expect(rowKeyOf(a)).not.toBe(rowKeyOf({ ...a, submitted_at: '2026-10-22T07:29:00.000Z' }));
  });

  it('shows the source and attribution as one line', () => {
    expect(sourceLine({ source: 'Social Media', persona: 'Manufacturing', location: 'Pune', answers: 'Plants: 2', utm_source: 'linkedin', utm_medium: 'paid' })).toBe('Source: Social Media · Persona: Manufacturing · Pune · Plants: 2 · UTM: linkedin / paid');
  });
});

describe('the meeting time', () => {
  it('only a confirmed time counts: a preferred one or none books nothing', () => {
    expect(slotOf({ name: 'A', email: 'a@b.com' })).toEqual({ kind: 'none' });
    expect(slotOf({ answers: 'Preferred time: Tuesday morning | Plants: 2' })).toMatchObject({ kind: 'preferred' });
    expect(slotOf({ preferred_slot: 'Tuesday 11 am' })).toMatchObject({ kind: 'preferred' });
    expect(slotOf({ submitted_at: '2026-10-22T04:00:00Z' })).toEqual({ kind: 'none' });
    expect(slotOf({ meeting_date: '2026-10-24', meeting_time: '3:30 pm' })).toEqual({ kind: 'confirmed', date: '2026-10-24', time: '15:30' });
    expect(slotOf({ confirmed_slot: '2026-10-24T10:00:00Z' })).toEqual({ kind: 'confirmed', date: '2026-10-24', time: '15:30' });
    expect(slotOf({ meeting_date: 'sometime' })).toMatchObject({ kind: 'unreadable' });
  });
  it("the form's booking columns are the meeting time: booking_id, status slot_chosen, preferred_start_utc / _ist", () => {
    expect(slotOf({ booking_id: 'b1', status: 'slot_chosen', preferred_start_utc: '2026-10-24T04:30:00.000Z', preferred_start_ist: 'Sat 24 Oct 2026, 10:00 IST', timezone: 'Asia/Kolkata' })).toEqual({ kind: 'confirmed', date: '2026-10-24', time: '10:00' });
    // The IST text alone is enough.
    expect(slotOf({ booking_id: 'b1', status: 'slot_chosen', preferred_start_ist: 'Sat 24 Oct 2026, 09:30 IST' })).toEqual({ kind: 'confirmed', date: '2026-10-24', time: '09:30' });
    // A cancelled booking, or a form row with no slot, books nothing.
    expect(slotOf({ booking_id: 'b1', status: 'cancelled', preferred_start_utc: '2026-10-24T04:30:00.000Z' })).toMatchObject({ kind: 'unreadable' });
    expect(slotOf({ booking_id: '', status: '', preferred_start_utc: '', preferred_start_ist: '', timezone: '' })).toEqual({ kind: 'none' });
  });
  it('a booking id is the row key when there is one', () => {
    const a = { booking_id: 'abc', submitted_at: '2026-10-22T08:18:23Z', email: 'a@b.com', kind: 'demo' };
    expect(rowKeyOf(a)).toBe(rowKeyOf({ ...a, submitted_at: '', email: 'other@b.com' }));
    expect(rowKeyOf(a)).not.toBe(rowKeyOf({ ...a, booking_id: 'abd' }));
  });
  it('reads dates in the forms a sheet writes them (India time unless a zone is given)', () => {
    expect(parseWhen('2026-10-24 15:00')).toEqual({ date: '2026-10-24', time: '15:00' });
    expect(parseWhen('24/10/2026', '10:30')).toEqual({ date: '2026-10-24', time: '10:30' });
    expect(parseWhen('2026-10-24T20:00:00-05:00')).toEqual({ date: '2026-10-25', time: '06:30' });
  });
});

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
});

describe('the rotation and the import', () => {
  const source = (rows: string[][]) => async () => [HEAD, ...rows];
  const ownerNames = async () => {
    const all = await db.select().from(inboundDemoRows).orderBy(inboundDemoRows.id);
    const names = new Map((await db.select().from(users)).map((u) => [u.id, u.name]));
    return all.map((r) => [r.allocName, r.ownerId ? names.get(r.ownerId) : null, r.state]);
  };

  it('finds the four BDAs by name, never guessing or creating: Pooja is Puja (reported), Anshul has no user', async () => {
    const { by, mismatches } = await resolveBdas(db);
    expect(by.get('Pooja')?.name).toBe('Puja');
    expect(by.get('Anuradha')?.name).toBe('Anuradha');
    expect(by.get('Parimal')?.name).toBe('Parimal');
    expect(by.get('Anshul')).toBeNull();
    expect(mismatches.map((m) => m.rotationName).sort()).toEqual(['Anshul', 'Pooja']);
    expect((await db.select().from(users)).some((u) => u.name === 'Anshul')).toBe(false);
  });

  it('creates inbound demo leads (Replied, no research, no steps), in rotation, with the sheet\'s details; an unmatched BDA\'s turn waits', async () => {
    const rows = [R('Ravi', 'ravi@a.com', { submitted_at: '2026-10-22T04:00:00Z' }), R('Sita', 'sita@a.com', { submitted_at: '2026-10-22T04:01:00Z' }), R('Tom', 'tom@a.com', { submitted_at: '2026-10-22T04:02:00Z' }), R('Uma', 'uma@a.com', { submitted_at: '2026-10-22T04:03:00Z' })];
    const report = await syncInboundDemos(db, { source: source(rows), now: NOW });
    expect(report).toMatchObject({ read: 4, created: 3, meetings: 0 });
    expect(await ownerNames()).toEqual([['Pooja', 'Puja', 'imported'], ['Anshul', null, 'blocked'], ['Anuradha', 'Anuradha', 'imported'], ['Parimal', 'Parimal', 'imported']]);
    expect(report.blocked).toHaveLength(1);
    expect(report.noMeeting).toHaveLength(3);
    expect(report.noMeeting[0].reason).toMatch(/no meeting date or time/);
    const made = await db.select().from(leads);
    expect(made.every((l) => l.status === 'Replied' && l.inbound && l.source === 'Inbound demo request (website form)')).toBe(true);
    expect(made[0]).toMatchObject({ company: 'Ravi Works', contactName: 'Ravi', contactEmail: 'ravi@a.com', city: 'Pune', segment: 'Manufacturing' });
    expect(made[0].remark).toContain('Source: Social Media');
    // No cold-call steps, no research queue.
    expect(await db.select().from(tasks)).toEqual([]);
    expect(made.some((l) => l.status === 'New')).toBe(false);
    // The whole row is kept.
    expect((await db.select().from(inboundDemoRows))[0].raw.utm_campaign).toBe('oct');
  });

  it('running again changes nothing; a later batch carries on from where the rotation stopped; the waiting turn is filled once the user exists', async () => {
    const batch1 = [R('Ravi', 'ravi@a.com', { submitted_at: '2026-10-22T04:00:00Z' }), R('Sita', 'sita@a.com', { submitted_at: '2026-10-22T04:01:00Z' })];
    await syncInboundDemos(db, { source: source(batch1), now: NOW });
    const again = await syncInboundDemos(db, { source: source(batch1), now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(again.created).toBe(0);
    expect(await db.select().from(leads)).toHaveLength(1);
    expect(await cursorOf(db)).toBe(2);
    // Next batch: Anuradha, then Parimal, then back to Pooja.
    const batch2 = [...batch1, R('Tom', 'tom@a.com', { submitted_at: '2026-10-22T05:00:00Z' }), R('Uma', 'uma@a.com', { submitted_at: '2026-10-22T05:01:00Z' }), R('Vik', 'vik@a.com', { submitted_at: '2026-10-22T05:02:00Z' })];
    await syncInboundDemos(db, { source: source(batch2), now: new Date(NOW.getTime() + 20 * 60_000) });
    expect((await ownerNames()).map((r) => r[0])).toEqual(['Pooja', 'Anshul', 'Anuradha', 'Parimal', 'Pooja']);
    // Anshul joins: the waiting row goes to them, nobody else's share moves.
    await db.insert(users).values({ username: 'anshul@inveck', name: 'Anshul', role: 'bda', passwordHash: await hashPassword('x'.repeat(10)), mustChangePassword: true });
    const done = await syncInboundDemos(db, { source: source(batch2), now: new Date(NOW.getTime() + 30 * 60_000) });
    expect(done.created).toBe(1);
    expect((await ownerNames()).map((r) => r[1])).toEqual(['Puja', 'Anshul', 'Anuradha', 'Parimal', 'Puja']);
  });

  it('skips junk rows, folds an identical re-submission into one, and one person is one lead however often they submit', async () => {
    const rows = [
      row({ submitted_at: '2026-10-21T11:30:00Z', kind: 'demo', name: 'TEST LEAD (ignore)', email: 't@x.com', company: 'TEST' }),
      row({ kind: 'demo', name: '=1+1 TEST', email: 't2@x.com', company: '@SUM(1)' }),
      R('Nirmal', 'n@x.com', { submitted_at: '2026-10-22T06:42:00Z' }),
      R('Nirmal', 'n@x.com', { submitted_at: '2026-10-22T06:42:00Z', landing: '/features/' }),
      R('Nirmal', 'n@x.com', { submitted_at: '2026-10-22T07:28:00Z', company: 'Inveck india' }),
    ];
    const r = await syncInboundDemos(db, { source: source(rows), now: NOW });
    expect(r.skipped.map((s) => s.reason).join(' ')).toMatch(/ignore/);
    expect(r).toMatchObject({ created: 1, merged: 1 });
    expect(await db.select().from(leads)).toHaveLength(1);
    expect(await cursorOf(db)).toBe(1);
  });

  it("shows whose turn is next and who the latest requests went to", async () => {
    const { rotationView } = await import('@/lib/inbound-demo');
    expect((await rotationView(db)).next).toEqual({ name: 'Pooja', user: 'Puja' });
    await syncInboundDemos(db, { source: source([R('Ravi', 'ravi@a.com'), R('Sita', 'sita@a.com', { submitted_at: '2026-10-22T04:01:00Z' })]), now: NOW });
    const v = await rotationView(db);
    expect(v.next.name).toBe('Anuradha');
    expect(v.recent.map((r) => [r.who, r.bda, r.state])).toEqual([['Sita', 'Anshul', 'blocked'], ['Ravi', 'Pooja', 'imported']]);
  });

  it('reports an unreadable sheet instead of failing, and never writes to it', async () => {
    const r = await syncInboundDemos(db, { source: async () => { throw new Error('Google Sheets: The caller does not have permission'); }, now: NOW });
    expect(r.error).toMatch(/couldn't be read/);
    expect(await db.select().from(leads)).toEqual([]);
  });
});

describe('the Teams meeting from the sheet', () => {
  let calls: string[];
  beforeEach(() => {
    process.env.MICROSOFT_CLIENT_ID = 'cid';
    process.env.MICROSOFT_CLIENT_SECRET = 'secret-value';
    process.env.MICROSOFT_TENANT_ID = 'tenant';
    process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = 'a-long-random-test-key-0123456789-abcdef';
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url.replace('https://graph.microsoft.com/v1.0', '')}`);
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
      if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 'a', refresh_token: 'r1', scope: 'User.Read Mail.Send Calendars.ReadWrite' });
      if (method === 'GET' && url.includes('/me?')) return json({ mail: 'owner@inveck.com', displayName: 'Owner' });
      if (method === 'POST' && url.endsWith('/me/events')) return json({ id: 'evt-9', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz' } }, 201);
      return json({}, 404);
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'MICROSOFT_TOKEN_ENCRYPTION_KEY']) delete process.env[k];
  });
  const withSlot = (name: string, email: string, ts: string) => {
    const h = [...HEAD, 'meeting_date', 'meeting_time'];
    return { h, r: [...R(name, email, { submitted_at: ts }), '2026-10-24', '15:00'] };
  };

  it('books it in the BDA\'s calendar with the sheet\'s confirmed time, once; a BDA not connected is reported and tried again later', async () => {
    const { h, r } = withSlot('Ravi', 'ravi@a.com', '2026-10-22T04:00:00Z');
    const src = async () => [h, r];
    const first = await syncInboundDemos(db, { source: src, now: NOW });
    expect(first.created).toBe(1);
    expect(first.meetings).toBe(0);
    expect(first.noMeeting[0].reason).toMatch(/Connect your Outlook/);
    expect((await db.select().from(leads))[0].status).toBe('Replied');
    expect(await db.select().from(leadMeetings)).toEqual([]);

    // The BDA connects Outlook; the next sync books it.
    const owner = (await db.select().from(leads))[0].ownerId!;
    const { connectMailbox } = await import('@/lib/mail/outlook');
    await connectMailbox(db, owner, 'code', 'https://x/cb');
    calls = [];
    const second = await syncInboundDemos(db, { source: src, now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(second).toMatchObject({ created: 0, meetings: 1 });
    const [m] = await db.select().from(leadMeetings);
    expect(m).toMatchObject({ title: 'Demo for Ravi Works - Inveck', attendeeEmail: 'ravi@a.com', graphEventId: 'evt-9', joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz', organizerId: owner });
    expect(m.startsAt.toISOString()).toBe('2026-10-24T09:30:00.000Z');
    expect((await db.select().from(leads))[0]).toMatchObject({ status: 'Meeting Booked', callFeedback: 'Demo scheduled' });
    expect((await db.select().from(inboundDemoRows))[0].state).toBe('meeting');
    // Running again makes no second meeting.
    await syncInboundDemos(db, { source: src, now: new Date(NOW.getTime() + 20 * 60_000) });
    expect(calls.filter((c) => c.startsWith('POST') && c.endsWith('/me/events'))).toHaveLength(1);
    expect(await db.select().from(leadMeetings)).toHaveLength(1);
  });

  it("books the slot the visitor chose on the form (preferred_start_utc), once, keyed by booking_id", async () => {
    const h = [...HEAD, 'booking_id', 'status', 'preferred_start_utc', 'preferred_start_ist', 'timezone'];
    const r = [...R('Ravi', 'ravi@a.com'), 'bk-1', 'slot_chosen', '2026-10-24T04:30:00.000Z', 'Sat 24 Oct 2026, 10:00 IST', 'Asia/Kolkata'];
    const src = async () => [h, r];
    await syncInboundDemos(db, { source: src, now: NOW });
    const owner = (await db.select().from(leads))[0].ownerId!;
    const { connectMailbox } = await import('@/lib/mail/outlook');
    await connectMailbox(db, owner, 'code', 'https://x/cb');
    const done = await syncInboundDemos(db, { source: src, now: new Date(NOW.getTime() + 600_000) });
    expect(done.meetings).toBe(1);
    const [m] = await db.select().from(leadMeetings);
    expect(m.startsAt.toISOString()).toBe('2026-10-24T04:30:00.000Z');
    expect((await db.select().from(leads))[0].status).toBe('Meeting Booked');
    // The same booking again, even with other details changed, makes nothing new.
    const again = await syncInboundDemos(db, { source: async () => [h, [...r.slice(0, 5), 'changed@a.com', ...r.slice(6)]], now: new Date(NOW.getTime() + 1_200_000) });
    expect(again.created).toBe(0);
    expect(await db.select().from(leadMeetings)).toHaveLength(1);
    expect(await db.select().from(leads)).toHaveLength(1);
  });

  it('a preferred time only is never turned into a meeting', async () => {
    const h = [...HEAD, 'preferred_time'];
    const r = [...R('Ravi', 'ravi@a.com'), 'Tuesday morning'];
    const rep = await syncInboundDemos(db, { source: async () => [h, r], now: NOW });
    expect(rep.noMeeting[0].reason).toMatch(/only has a preferred time/);
    expect(calls.some((c) => c.endsWith('/me/events'))).toBe(false);
    expect(await db.select().from(leadMeetings)).toEqual([]);
  });
});
