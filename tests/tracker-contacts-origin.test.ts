import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, people, users } from '@/lib/db/schema';
import { loadTracker } from '@/lib/tracker';
import { originOf } from '@/lib/lead-origin';
import { IMPORTED_SOURCE, parseContactSheet } from '@/lib/contact-import';
import { INBOUND_SOURCE } from '@/lib/inbound-source';
import { parseCsv } from '@/lib/csv';
import { updateTrackerContactFieldAction } from '@/app/team-actions';

const me = { id: 0, role: 'admin' as const, name: 'Admin', username: 'admin', mustChangePassword: false };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me, requireSessionUser: async () => me }));

describe('the sample import file', () => {
  it('is read by the importer: companies, several people at one, numbers and emails', () => {
    const parsed = parseContactSheet(parseCsv(readFileSync('public/inveck-lead-import-sample.csv', 'utf8')));
    expect(parsed.error).toBe('');
    expect(parsed.rows.map((r) => r.company)).toEqual(['Sample Auto Components Pvt Ltd', 'Sample Logistics Ltd']);
    expect(parsed.rows[0].people.map((p) => p.name)).toEqual(['Asha Rao', 'Vikram Shah']);
    expect(parsed.rows[0].people.every((p) => p.linkedin)).toBe(true);
    expect(parsed.rows[1].phones).toHaveLength(2);
    expect(parsed.rows[1].emails).toEqual(['ops@samplelogistics.com']);
  });
});

describe('where a lead came from', () => {
  it('hand-added and uploaded companies are Manual research, inbound ones Inbound, everything else System data', () => {
    expect(originOf({ source: 'Added by hand', inbound: false })).toBe('Manual research');
    expect(originOf({ source: IMPORTED_SOURCE, inbound: false })).toBe('Manual research');
    expect(originOf({ source: INBOUND_SOURCE, inbound: true })).toBe('Inbound');
    expect(originOf({ source: 'Inbound lead', inbound: true })).toBe('Inbound');
    expect(originOf({ source: '', inbound: false })).toBe('System data');
    expect(originOf({ source: 'anything else', inbound: false })).toBe('System data');
  });
});

describe('several contacts at one company, each tracked on their own', () => {
  let db: Db;
  let leadId: number;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
    me.id = (await db.insert(users).values({ username: 'admin', name: 'Admin', role: 'admin', passwordHash: 'x' }).onConflictDoUpdate({ target: users.username, set: { name: 'Admin' } }).returning())[0].id;
    leadId = (await db.insert(leads).values({ company: 'Acme', segment: 'Manufacturing', status: 'Contacted', ownerId: me.id, contactName: 'Main Person' }).returning())[0].id;
    await db.insert(people).values([
      { leadId, name: 'Main Person', isPrimary: true, source: 'Sales team' },
      { leadId, name: 'Second Person', source: 'Added by the team' },
      { leadId, name: 'Third Person', source: 'Added by the team' },
      { leadId, name: 'Other number', phone: '9999999999', source: 'Added by the team' },
      { leadId, name: 'Found by research', source: 'LinkedIn' },
    ]);
  });

  it('the tracker lists the people the team added, not numbers kept for the company or people research found', async () => {
    const [row] = await loadTracker(db, null);
    expect(row.contacts.map((p) => p.name)).toEqual(['Second Person', 'Third Person']);
  });

  it('a status saved for one contact changes only that contact', async () => {
    const [second, third] = (await db.select().from(people).where(eq(people.leadId, leadId))).filter((p) => p.name.endsWith('Person') && !p.isPrimary);
    expect(await updateTrackerContactFieldAction(second.id, 'callStatus', 'Connected')).toEqual({ ok: true });
    expect(await updateTrackerContactFieldAction(second.id, 'remark', 'Call after Diwali')).toEqual({ ok: true });
    const [row] = await loadTracker(db, null);
    const by = Object.fromEntries(row.contacts.map((p) => [p.name, p]));
    expect(by['Second Person']).toMatchObject({ callStatus: 'Connected', remark: 'Call after Diwali' });
    expect(by['Third Person']).toMatchObject({ callStatus: '', remark: '' });
    expect(row.lead.callStatus).toBe('');
    expect(third.id).not.toBe(second.id);
  });

  it('refuses a value that is not one of the options, a field that is not a contact one, and the main contact', async () => {
    const [second] = (await db.select().from(people).where(eq(people.name, 'Second Person')));
    const [main] = (await db.select().from(people).where(eq(people.name, 'Main Person')));
    expect((await updateTrackerContactFieldAction(second.id, 'callStatus', 'nonsense')).ok).toBe(false);
    expect((await updateTrackerContactFieldAction(second.id, 'contactChannel', 'Phone')).ok).toBe(false);
    expect((await updateTrackerContactFieldAction(main.id, 'remark', 'x')).ok).toBe(false);
  });
});
