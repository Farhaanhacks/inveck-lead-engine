import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, tasks, users } from '@/lib/db/schema';
import { buildWhatsApp, contactFirstName, templateFor, whatsAppDigits } from '@/lib/whatsapp-outreach';
import { istDay } from '@/lib/tasks';

const me = { id: 0, role: 'bda' as const, name: 'Puja' };
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/users', async (orig) => ({ ...(await orig<typeof import('@/lib/users')>()), requireUser: async () => me, getCurrentUser: async () => me }));

const L = { segment: 'Manufacturing', company: 'Acme Forge', contactName: 'Ravi Shah', contactPhone: '98765 43210' };

describe('which template', () => {
  it('follows the segment, and never guesses', () => {
    expect(templateFor('Manufacturing')).toBe('manufacturing');
    expect(templateFor('3PL & Logistics')).toBe('3pl');
    expect(templateFor('3PL & Warehousing')).toBe('3pl');
    expect(templateFor('CA Firms')).toBe('ca');
    expect(templateFor('Retail')).toBeNull();
    expect(templateFor('')).toBeNull();
  });
  it('says plainly when the segment has none', () => {
    const r = buildWhatsApp({ ...L, segment: 'Retail' }, 'Puja');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('Retail');
  });
});

describe('the numbers', () => {
  it('turns any Indian writing into 91 + 10 digits, once', () => {
    for (const p of ['9876543210', '09876543210', '91 98765 43210', '+91-98765-43210', '(+91) 98765 43210', '919876543210', '098765 43210'])
      expect(whatsAppDigits(p)).toBe('919876543210');
  });
  it('turns away what cannot be a mobile', () => {
    for (const p of ['', '12345', '5876543210', '22 2222 3333', 'n/a']) expect(whatsAppDigits(p)).toBe('');
    expect(whatsAppDigits('+44 7911 123456')).toBe('447911123456');
  });
  it('uses the first number when several are saved', () => {
    expect(whatsAppDigits('98450 12345, 98765 43210')).toBe('919845012345');
  });
  it('no valid number: no link, with the reason', () => {
    const r = buildWhatsApp({ ...L, contactPhone: '12345' }, 'Puja');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('valid WhatsApp number');
  });
});

describe('the messages', () => {
  it('Manufacturing: name, BDA and the fixed wording', () => {
    const r = buildWhatsApp(L, 'Puja');
    expect(r.ok && r.text.split('\n\n')).toEqual([
      'Hi Ravi Sir, Puja this side from Inveck. I tried reaching you regarding the physical stock counting process at your organization.',
      'A quick question — when physical inventory verification happens across your plants or warehouses, is your team still using count sheets, Excel, and manual consolidation?',
      'Inveck helps manufacturing teams digitize this workflow — physical verification → real-time data → variance reporting → reconciliation, reducing paperwork and manual consolidation.',
      'I’m sharing our product profile. Would be glad to understand how your team currently handles inventory verification.',
    ]);
    expect(r.ok && r.url).toBe(`https://wa.me/919876543210?text=${encodeURIComponent(r.ok ? r.text : '')}`);
  });
  it('3PL: adds the saved company name', () => {
    const r = buildWhatsApp({ ...L, segment: '3PL & Logistics', company: 'Swift Cargo' }, 'Anuradha');
    expect(r.ok && r.text.startsWith('Hi Ravi Sir, Anuradha this side from Inveck. I tried reaching you regarding the inventory verification process at Swift Cargo.\n\nA quick question')).toBe(true);
    expect(r.ok && r.text.endsWith('across warehouses.')).toBe(true);
  });
  it('CA: the fixed text, with the emoji, and no names needed', () => {
    const r = buildWhatsApp({ ...L, segment: 'CA Firms', contactName: '' }, null);
    expect(r.ok && r.text.startsWith('Hi Sir/Ma’am, quick question\n\nDuring your stock audit')).toBe(true);
    expect(r.ok && r.text.endsWith('next assignment. 👇')).toBe(true);
    expect(r.ok && r.url).toContain(encodeURIComponent('👇'));
  });
  it('no contact name: Hi Sir/Ma’am, and never a doubled Sir', () => {
    for (const name of ['', '  ', 'Sir', 'Mr. Sir']) {
      const r = buildWhatsApp({ ...L, contactName: name }, 'Puja');
      expect(r.ok && r.text.startsWith('Hi Sir/Ma’am, Puja this side')).toBe(true);
    }
    expect(contactFirstName('Dr. Meena Iyer')).toBe('Meena');
    expect(contactFirstName('Mr Ravi Shah')).toBe('Ravi');
  });
  it('no owner: an error, not an empty name (CA needs none)', () => {
    for (const owner of [null, undefined, '  ']) {
      const r = buildWhatsApp(L, owner);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('no owner');
    }
  });
});

describe('opening WhatsApp logs the step', () => {
  let db: Db;
  beforeEach(async () => {
    process.env.DATABASE_URL = 'memory://';
    resetDbForTests();
    db = await getDb();
    const bdas = await db.select().from(users).where(eq(users.role, 'bda'));
    me.id = bdas[0].id;
  });
  const setup = async (extra: Partial<typeof leads.$inferInsert> = {}) => {
    const [l] = await db.insert(leads).values({ company: 'Acme Forge', segment: 'Manufacturing', status: 'Approved', ownerId: me.id, contactName: 'Ravi Shah', contactPhone: '9876543210', ...extra }).returning();
    const [t] = await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'whatsapp', step: 'Day 1', title: 'Day 1: WhatsApp', dueDate: istDay(), slot: 'day' }).returning();
    return t;
  };
  it('marks the step sent', async () => {
    const { openedWhatsAppAction } = await import('@/app/whatsapp-actions');
    const t = await setup();
    expect(await openedWhatsAppAction(t.id)).toEqual({ error: '' });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(after.doneAt).not.toBeNull();
    expect(after.outcome).toBe('sent');
  });
  it('logs nothing when the message cannot be built, or for someone else', async () => {
    const { openedWhatsAppAction } = await import('@/app/whatsapp-actions');
    const noNumber = await setup({ contactPhone: '123' });
    expect((await openedWhatsAppAction(noNumber.id)).error).toContain('valid WhatsApp number');
    const unowned = await setup({ ownerId: null });
    expect((await openedWhatsAppAction(unowned.id)).error).toContain('no owner');
    const theirs = await setup();
    me.id += 1;
    expect((await openedWhatsAppAction(theirs.id)).error).toContain('belongs to');
    const open = await db.select().from(tasks).where(and(eq(tasks.kind, 'whatsapp')));
    expect(open.every((t) => t.doneAt === null)).toBe(true);
  });
});
