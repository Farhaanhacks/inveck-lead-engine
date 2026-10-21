import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, sheetFirms, tasks, users } from '@/lib/db/schema';
import { KnownBranches } from '@/lib/branches';
import { importContactSheet } from '@/lib/contact-import';
import { approveSheetLeadsOnce } from '@/lib/ca-sheet';
import { ensureSequences, isFirstContact, loadTodayTasks, istDay } from '@/lib/tasks';
import { tidyContacts, verifyContacts } from '@/lib/verify-contacts';

let db: Db;
let owner: number;
beforeEach(async () => {
  process.env.DATABASE_URL = 'memory://';
  resetDbForTests();
  db = await getDb();
  owner = (await db.select().from(users).where(eq(users.role, 'bda')).limit(1))[0].id;
});

const firm = { company: 'Mehta & Co', website: '', city: 'Pune', phones: ['9822012345'], emails: [], people: [], remark: 'Services: audit' };
const importFirm = async (status?: 'Approved') => {
  const r = await importContactSheet(db, [firm], { segment: 'CA Firms', ownerId: owner, known: new KnownBranches([], []), by: 'the Google Sheet', ...(status ? { status } : {}) });
  return r.ids[0];
};

describe('CA firms from the database', () => {
  it('start Approved with only what the sheet had: nothing is invented for a blank field', async () => {
    const id = await importFirm('Approved');
    const [l] = await db.select().from(leads).where(eq(leads.id, id));
    expect(l).toMatchObject({ status: 'Approved', contactName: '', contactTitle: '', contactEmail: '', contactLinkedin: '', contactPhone: '9822012345', city: 'Pune' });
  });

  it('show on Today as fresh leads (a LinkedIn request first) even with no person named, and stay Approved', async () => {
    const id = await importFirm('Approved');
    await ensureSequences(db, istDay());
    await db.update(tasks).set({ dueDate: istDay() }).where(eq(tasks.leadId, id));
    const items = await loadTodayTasks(db, owner, istDay());
    expect(items.map((i) => [i.lead.id, i.task.kind, i.task.step])).toEqual([[id, 'linkedin', 'Day 1']]);
    expect(items.every((i) => isFirstContact(i.task))).toBe(true);
    // A contact change never sends it back to waiting for a person, and no find-a-contact step appears.
    await ensureSequences(db, istDay());
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('Approved');
    expect((await db.select().from(tasks).where(eq(tasks.leadId, id))).some((t) => t.step === 'Find the next person')).toBe(false);
  });

  it('are never looked up or tidied: no contact search runs for them', async () => {
    const id = await importFirm('Approved');
    const searched: string[] = [];
    const svc = { fetch: (async (url: string, init?: RequestInit) => { searched.push(String(init?.body ?? url)); return new Response(JSON.stringify({ organic: [] }), { status: 200 }); }) as typeof fetch, keys: { serper: 'k' }, settings: (await import('@/lib/settings')).settingsSchema.parse({}) } as never;
    await verifyContacts(db, svc, { limit: 50 });
    expect(searched.join(' ')).not.toContain('Mehta');
    expect(await tidyContacts(db, {})).not.toContain(id);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].contactCheckedAt).toBeNull();
  });

  it('firms taken before this rule are approved once, and only sheet firms', async () => {
    const id = await importFirm();
    const { settings } = await import('@/lib/db/schema');
    await db.delete(settings).where(eq(settings.key, 'caApprovedV1'));
    const [sheet] = [{ sourceKey: 'icai:1', company: 'Mehta & Co', ownerId: owner, leadId: id, assignedOn: istDay() }];
    await db.insert(sheetFirms).values(sheet);
    const manual = (await db.insert(leads).values({ company: 'Hand Added CA', segment: 'CA Firms', status: 'New', ownerId: owner }).returning())[0];
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('New');
    await approveSheetLeadsOnce(db);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('Approved');
    expect((await db.select().from(leads).where(eq(leads.id, manual.id)))[0].status).toBe('New');
    // Once only: a lead moved on later isn't pulled back to Approved.
    await db.update(leads).set({ status: 'Contacted' }).where(eq(leads.id, id));
    await approveSheetLeadsOnce(db);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].status).toBe('Contacted');
    expect(await db.select().from(tasks).where(and(eq(tasks.leadId, id), isNull(tasks.doneAt)))).toBeDefined();
  });
});

describe('the one lookup: a CA firm\'s LinkedIn page', () => {
  const page = (title: string, slug: string, snippet = 'Chartered Accountants firm in Pune') => ({ title, link: `https://in.linkedin.com/company/${slug}`, snippet });

  it('takes a page only when it carries the firm\'s own words and is a CA firm (or in its town)', async () => {
    const { pickFirmPage, distinctiveWords } = await import('@/lib/ca-linkedin');
    expect(distinctiveWords('Mehta & Associates, Chartered Accountants')).toEqual(['mehta']);
    expect(pickFirmPage('Mehta & Co', 'Pune', [page('Mehta Traders | LinkedIn', 'mehta-traders', 'Wholesale grain'), page('Mehta & Co | LinkedIn', 'mehta-and-co')])).toBe('https://www.linkedin.com/company/mehta-and-co');
    expect(pickFirmPage('Mehta & Co', 'Pune', [page('Other Firm | LinkedIn', 'other-firm')])).toBe('');
    expect(pickFirmPage('Chartered Accountants', 'Pune', [page('Anyone | LinkedIn', 'anyone')])).toBe('');
  });

  it('looks each firm up once, saves only the page, and searches for nothing else', async () => {
    const { findCaFirmLinkedin } = await import('@/lib/ca-linkedin');
    const id = await importFirm('Approved');
    const queries: string[] = [];
    const svc = {
      fetch: (async (_u: string, init?: RequestInit) => {
        queries.push(JSON.parse(String(init?.body)).q);
        return new Response(JSON.stringify({ organic: [{ title: 'Mehta & Co | LinkedIn', link: 'https://in.linkedin.com/company/mehta-and-co', snippet: 'Chartered Accountants, Pune' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
      keys: { serper: 'k' },
      settings: (await import('@/lib/settings')).settingsSchema.parse({}),
    } as never;
    expect(await findCaFirmLinkedin(db, svc, { ownerId: owner })).toBe(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('site:linkedin.com/company');
    const [l] = await db.select().from(leads).where(eq(leads.id, id));
    expect(l).toMatchObject({ contactLinkedin: 'https://www.linkedin.com/company/mehta-and-co', contactName: '', contactEmail: '', contactPhone: '9822012345' });
    // Once only: a second visit searches nothing.
    expect(await findCaFirmLinkedin(db, svc, { ownerId: owner })).toBe(0);
    expect(queries).toHaveLength(1);
  });

  it('a firm with no page found is left blank and not searched again; other segments are never touched', async () => {
    const { findCaFirmLinkedin } = await import('@/lib/ca-linkedin');
    const id = await importFirm('Approved');
    const mfg = (await db.insert(leads).values({ company: 'Gears Ltd', segment: 'Manufacturing', status: 'Approved', ownerId: owner }).returning())[0];
    let calls = 0;
    const svc = { fetch: (async () => { calls++; return new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch, keys: { serper: 'k' }, settings: (await import('@/lib/settings')).settingsSchema.parse({}) } as never;
    expect(await findCaFirmLinkedin(db, svc)).toBe(0);
    expect(calls).toBe(1);
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0]).toMatchObject({ contactLinkedin: '' });
    expect((await db.select().from(leads).where(eq(leads.id, id)))[0].contactCheckedAt).not.toBeNull();
    expect((await db.select().from(leads).where(eq(leads.id, mfg.id)))[0].contactCheckedAt).toBeNull();
    await findCaFirmLinkedin(db, svc);
    expect(calls).toBe(1);
  });
});
