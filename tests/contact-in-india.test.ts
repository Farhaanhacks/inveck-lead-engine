import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, people, users } from '@/lib/db/schema';
import { EMPTY_CONTACT, type Candidate } from '@/lib/pipeline/contacts';
import { shownInIndia, vetPick } from '@/lib/pipeline/process-lead';
import { recheckUnplacedContacts } from '@/lib/escalate';
import type { Services } from '@/lib/pipeline/services';
import { settingsSchema } from '@/lib/settings';
import { DEFAULT_ICPS } from '@/lib/db/seed';

/**
 * The main contact is someone shown to be in India (29 Oct 2026): Joey Williams, a warehouse manager in Rockmart,
 * Georgia, United States, whose search result showed no location, had been made the contact for a US company.
 */

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const company = 'Nordic Logistics and Warehousing, LLC';
const joeyProfile = { title: `Joey Williams - Warehouse Manager - ${company} | LinkedIn`, subtitle: `Rockmart, Georgia, United States · Warehouse Manager · ${company}`, link: 'https://www.linkedin.com/in/joey-williams-1234', snippet: '' };

function services(searched: string[]): Services {
  const fetchFn = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    const q = String(JSON.parse(String(init.body)).q);
    searched.push(q);
    return json({ organic: q.includes('"Joey Williams"') ? [joeyProfile] : [] });
  }) as typeof fetch;
  return { fetch: fetchFn, keys: { deepseek: '', anthropic: '', serper: 'serper-test', jina: '' }, settings: settingsSchema.parse({}) };
}

const candidate = (name: string, title: string, location = ''): Candidate => ({ id: name, source: 'LinkedIn', name, title, email: '', phone: '', linkedin: `https://in.linkedin.com/in/${name.toLowerCase().replace(/ /g, '-')}`, snippet: '', location });
const firstOf = async (list: Candidate[]) => ({
  contact: list[0] ? { ...EMPTY_CONTACT, name: list[0].name, title: list[0].title, linkedin: list[0].linkedin } : { ...EMPTY_CONTACT },
  notes: [] as string[],
  error: '',
  ranked: list,
});

describe('the main contact is shown to be in India', () => {
  it('a location shown, not abroad', () => {
    expect(shownInIndia({ location: 'Pune, Maharashtra, India' })).toBe(true);
    expect(shownInIndia({ location: '', jobLocation: 'Chakan, Maharashtra' })).toBe(true);
    expect(shownInIndia({ location: 'Rockmart, Georgia, United States' })).toBe(false);
    expect(shownInIndia({ location: '' })).toBe(false);
  });

  it("someone the search showed no location for is looked up, and one based abroad isn't the contact", async () => {
    const searched: string[] = [];
    const notes: string[] = [];
    const joey = candidate('Joey Williams', 'Warehouse Manager');
    const r = await vetPick(services(searched), { company, city: '' }, [joey], [{ name: 'Joey Williams', title: 'Warehouse Manager', location: '' }], firstOf, notes, DEFAULT_ICPS[1]);
    expect(searched.some((q) => q.includes('"Joey Williams"'))).toBe(true);
    expect(r.picked.contact.name).toBe('');
    expect(notes.join(' ')).toMatch(/Joey Williams left out/);
    // Someone the search showed in India: no look-up needed.
    searched.length = 0;
    const ravi = candidate('Ravi Kumar', 'Warehouse Manager', 'Bhiwandi, Maharashtra, India');
    const ok = await vetPick(services(searched), { company: 'Swift Warehousing', city: '' }, [ravi], [{ name: 'Ravi Kumar', title: 'Warehouse Manager', location: 'Bhiwandi, Maharashtra, India' }], firstOf, [], DEFAULT_ICPS[1]);
    expect(ok).toMatchObject({ verified: true });
    expect(ok.picked.contact.name).toBe('Ravi Kumar');
    expect(searched).toEqual([]);
  });
});

describe('leads given out with a contact never placed (29 Oct, once)', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
  });

  it('are checked again on LinkedIn; those with a location on file, and CA firms, are left alone', async () => {
    const [owner] = await db.select().from(users).where(eq(users.role, 'bda')).limit(1);
    const confirmed = new Date();
    const [nordic, placed, ca] = await db
      .insert(leads)
      .values([
        { company, segment: '3PL & Logistics', status: 'Contacted', ownerId: owner.id, contactName: 'Joey Williams', contactTitle: 'Warehouse Manager', contactVerifiedAt: confirmed, contactCheckedAt: confirmed },
        { company: 'Forgeline Components', segment: 'Manufacturing', status: 'Approved', ownerId: owner.id, contactName: 'Rahul Patil', contactTitle: 'Plant Head', contactVerifiedAt: confirmed, contactCheckedAt: confirmed },
        { company: 'Kirtane & Pandit', segment: 'CA Firms', status: 'Approved', ownerId: owner.id, contactName: 'Partner', contactVerifiedAt: confirmed, contactCheckedAt: confirmed },
      ])
      .returning();
    await db.insert(people).values([
      { leadId: nordic.id, name: 'Joey Williams', title: 'Warehouse Manager', isPrimary: true },
      { leadId: placed.id, name: 'Rahul Patil', title: 'Plant Head', location: 'Pune, Maharashtra, India', isPrimary: true },
      { leadId: ca.id, name: 'Partner', title: 'Partner', isPrimary: true },
    ]);
    expect(await recheckUnplacedContacts(db)).toEqual([nordic.id]);
    const rows = await db.select().from(leads);
    expect(rows.find((l) => l.id === nordic.id)).toMatchObject({ contactVerifiedAt: null, contactCheckedAt: null });
    for (const id of [placed.id, ca.id]) expect(rows.find((l) => l.id === id)?.contactVerifiedAt).not.toBeNull();
    expect((await db.select().from(people).where(and(eq(people.leadId, nordic.id), eq(people.isPrimary, true))))[0].name).toBe('Joey Williams');
  });
});
