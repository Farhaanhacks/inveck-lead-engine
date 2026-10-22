import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, inboundDemoRows, leadMeetings, leads, tasks, users } from '@/lib/db/schema';
import { filterRows, inboundCounts, loadInbound, logInboundActivity, monthKey, monthsOf, setInboundStatus, sourceKind, statusLabel } from '@/lib/inbound-leads';
import { INBOUND_SOURCE } from '@/lib/inbound-source';
import { loadFunnel } from '@/lib/followups';
import { loadTracker } from '@/lib/tracker';
import { istDay } from '@/lib/tasks';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const me = { id: 0, role: 'admin' as 'admin' | 'bda', name: 'Admin' };
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

let db: Db;
let owner: number;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  owner = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
  me.role = 'admin';
  n = 0;
});

let n = 0;
const make = async (raw: Record<string, string>, submitted: string, opts: { meeting?: boolean; status?: 'Replied' | 'Contacted' | 'Meeting Booked' } = {}) => {
  n++;
  const [l] = await db.insert(leads).values({ company: `Co ${n}`, segment: 'Manufacturing', status: opts.status ?? 'Replied', inbound: true, source: INBOUND_SOURCE, ownerId: owner, contactName: `Person ${n}`, contactEmail: `p${n}@x.com` }).returning();
  await db.insert(inboundDemoRows).values({ rowKey: `k${n}`, submittedAt: new Date(submitted), email: `p${n}@x.com`, leadId: l.id, ownerId: owner, state: opts.meeting ? 'meeting' : 'imported', raw: { name: l.contactName, email: l.contactEmail, ...raw } });
  if (opts.meeting) await db.insert(leadMeetings).values({ leadId: l.id, requestKey: `m${n}`, title: 't', startsAt: new Date('2026-11-01T05:00:00Z'), endsAt: new Date('2026-11-01T05:30:00Z'), organizerId: owner, attendeeEmail: l.contactEmail, joinUrl: 'https://teams.microsoft.com/x', status: 'scheduled' });
  return l;
};

describe('Website or LinkedIn, from the sheet', () => {
  it('reads the UTM and source fields, and keeps the originals', () => {
    expect(sourceKind({ utm_source: 'linkedin', utm_medium: 'paid' })).toBe('linkedin');
    expect(sourceKind({ utm_source: 'LinkedIn' })).toBe('linkedin');
    expect(sourceKind({ source: 'LinkedIn post' })).toBe('linkedin');
    expect(sourceKind({ li_fat_id: 'abc' })).toBe('linkedin');
    expect(sourceKind({ source: 'Google Search', utm_source: 'google' })).toBe('website');
    expect(sourceKind({})).toBe('website');
  });
});

describe('the Inbound leads list and cards', () => {
  const seed = async () => {
    await make({ utm_source: 'linkedin' }, '2026-10-05T04:00:00Z', { meeting: true, status: 'Meeting Booked' });
    await make({ source: 'Google Search' }, '2026-10-20T04:00:00Z');
    await make({ utm_source: 'linkedin' }, '2026-11-02T04:00:00Z');
    await make({ source: 'Blog' }, '2026-11-03T04:00:00Z', { meeting: true, status: 'Meeting Booked' });
    const r = await loadInbound(db);
    await logInboundActivity(db, r.find((x) => x.lead.company === 'Co 2')!.id, 'response', 'Replied asking for pricing', 'Admin');
    return loadInbound(db);
  };

  it('counts total, Website, LinkedIn, meetings and responses', async () => {
    const rows = await seed();
    expect(inboundCounts(rows)).toEqual({ total: 4, website: 2, linkedin: 2, meetings: 2, responded: 1 });
    expect(monthsOf(rows)).toEqual(['2026-11', '2026-10']);
  });

  it('the month is a calendar month and year, not a date, and works with the source filter; the cards follow', async () => {
    const rows = await seed();
    expect(inboundCounts(filterRows(rows, { month: '2026-10' }))).toMatchObject({ total: 2, website: 1, linkedin: 1 });
    expect(inboundCounts(filterRows(rows, { month: '2026-11' }))).toMatchObject({ total: 2, meetings: 1 });
    expect(inboundCounts(filterRows(rows, { source: 'linkedin' }))).toMatchObject({ total: 2, website: 0, linkedin: 2 });
    const both = filterRows(rows, { source: 'linkedin', month: '2026-11' });
    expect(both.map((r) => r.lead.company)).toEqual(['Co 3']);
    expect(inboundCounts(both)).toEqual({ total: 1, website: 0, linkedin: 1, meetings: 0, responded: 0 });
    expect(filterRows(rows, {})).toHaveLength(4);
  });

  it('an India month boundary: a late-evening UTC time on the last day belongs to the next month in India', () => {
    expect(monthKey(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11');
    expect(monthKey(new Date('2026-10-31T17:00:00Z'))).toBe('2026-10');
  });

  it('says Meeting scheduled only when there is a meeting', async () => {
    const rows = await seed();
    expect(rows.map((r) => [r.lead.company, statusLabel(r)])).toEqual([['Co 4', 'Meeting scheduled'], ['Co 3', 'Awaiting meeting'], ['Co 2', 'Awaiting meeting'], ['Co 1', 'Meeting scheduled']]);
  });

  it('logs responses and follow-ups to the history, and updates the status, only for inbound leads', async () => {
    const l = await make({}, '2026-10-05T04:00:00Z');
    expect((await logInboundActivity(db, l.id, 'follow_up_sent', 'Sent the case study', 'Admin')).ok).toBe(true);
    expect((await logInboundActivity(db, l.id, 'response', '', 'Admin')).ok).toBe(false);
    expect((await logInboundActivity(db, l.id, 'liked', 'x', 'Admin')).ok).toBe(false);
    expect((await db.select().from(activities).where(eq(activities.leadId, l.id))).some((a) => a.kind === 'follow_up_sent' && a.text.includes('case study'))).toBe(true);
    expect((await setInboundStatus(db, l.id, 'Won', 'Admin')).ok).toBe(true);
    expect((await setInboundStatus(db, l.id, 'Meeting Booked', 'Admin')).ok).toBe(false);
    expect((await db.select().from(leads).where(eq(leads.id, l.id)))[0].status).toBe('Won');
    const prospect = (await db.insert(leads).values({ company: 'Cold Co', segment: 'Manufacturing', ownerId: owner }).returning())[0];
    expect((await logInboundActivity(db, prospect.id, 'note', 'x', 'Admin')).ok).toBe(false);
    expect((await setInboundStatus(db, prospect.id, 'Won', 'Admin')).ok).toBe(false);
  });
});

describe('kept apart from prospecting leads', () => {
  it('inbound leads never appear in the follow-up funnel or the tracker, and nothing existing is reclassified', async () => {
    const inbound = await make({}, '2026-10-05T04:00:00Z', { status: 'Contacted' });
    const cold = (await db.insert(leads).values({ company: 'Cold Co', segment: 'Manufacturing', status: 'Contacted', ownerId: owner, followUpStartedOn: istDay() }).returning())[0];
    for (const l of [inbound, cold]) await db.insert(tasks).values({ leadId: l.id, ownerId: owner, kind: 'call', step: 'Follow-up 1', title: 'f', followUpRound: 1, dueDate: istDay() });
    expect((await loadFunnel(db, owner)).map((c) => c.lead.company)).toEqual(['Cold Co']);
    expect((await loadTracker(db, owner)).map((t) => t.lead.company)).toEqual(['Cold Co']);
    // The existing lead was not touched or made inbound.
    expect((await db.select().from(leads).where(eq(leads.id, cold.id)))[0]).toMatchObject({ inbound: false, source: '' });
    expect((await loadInbound(db)).map((r) => r.lead.company)).toEqual([inbound.company]);
  });
});

describe('the automatic sync', () => {
  it('is a daily scheduled job (the most a Vercel Hobby plan allows), plus Today syncing at most every five minutes', () => {
    const crons = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] }).crons;
    const mine = crons.filter((c) => c.path === '/api/cron/inbound-demos');
    expect(mine).toHaveLength(1);
    // Hobby plans reject anything that runs more than once a day, and the deploy fails: minute and hour are fixed numbers.
    expect(mine[0].schedule).toMatch(/^\d+ \d+ \* \* \S+$/);
    const today = readFileSync('src/app/(app)/today/page.tsx', 'utf8');
    expect(today).toContain('const INBOUND_SYNC_EVERY = 5 * 60 * 1000;');
    expect(today).toContain("atMostEvery('inbound-demo-sync', INBOUND_SYNC_EVERY");
    // The route is secured like the other scheduled routes.
    expect(readFileSync('src/app/api/cron/inbound-demos/route.ts', 'utf8')).toContain('Bearer ${await runSecret()}');
  });
});

describe('the outside timer', () => {
  it('can start the sync with its own secret, and nothing else works', async () => {
    process.env.DATABASE_URL = 'memory://';
    process.env.CRON_SECRET = 'vercel-cron-secret-value';
    process.env.INBOUND_SYNC_SECRET = 'outside-timer-secret-0123456789';
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    const { GET } = await import('@/app/api/cron/inbound-demos/route');
    const call = (auth?: string) => GET(new Request('https://x/api/cron/inbound-demos', { headers: auth ? { authorization: auth } : {} }));
    expect((await call()).status).toBe(403);
    expect((await call('Bearer wrong')).status).toBe(403);
    expect((await call('Bearer outside-timer-secret-0123456789')).status).toBe(200);
    expect((await call('Bearer vercel-cron-secret-value')).status).toBe(200);
    // Too short a timer secret is never accepted.
    process.env.INBOUND_SYNC_SECRET = 'short';
    expect((await call('Bearer short')).status).toBe(403);
    delete process.env.INBOUND_SYNC_SECRET;
    delete process.env.CRON_SECRET;
  });
});
