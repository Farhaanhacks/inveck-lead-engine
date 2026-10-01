'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import { addLeadAction } from '../../actions';
import { SubmitButton } from '@/components/submit-button';

const FIELDS: [name: string, label: string, placeholder: string, required?: boolean][] = [
  ['company', 'Company Name', 'Tata AutoComp', true],
  ['city', 'Company Location', 'Pune'],
  ['website', 'Company Website URL', 'tataautocomp.com'],
  ['contactName', 'Client Name', 'Ravi Shah'],
  ['contactTitle', 'Client Designation', 'Plant Head'],
  ['contactPhone', 'Client Contact Number', '98765 43210'],
  ['contactEmail', 'Client Email ID', 'ravi.shah@company.com'],
  ['contactLinkedin', 'Client LinkedIn Profile', 'https://www.linkedin.com/in/…'],
];

/** "+ Add lead" on the tracker: a company and, if known, the person, added straight to your own leads. */
export function AddLead({ segments }: { segments: string[] }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(addLeadAction, undefined);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <div className="mb-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn-primary gap-1.5">
        <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
        Add lead
      </button>
      {open && (
        <form ref={form} action={action} className="card mt-3 w-full space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FIELDS.map(([name, label, placeholder, required]) => (
              <div key={name}>
                <label htmlFor={`add-${name}`} className="label">{label}{required ? ' *' : ''}</label>
                <input id={`add-${name}`} name={name} required={required} placeholder={placeholder} className="field" />
              </div>
            ))}
            <div>
              <label htmlFor="add-segment" className="label">Company type</label>
              <select id="add-segment" name="segment" className="field">
                {segments.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingText="Adding…">Add to my leads</SubmitButton>
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary">Close</button>
            {state && <p className={`text-sm ${state.ok ? 'text-good-ink' : 'text-critical-ink'}`} role="status">{state.message}</p>}
          </div>
          <p className="text-xs text-muted">The engine researches the company and fills in anything missing. People you enter here are kept.</p>
        </form>
      )}
    </div>
  );
}
