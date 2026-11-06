import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { activities, leads, people, users } from '@/lib/db/schema';
import { leadAddresses } from '@/lib/mail/plan';
import { loadTracker } from '@/lib/tracker';

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

const form = (v: Record<string, string | number>) => Object.entries(v).reduce((f, [k, x]) => (f.set(k, String(x)), f), new FormData());
const mk = async () => {
  const [l] = await db.insert(leads).values({ company: 'ASSA ABLOY', segment: 'Manufacturing', status: 'Approved', ownerId: me.id, contactName: 'Narendra Pal Singh', contactTitle: 'Head - Operations', contactPhone: '7032368233', contactEmail: 'narendra.singh@assaabloy.com', contactLinkedin: 'https://in.linkedin.com/in/narendra' }).returning();
  await db.insert(people).values({ leadId: l.id, name: 'Narendra Pal Singh', email: 'narendra.singh@assaabloy.com', phone: '7032368233', isPrimary: true, source: 'x' });
  await db.insert(people).values({ leadId: l.id, name: 'Meera Joshi', email: 'meera@assaabloy.com', source: 'x' });
  return l;
};
const same = (l: Awaited<ReturnType<typeof mk>>, extra: Record<string, string> = {}) => ({ id: l.id, contactName: l.contactName, contactTitle: l.contactTitle, contactPhone: l.contactPhone, contactEmail: l.contactEmail, contactLinkedin: l.contactLinkedin, ...extra });
const lead = async (id: number) => (await db.select().from(leads).where(eq(leads.id, id)))[0];
const primary = async (id: number) => (await db.select().from(people).where(eq(people.leadId, id))).find((p) => p.isPrimary)!;

describe('the Email field in "Edit point of contact"', () => {
  it('saves the new email on the lead and the contact together, and every reader sees it', async () => {
    const { saveContactFormAction } = await import('@/app/team-actions');
    const l = await mk();
    const r = await saveContactFormAction({ error: '' }, form(same(l, { contactEmail: '  Narendra.New@AssaAbloy.com ' })));
    expect(r).toEqual({ error: '', saved: true });
    expect((await lead(l.id)).contactEmail).toBe('narendra.new@assaabloy.com');
    expect((await primary(l.id)).email).toBe('narendra.new@assaabloy.com');
    // Email sending, the Tracker and the lead page read the lead's one field.
    expect(leadAddresses(await lead(l.id), await db.select({ name: people.name, email: people.email }).from(people).where(eq(people.leadId, l.id)))[0]).toBe('narendra.new@assaabloy.com');
    expect((await loadTracker(db, me.id)).find((t) => t.lead.id === l.id)?.lead.contactEmail).toBe('narendra.new@assaabloy.com');
    expect((await db.select().from(activities).where(eq(activities.leadId, l.id))).some((a) => a.text.includes('email') && a.text.includes('narendra.new@assaabloy.com'))).toBe(true);
  });

  it('with several contacts only the main contact changes; the others keep their own emails', async () => {
    const { saveContactFormAction } = await import('@/app/team-actions');
    const l = await mk();
    await saveContactFormAction({ error: '' }, form(same(l, { contactEmail: 'main.new@assaabloy.com' })));
    const rows = await db.select().from(people).where(eq(people.leadId, l.id));
    expect(rows.find((p) => p.name === 'Meera Joshi')?.email).toBe('meera@assaabloy.com');
    expect(rows.find((p) => p.isPrimary)?.email).toBe('main.new@assaabloy.com');
  });

  it('editing other fields keeps the email (the field is filled in with it); only emptying the field removes it', async () => {
    const { saveContactFormAction } = await import('@/app/team-actions');
    const l = await mk();
    await saveContactFormAction({ error: '' }, form(same(l, { contactPhone: '9000000001', contactTitle: 'Plant Manager' })));
    expect(await lead(l.id)).toMatchObject({ contactPhone: '9000000001', contactTitle: 'Plant Manager', contactEmail: 'narendra.singh@assaabloy.com' });
    expect((await primary(l.id)).email).toBe('narendra.singh@assaabloy.com');
    // A form that has no email field at all (an older caller) leaves it too.
    const noField = same(l, { contactPhone: '9000000002' });
    delete (noField as Record<string, unknown>).contactEmail;
    await saveContactFormAction({ error: '' }, form(noField));
    expect((await lead(l.id)).contactEmail).toBe('narendra.singh@assaabloy.com');
    // Emptied on purpose: removed, from the lead and the contact.
    await saveContactFormAction({ error: '' }, form(same(l, { contactEmail: '' })));
    expect((await lead(l.id)).contactEmail).toBe('');
    expect((await primary(l.id)).email).toBe('');
  });

  it('refuses an email that is not one, with a message, and saves nothing from that form', async () => {
    const { saveContactFormAction } = await import('@/app/team-actions');
    const l = await mk();
    for (const bad of ['not-an-email', 'a@b', 'one@x.com, two@x.com', 'with space@x.com']) {
      const r = await saveContactFormAction({ error: '' }, form(same(l, { contactEmail: bad, contactPhone: '9111111111' })));
      expect(r.error).toMatch(/email address is not valid/);
      expect(r.saved).toBeUndefined();
    }
    expect(await lead(l.id)).toMatchObject({ contactEmail: 'narendra.singh@assaabloy.com', contactPhone: '7032368233' });
  });

  it("someone else's company is refused", async () => {
    const { saveContactFormAction } = await import('@/app/team-actions');
    const [theirs] = await db.insert(leads).values({ company: 'Theirs', segment: 'Manufacturing', status: 'Approved', ownerId: me.id + 1, contactName: 'X', contactEmail: 'x@t.com' }).returning();
    const r = await saveContactFormAction({ error: '' }, form({ id: theirs.id, contactName: 'X', contactEmail: 'changed@t.com' }));
    expect(r.error).toMatch(/Only the person this company belongs to/);
    expect((await lead(theirs.id)).contactEmail).toBe('x@t.com');
  });
});
