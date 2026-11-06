'use client';
import { useActionState } from 'react';
import { saveContactFormAction, type ContactFormState } from '@/app/team-actions';
import { SubmitButton } from './submit-button';

export type ContactFormLead = { id: number; contactName: string; contactTitle: string; contactPhone: string; contactEmail: string; contactLinkedin: string; contactTier: string };

const FIELDS: { name: keyof ContactFormLead; label: string; type: string; wide?: boolean }[] = [
  { name: 'contactName', label: 'Name', type: 'text' },
  { name: 'contactTitle', label: 'Designation', type: 'text' },
  { name: 'contactPhone', label: 'Contact number', type: 'tel' },
  { name: 'contactEmail', label: 'Email', type: 'email' },
  { name: 'contactLinkedin', label: 'LinkedIn URL', type: 'url', wide: true },
];

/**
 * "Edit point of contact" on Today: name, designation, number, email, LinkedIn and tier of the company's main contact. It saves through
 * the same server action as before and shows what came of it: a saved note, or why nothing was saved (such as an invalid email).
 */
export function ContactForm({ lead }: { lead: ContactFormLead }) {
  const [state, action] = useActionState<ContactFormState, FormData>(saveContactFormAction, { error: '' });
  return (
    <form action={action} noValidate className="space-y-3">
      <input type="hidden" name="id" value={lead.id} />
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.name} className={f.wide ? 'sm:col-span-2' : ''}>
            <label htmlFor={`${f.name}-${lead.id}`} className="label">{f.label}</label>
            <input
              id={`${f.name}-${lead.id}`}
              name={f.name}
              type={f.type}
              defaultValue={String(lead[f.name] ?? '')}
              autoComplete="off"
              aria-invalid={f.name === 'contactEmail' && !!state.error ? true : undefined}
              className="field"
            />
          </div>
        ))}
      </div>
      <div className="sm:w-1/2">
        <label htmlFor={`contactTier-${lead.id}`} className="label">Tier</label>
        <select id={`contactTier-${lead.id}`} name="contactTier" defaultValue={lead.contactTier} className="field">
          <option value="">From the designation</option>
          <option value="P1">P1 decision-maker</option>
          <option value="P2">P2 process owner</option>
          <option value="P3">P3 process level</option>
        </select>
      </div>
      <p className="text-xs text-muted">Changing the name to someone else clears the previous person&apos;s number, email and LinkedIn unless you type new ones. Emptying the email removes it.</p>
      {state.error && <p role="alert" className="text-sm text-critical-ink">{state.error}</p>}
      {state.saved && !state.error && <p role="status" className="text-sm text-good-ink">Contact saved.</p>}
      <SubmitButton className="btn-primary px-3 py-1.5 text-sm" pendingText="Saving…">Save contact</SubmitButton>
    </form>
  );
}
