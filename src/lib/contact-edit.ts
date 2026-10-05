import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './db';
import { leads, people, tasks } from './db/schema';
import { logActivity } from './activity';
import { newContactNamed } from './escalate';
import { reconcileContactStatus } from './contact-status';

export type ContactEdit = { contactName: string; contactTitle: string; contactPhone: string; contactEmail: string; contactLinkedin: string };

const FIELDS = ['contactName', 'contactTitle', 'contactPhone', 'contactEmail', 'contactLinkedin'] as const;
const LABEL: Record<(typeof FIELDS)[number], string> = { contactName: 'name', contactTitle: 'designation', contactPhone: 'number', contactEmail: 'email', contactLinkedin: 'LinkedIn' };

/** The email fields for an address the team typed: theirs, not checked yet, never replaced by a lookup. */
export function teamEmail(email: string) {
  return email
    ? { emailStatus: 'entered by the team', emailSource: 'manual', emailVerification: 'unverified', emailProviderStatus: '', emailRetrievedAt: null }
    : { emailStatus: '', emailSource: '', emailVerification: '', emailProviderStatus: '', emailRetrievedAt: null };
}

/** The contact fields of a submitted form. Emails aren't kept at all (no field anywhere), so always empty. */
export function contactFields(form: FormData): ContactEdit {
  const get = (k: string) => String(form.get(k) ?? '');
  return { contactName: get('contactName'), contactTitle: get('contactTitle'), contactPhone: get('contactPhone'), contactEmail: '', contactLinkedin: get('contactLinkedin') };
}

/** The point of contact as typed: trimmed, cut to size, email in lower case. Null when the email isn't one. */
export function cleanContact(input: ContactEdit): ContactEdit | null {
  const v = {
    contactName: input.contactName.trim().slice(0, 200),
    contactTitle: input.contactTitle.trim().slice(0, 200),
    contactPhone: input.contactPhone.trim().slice(0, 120),
    contactEmail: input.contactEmail.trim().slice(0, 200).toLowerCase(),
    contactLinkedin: input.contactLinkedin.trim().slice(0, 300),
  };
  return v.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail) ? null : v;
}

/**
 * Saves the point of contact the team typed, keeping what hangs off it in step: the people list, the
 * email status, the confirmation (the team vouches for a contact it enters), a fresh tier and LinkedIn
 * check for someone new, and a timeline entry (which also stops the automatic "better contact" swap
 * from overriding the team's choice). Without `force`, nothing happens when nothing changed. Returns
 * null when nothing was saved, else whether it's a new person (whose email then needs rewriting).
 */
export async function saveContactEdit(db: Db, id: number, input: ContactEdit, opts: { force?: boolean } = {}): Promise<{ newPerson: boolean } | null> {
  const v = cleanContact(input);
  if (!v) return null;
  const [before] = await db.select().from(leads).where(eq(leads.id, id));
  if (!before) return null;
  // A different person: the previous person's number, email and LinkedIn don't carry over unless retyped.
  if (before.contactName && v.contactName.toLowerCase() !== before.contactName.toLowerCase()) {
    for (const k of ['contactPhone', 'contactEmail', 'contactLinkedin'] as const) if (v[k] === before[k]) v[k] = '';
  }
  const changed = FIELDS.filter((k) => v[k] !== before[k]);
  if (!changed.length && !opts.force) return null;
  const emailChanged = v.contactEmail !== before.contactEmail;
  const newPerson = v.contactName.toLowerCase() !== before.contactName.toLowerCase();
  await db
    .update(leads)
    .set({
      ...v,
      contactVerifiedAt: v.contactName ? new Date() : null,
      ...(newPerson ? { contactTier: '', contactCheckedAt: null } : {}),
      ...(emailChanged ? teamEmail(v.contactEmail) : {}),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
  // Keep the people list in step: update the main contact, or add them if they're new.
  const [primary] = await db.select().from(people).where(and(eq(people.leadId, id), eq(people.isPrimary, true)));
  const person = { name: v.contactName, title: v.contactTitle, phone: v.contactPhone, email: v.contactEmail, linkedin: v.contactLinkedin };
  if (primary && primary.name.toLowerCase() === v.contactName.toLowerCase()) {
    await db.update(people).set({ ...person, ...(emailChanged ? teamEmail(v.contactEmail) : {}) }).where(eq(people.id, primary.id));
  } else if (v.contactName) {
    await db.update(people).set({ isPrimary: false }).where(eq(people.leadId, id));
    await db.insert(people).values({ ...person, leadId: id, ...teamEmail(v.contactEmail), source: 'Sales team', isPrimary: true });
  } else if (primary) {
    // The contact was cleared: nobody is the main contact any more.
    await db.update(people).set({ isPrimary: false }).where(eq(people.id, primary.id));
  }
  // The status follows the contact: someone the team named makes the lead ready; nobody, waiting again.
  await reconcileContactStatus(db, id);
  // Someone new: their own count of unanswered calls, and a fresh plan if the lead was waiting for them.
  if (newPerson && v.contactName) await newContactNamed(db, id);
  if (changed.length) {
    await logActivity(db, id, 'contact', `Point of contact updated (${changed.map((k) => LABEL[k]).join(', ')}): ${[v.contactName, v.contactTitle, v.contactPhone, v.contactEmail].filter(Boolean).join(' · ') || 'cleared'}`);
  }
  // A new email address means the email steps can run: plan them if the sequence had none.
  if (emailChanged && v.contactEmail && !before.contactEmail) {
    const open = await db.select().from(tasks).where(and(eq(tasks.leadId, id), isNull(tasks.doneAt)));
    if (open.length && !open.some((t) => t.kind === 'email')) {
      for (const c of open.filter((t) => t.kind === 'call' && !t.priority)) {
        await db.insert(tasks).values({ leadId: id, ownerId: c.ownerId, kind: 'email', step: c.step, title: `${c.step}: email`, dueDate: c.dueDate, slot: c.slot });
      }
    }
  }
  return { newPerson: newPerson && !!v.contactName };
}
