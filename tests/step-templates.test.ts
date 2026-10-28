import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, resetDbForTests, type Db } from '@/lib/db';
import { leads, tasks, users } from '@/lib/db/schema';
import { istDay } from '@/lib/tasks';

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
const mfg = async () => {
  const { defaultProduct, listIcps } = await import('@/lib/config');
  const product = (await defaultProduct(db))!;
  return { product, icp: (await listIcps(db, product.id)).find((i) => i.segment === 'Manufacturing')! };
};

describe('WhatsApp templates for every step', () => {
  it('the old WhatsApp template of each ICP is its First contact template, with the same wording', async () => {
    const { listStepTemplates, listStepAssignments, loadTemplateSet } = await import('@/lib/config');
    const { buildWhatsApp } = await import('@/lib/whatsapp-outreach');
    const { product, icp } = await mfg();
    const first = (await listStepTemplates(db, product.id, 'whatsapp')).find((t) => t.icpId === icp.id)!;
    expect(first).toMatchObject({ name: 'First contact', channel: 'whatsapp' });
    expect(first.body).not.toContain('<p');
    expect((await listStepAssignments(db, product.id, 'whatsapp')).find((a) => a.icpId === icp.id && a.step === 0)?.templateId).toBe(first.id);
    // Email and WhatsApp are separate: an email template is never a WhatsApp one.
    expect((await listStepTemplates(db, product.id, 'email')).every((t) => t.channel === 'email')).toBe(true);
    const lead = { segment: 'Manufacturing', company: 'Acme', contactName: 'Ravi Shah', contactPhone: '9876543210' };
    expect(buildWhatsApp(lead, 'Puja', await loadTemplateSet(db, product.id))).toEqual(buildWhatsApp(lead, 'Puja'));
  });

  it('a follow-up step sends its own WhatsApp text; a step with none is an error and nothing is made up', async () => {
    const { saveStepTemplate, assignStepTemplate, loadTemplateSet, stepsFor } = await import('@/lib/config');
    const { buildWhatsApp, whatsappStepOf } = await import('@/lib/whatsapp-outreach');
    const { product, icp } = await mfg();
    expect((await stepsFor(db, product.id, icp.id)).length).toBe(6);
    const made = await saveStepTemplate(db, 'whatsapp', product.id, icp.id, { name: 'Nudge', subject: 'ignored', body: '{{greeting}} {{bd_name}} here again about {{company_name}}.' });
    expect(made.ok).toBe(true);
    const id = made.ok ? made.id : 0;
    expect(await assignStepTemplate(db, 'whatsapp', product.id, icp.id, 1, id)).toEqual({ ok: true });
    const set = await loadTemplateSet(db, product.id);
    const lead = { segment: 'Manufacturing', company: 'Acme', contactName: 'Ravi Shah', contactPhone: '9876543210' };
    const one = buildWhatsApp(lead, 'Puja', set, 1);
    expect(one).toMatchObject({ ok: true, text: 'Hi Ravi Sir, Puja here again about Acme.' });
    // Follow-up 2 has none.
    const two = buildWhatsApp(lead, 'Puja', set, 2);
    expect(two).toMatchObject({ ok: false });
    expect(!two.ok && two.error).toContain('Follow-up 2');
    expect(whatsappStepOf({ followUpRound: 0, caRound: 0 })).toBe(0);
    expect(whatsappStepOf({ followUpRound: 3, caRound: 0 })).toBe(3);
    expect(whatsappStepOf({ followUpRound: 0, caRound: 2 })).toBe(2);
  });

  it('opening WhatsApp on a follow-up step logs it only when that step has a template', async () => {
    const { saveStepTemplate, assignStepTemplate } = await import('@/lib/config');
    const { openedWhatsAppAction } = await import('@/app/whatsapp-actions');
    const { product, icp } = await mfg();
    const [l] = await db.insert(leads).values({ company: 'Acme', segment: 'Manufacturing', status: 'Approved', ownerId: me.id, contactName: 'Ravi Shah', contactPhone: '9876543210' }).returning();
    const [t] = await db.insert(tasks).values({ leadId: l.id, ownerId: me.id, kind: 'whatsapp', step: 'Follow-up 1', title: 'Follow-up 1: WhatsApp', dueDate: istDay(), slot: 'day', followUpRound: 1 }).returning();
    expect((await openedWhatsAppAction(t.id)).error).toContain('Follow-up 1');
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).toBeNull();
    const made = await saveStepTemplate(db, 'whatsapp', product.id, icp.id, { name: 'Nudge', subject: '', body: 'Hello again from {{bd_name}}.' });
    await assignStepTemplate(db, 'whatsapp', product.id, icp.id, 1, made.ok ? made.id : 0);
    expect((await openedWhatsAppAction(t.id)).error).toBe('');
    expect((await db.select().from(tasks).where(eq(tasks.id, t.id)))[0].doneAt).not.toBeNull();
  });

  it('refuses an unknown variable, an empty text, and a template from another ICP or channel', async () => {
    const { saveStepTemplate, assignStepTemplate, listIcps } = await import('@/lib/config');
    const { product, icp } = await mfg();
    expect(await saveStepTemplate(db, 'whatsapp', product.id, icp.id, { name: 'A', subject: '', body: 'Hi {{nope}}' })).toMatchObject({ ok: false, error: expect.stringContaining('{{nope}}') });
    expect(await saveStepTemplate(db, 'whatsapp', product.id, icp.id, { name: 'A', subject: '', body: '  ' })).toMatchObject({ ok: false });
    expect(await saveStepTemplate(db, 'whatsapp', product.id, icp.id, { name: 'A', subject: '', body: 'x'.repeat(4001) })).toMatchObject({ ok: false });
    const wa = await saveStepTemplate(db, 'whatsapp', product.id, icp.id, { name: 'Mine', subject: '', body: 'Hello' });
    const other = (await listIcps(db, product.id)).find((i) => i.segment === '3PL & Logistics')!;
    expect(await assignStepTemplate(db, 'whatsapp', product.id, other.id, 1, wa.ok ? wa.id : 0)).toMatchObject({ ok: false });
    // A WhatsApp template can't be assigned to an email step.
    expect(await assignStepTemplate(db, 'email', product.id, icp.id, 1, wa.ok ? wa.id : 0)).toMatchObject({ ok: false });
  });
});
