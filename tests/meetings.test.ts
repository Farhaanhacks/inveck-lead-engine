import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leadMeetings, leads, mailboxes, tasks, users } from '@/lib/db/schema';
import { istDay } from '@/lib/tasks';

const me = { id: 0, role: 'bda' as const, name: 'Puja', username: 'puja@inveck', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

const NOW = new Date('2026-10-20T04:30:00Z'); // 10:00 in India
type Call = { method: string; url: string; body: string };
let calls: Call[];
let grantScope: string;
let eventsMode: 'ok' | 'nolink' | 'forbidden' | 'hang';
let eventCount: number;
let liveRefresh: Set<string>;

async function fakeMicrosoft(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
  const method = init.method ?? 'GET';
  calls.push({ method, url, body });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/oauth2/v2.0/token')) {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') return json({ access_token: 'a1', refresh_token: 'refresh-1', scope: grantScope });
    if (!liveRefresh.has(p.get('refresh_token') ?? '')) return json({ error: 'invalid_grant' }, 400);
    liveRefresh.add('refresh-2');
    return json({ access_token: 'a2', refresh_token: 'refresh-2', scope: grantScope });
  }
  const path = url.replace('https://graph.microsoft.com/v1.0', '');
  if (method === 'GET' && path.startsWith('/me?')) return json({ mail: 'puja@inveck.com', displayName: 'Puja' });
  if (method === 'POST' && path === '/me/events') {
    if (eventsMode === 'hang') throw new DOMException('timeout', 'TimeoutError');
    if (eventsMode === 'forbidden') return json({ error: { message: 'Access is denied' } }, 403);
    eventCount++;
    return json(eventsMode === 'nolink' ? { id: 'evt-1' } : { id: 'evt-1', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } }, 201);
  }
  if (method === 'DELETE' && path.startsWith('/me/events/')) return new Response(null, { status: 204 });
  return json({ error: { message: `unexpected ${method} ${path}` } }, 404);
}

let db: Db;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  process.env.MICROSOFT_CLIENT_ID = 'cid';
  process.env.MICROSOFT_CLIENT_SECRET = 'secret-value';
  process.env.MICROSOFT_TENANT_ID = 'tenant';
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = 'a-long-random-test-key-0123456789-abcdef';
  resetDbForTests();
  db = await getDb();
  me.id = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
  calls = [];
  grantScope = 'openid email User.Read Mail.Send Calendars.ReadWrite';
  eventsMode = 'ok';
  eventCount = 0;
  liveRefresh = new Set(['refresh-1']);
  vi.stubGlobal('fetch', vi.fn(fakeMicrosoft));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'MICROSOFT_TOKEN_ENCRYPTION_KEY']) delete process.env[k];
});

const connect = async () => (await import('@/lib/mail/outlook')).connectMailbox(db, me.id, 'code', 'https://x/api/auth/microsoft/callback');
const lead = async (extra: Partial<typeof leads.$inferInsert> = {}) =>
  (await db.insert(leads).values({ company: 'Hosur Gears', segment: 'Manufacturing', status: 'Contacted', ownerId: me.id, contactName: 'Ravi Kumar', contactEmail: 'ravi@hosurgears.in', ...extra }).returning())[0];
const input = (l: typeof leads.$inferSelect, extra = {}) => ({ lead: l, taskId: 5, userId: me.id, title: 'Demo for Hosur Gears - Inveck', date: '2026-10-21', time: '15:00', minutes: 30, ...extra });
const schedule = async (l: typeof leads.$inferSelect, extra = {}) => (await import('@/lib/meetings')).scheduleMeeting(db, input(l, extra), NOW);

describe('scheduling a Teams meeting', () => {
  it('asks for calendar permission at sign-in, but never on a refresh (old connections keep working)', async () => {
    const { OUTLOOK_SCOPES } = await import('@/lib/mail/outlook');
    expect(OUTLOOK_SCOPES.split(' ')).toEqual(expect.arrayContaining(['Mail.Send', 'User.Read', 'Calendars.ReadWrite', 'offline_access']));
    await connect();
    expect(new URLSearchParams(calls.find((c) => c.url.includes('/token'))!.body).get('scope')).toContain('Calendars.ReadWrite');
    const l = await lead();
    calls = [];
    await schedule(l);
    expect(new URLSearchParams(calls[0].body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(calls[0].body).has('scope')).toBe(false);
  });

  it('creates a Teams event in the owner\'s calendar with the prospect as a required attendee, saves it, and logs it', async () => {
    await connect();
    const l = await lead();
    calls = [];
    const r = await schedule(l);
    expect(r.ok && r.already).toBe(false);
    const event = calls.filter((c) => c.url.endsWith('/me/events'));
    expect(event).toHaveLength(1);
    expect(JSON.parse(event[0].body)).toMatchObject({
      subject: 'Demo for Hosur Gears - Inveck',
      start: { dateTime: '2026-10-21T15:00:00', timeZone: 'India Standard Time' },
      end: { dateTime: '2026-10-21T15:30:00', timeZone: 'India Standard Time' },
      attendees: [{ emailAddress: { address: 'ravi@hosurgears.in', name: 'Ravi Kumar' }, type: 'required' }],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
    // The invitation is Microsoft's: nothing else is sent (no sendMail).
    expect(calls.some((c) => c.url.includes('sendMail'))).toBe(false);
    const [m] = await db.select().from(leadMeetings);
    expect(m).toMatchObject({ leadId: l.id, status: 'scheduled', title: 'Demo for Hosur Gears - Inveck', organizerId: me.id, organizerEmail: 'puja@inveck.com', attendeeEmail: 'ravi@hosurgears.in', graphEventId: 'evt-1', joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' });
    expect(m.startsAt.toISOString()).toBe('2026-10-21T09:30:00.000Z');
    const log = (await db.select().from(activities).where(eq(activities.leadId, l.id))).map((a) => a.text);
    expect(log.some((x) => x.startsWith('Teams meeting scheduled: “Demo for Hosur Gears - Inveck”') && x.includes('puja@inveck.com'))).toBe(true);
  });

  it('retrying never makes a second meeting', async () => {
    await connect();
    const l = await lead();
    await schedule(l);
    const again = await schedule(l);
    expect(again.ok && again.already).toBe(true);
    expect(eventCount).toBe(1);
    expect(await db.select().from(leadMeetings)).toHaveLength(1);
  });

  it('an unanswered request is held, then retried under the same transaction id', async () => {
    await connect();
    const l = await lead();
    eventsMode = 'hang';
    const first = await schedule(l);
    expect(!first.ok && first.error).toMatch(/trying again is safe/);
    const [held] = await db.select().from(leadMeetings);
    expect(held.status).toBe('creating');
    eventsMode = 'ok';
    const soon = await schedule(l);
    expect(!soon.ok && soon.error).toMatch(/already being created/);
    const later = await (await import('@/lib/meetings')).scheduleMeeting(db, input(l), new Date(NOW.getTime() + 3 * 60_000));
    expect(later.ok).toBe(true);
    const ids = calls.filter((c) => c.url.endsWith('/me/events')).map((c) => JSON.parse(c.body).transactionId);
    expect(new Set(ids).size).toBe(1);
    expect(await db.select().from(leadMeetings)).toHaveLength(1);
  });

  it('says plainly what is wrong, and records nothing: no email, no Outlook, no calendar consent, Graph refusing, no Teams link', async () => {
    const l = await lead();
    expect((await schedule(await lead({ contactEmail: '' }))).ok).toBe(false);
    expect(await schedule(l)).toMatchObject({ ok: false, error: expect.stringContaining('Connect your Outlook') });
    grantScope = 'openid email User.Read Mail.Send'; // connected before calendars existed
    await connect();
    expect(await schedule(l)).toMatchObject({ ok: false, error: expect.stringContaining('connect Outlook again') });
    grantScope = 'openid email User.Read Mail.Send Calendars.ReadWrite';
    await connect();
    eventsMode = 'forbidden';
    expect(await schedule(l)).toMatchObject({ ok: false, error: expect.stringContaining('Calendar access is needed') });
    eventsMode = 'nolink';
    calls = [];
    expect(await schedule(l)).toMatchObject({ ok: false, error: expect.stringContaining('no Teams link') });
    // The linkless event was taken back.
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/me/events/evt-1'))).toBe(true);
    expect(await db.select().from(leadMeetings)).toEqual([]);
    expect((await schedule(l, { time: '08:00', date: '2026-10-20' }))).toMatchObject({ ok: false, error: expect.stringContaining('already passed') });
  });

  it("only the lead's owner can schedule it", async () => {
    await connect();
    const other = (await db.select().from(users).where(eq(users.role, 'bda')))[1];
    const l = await lead({ ownerId: other.id });
    expect(await schedule(l)).toMatchObject({ ok: false, error: expect.stringContaining('belongs to') });
    expect(eventCount).toBe(0);
  });
});

describe('Approve and Schedule', () => {
  const callForm = (taskId: number, extra: Record<string, string> = {}) => {
    const f = new FormData();
    const v = { id: String(taskId), note: 'Spoke with the plant head.', feedback: 'Demo scheduled', outcome: 'connected', meetingTitle: 'Demo for Hosur Gears - Inveck', meetingDate: '2026-10-21', meetingTime: '15:00', meetingMinutes: '30', ...extra };
    for (const [k, x] of Object.entries(v)) f.set(k, x);
    return f;
  };
  const callTask = async (leadId: number) => (await db.insert(tasks).values({ leadId, ownerId: me.id, kind: 'call', step: 'Day 1', title: 'Day 1: call', dueDate: istDay(), slot: 'day' }).returning())[0];

  it('logs the call as Demo scheduled and moves the lead to Meeting Booked only after the meeting exists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      await connect();
      const l = await lead();
      const t = await callTask(l.id);
      const { scheduleMeetingAction } = await import('@/app/meeting-actions');
      // Graph refuses: the call is not logged and the lead does not move.
      eventsMode = 'forbidden';
      expect((await scheduleMeetingAction(callForm(t.id))).error).toContain('Calendar access is needed');
      expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
      expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].status).toBe('Contacted');
      // Approved and created.
      eventsMode = 'ok';
      expect(await scheduleMeetingAction(callForm(t.id))).toEqual({ error: '', done: true });
      expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0]).toMatchObject({ status: 'Meeting Booked', callFeedback: 'Demo scheduled' });
      expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0]).toMatchObject({ outcome: 'connected' });
      expect(eventCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a call cannot be saved as Demo scheduled without a meeting (the plain save is refused)', async () => {
    const l = await lead();
    const t = await callTask(l.id);
    const { completeTaskAction } = await import('@/app/team-actions');
    await completeTaskAction(callForm(t.id));
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].status).toBe('Contacted');
  });
});

describe('the meeting-day card', () => {
  it('lists only meetings on the date, in India time, for their organizer', async () => {
    const { meetingsOn } = await import('@/lib/meetings');
    const l = await lead();
    const mk = (startsAt: string, extra: Partial<typeof leadMeetings.$inferInsert> = {}) =>
      db.insert(leadMeetings).values({ leadId: l.id, requestKey: startsAt + (extra.organizerId ?? ''), title: 't', startsAt: new Date(startsAt), endsAt: new Date(new Date(startsAt).getTime() + 1_800_000), organizerId: me.id, attendeeEmail: 'a@b.com', joinUrl: 'https://teams.microsoft.com/x', status: 'scheduled', ...extra });
    await mk('2026-10-21T09:30:00Z'); // 3:00 pm on the 21st in India
    await mk('2026-10-21T19:00:00Z'); // 12:30 am on the 22nd in India
    await mk('2026-10-20T18:00:00Z'); // 11:30 pm on the 20th in India
    await mk('2026-10-21T10:00:00Z', { organizerId: me.id + 1 });
    await mk('2026-10-21T11:00:00Z', { status: 'creating' });
    expect((await meetingsOn(db, me.id, '2026-10-21')).map((m) => m.meeting.startsAt.toISOString())).toEqual(['2026-10-21T09:30:00.000Z']);
    expect((await meetingsOn(db, me.id, '2026-10-22')).map((m) => m.meeting.startsAt.toISOString())).toEqual(['2026-10-21T19:00:00.000Z']);
    expect(await meetingsOn(db, me.id, '2026-10-23')).toEqual([]);
    void and;
    void mailboxes;
  });
});
