'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import { addLeadAction } from '../../actions';

const INPUT = 'w-full min-w-[8rem] rounded border border-line bg-surface px-1.5 py-1 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none';

/**
 * The "+" row at the top of the tracker table. Clicking it turns the row into input cells under the
 * matching columns, like adding a row to a spreadsheet; the company goes to your own leads.
 */
export function AddLeadRow({ segments, columns, showOwner }: { segments: string[]; columns: number; showOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(addLeadAction, undefined);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  const td = 'border-b border-r border-line px-1.5 py-1.5 align-top';

  if (!open) {
    return (
      <tr>
        <td colSpan={columns} className="border-b border-line p-0">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs font-medium text-accent hover:bg-surface-2"
          >
            <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded border border-line text-sm leading-none">+</span>
            Add a lead
            {state?.ok && <span className="font-normal text-good-ink">{state.message}</span>}
          </button>
        </td>
      </tr>
    );
  }

  const f = (name: string, placeholder: string, label: string, required = false) => (
    <input form="tracker-add" name={name} placeholder={placeholder} aria-label={label} required={required} className={INPUT} />
  );
  return (
    <tr className="bg-accent-soft/40">
      <td className={`${td} sticky left-0 z-[5] space-y-1 bg-surface`}>
        <form ref={form} id="tracker-add" action={action} />
        {f('company', 'Company name *', 'Company name', true)}
        {f('website', 'Website', 'Company website')}
      </td>
      <td className={td}>{f('city', 'Location', 'Company location')}</td>
      <td className={`${td} space-y-1`}>
        {f('contactName', 'Client name', 'Client name')}
        {f('contactLinkedin', 'LinkedIn URL', 'Client LinkedIn profile')}
      </td>
      <td className={td}>{f('contactTitle', 'Designation', 'Client designation')}</td>
      <td className={td}>
        <select form="tracker-add" name="contactTier" aria-label="Contact tier" defaultValue="" className={INPUT}>
          <option value="">Tier</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
      </td>
      <td className={td}>{f('contactPhone', 'Number', 'Client contact number')}</td>
      <td className={td} colSpan={9}>
        <div className="flex flex-wrap items-center gap-2">
          <button form="tracker-add" className="btn-primary px-2.5 py-1 text-xs">Save lead</button>
          <button type="button" onClick={() => setOpen(false)} className="btn-secondary px-2.5 py-1 text-xs">Cancel</button>
          {state && <span className={`text-xs ${state.ok ? 'text-good-ink' : 'text-critical-ink'}`} role="status">{state.message}</span>}
        </div>
      </td>
      <td className={td}>
        <select form="tracker-add" name="segment" aria-label="Company type" className={INPUT}>
          {segments.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td className={td} />
      {showOwner && <td className={td} />}
    </tr>
  );
}
