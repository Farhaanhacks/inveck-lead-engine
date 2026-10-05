import { addPointOfContactAction } from '@/app/actions';

/** Another person, number, email or LinkedIn at the company, kept alongside the main contact. */
export function AddPointOfContact({ leadId, company }: { leadId: number; company: string }) {
  return (
    <form action={addPointOfContactAction} className="space-y-2 border-t border-line pt-3">
      <input type="hidden" name="id" value={leadId} />
      <div className="text-xs font-medium text-ink-2">Add another point of contact at {company}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input aria-label="Name" name="name" placeholder="Name (or leave blank for another number)" className="field" />
        <input aria-label="Designation" name="title" placeholder="Designation" className="field" />
        <input aria-label="Phone" name="phone" type="tel" placeholder="Phone" className="field" />
        <input aria-label="Email" name="email" type="email" placeholder="Email" className="field" />
        <input aria-label="LinkedIn URL" name="linkedin" placeholder="linkedin.com/in/…" className="field sm:col-span-2" />
      </div>
      <button className="btn-secondary px-3 py-1.5 text-sm">Add point of contact</button>
    </form>
  );
}
