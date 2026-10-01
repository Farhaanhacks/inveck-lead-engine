'use client';
import { useActionState } from 'react';
import { addLeadAction, addLeadsBulkAction } from '../../../actions';
import { SubmitButton } from '@/components/submit-button';

function Message({ state }: { state?: { ok: boolean; message: string } }) {
  if (!state) return null;
  return (
    <p className={`text-sm ${state.ok ? 'text-good-ink' : 'text-critical-ink'}`} role="status">
      {state.message}
    </p>
  );
}

export function AddLeadForms({ segments }: { segments: string[] }) {
  const [one, addOne] = useActionState(addLeadAction, undefined);
  const [many, addMany] = useActionState(addLeadsBulkAction, undefined);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={addOne} className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">One company</h2>
        <div>
          <label htmlFor="company" className="label">Company *</label>
          <input id="company" name="company" required className="field" placeholder="Tata Motors" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="website" className="label">Website</label>
            <input id="website" name="website" className="field" placeholder="tatamotors.com" />
          </div>
          <div>
            <label htmlFor="city" className="label">City</label>
            <input id="city" name="city" className="field" placeholder="Pune" />
          </div>
        </div>
        <div>
          <label htmlFor="segment" className="label">Segment</label>
          <select id="segment" name="segment" className="field">
            {segments.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-sm text-ink-2">Already know the right person? (optional)</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {(
              [
                ['contactName', 'Name'],
                ['contactTitle', 'Title'],
                ['contactEmail', 'Email'],
                ['contactPhone', 'Phone'],
              ] as const
            ).map(([name, label]) => (
              <div key={name}>
                <label htmlFor={name} className="label">{label}</label>
                <input id={name} name={name} className="field" />
              </div>
            ))}
            <div className="col-span-2">
              <label htmlFor="contactLinkedin" className="label">LinkedIn URL</label>
              <input id="contactLinkedin" name="contactLinkedin" className="field" />
            </div>
          </div>
        </details>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="inbound" value="yes" className="mt-1" />
          <span>
            Inbound lead (from ads, the website or a campaign)
            <span className="block text-xs text-muted">Shared equally between the team. Gets flagged if nobody touches it.</span>
          </span>
        </label>
        <div className="flex items-center gap-3">
          <SubmitButton pendingText="Adding…">Add company</SubmitButton>
          <Message state={one} />
        </div>
      </form>

      <form action={addMany} className="card space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">Many companies</h2>
          <p className="mt-1 text-xs text-muted">
            One per line: <code>Company, website, city, segment</code>. Only the company is required. You can paste straight from Excel or Google Sheets.
          </p>
        </div>
        <textarea
          name="bulk"
          rows={12}
          required
          className="field font-mono text-xs"
          placeholder={`Bajaj Auto, bajajauto.com, Pune, Manufacturing\nTCI Supply Chain, tcisupplychain.com, Gurgaon, 3PL & Logistics\nKirtane & Pandit, kirtanepandit.com, Pune, CA Firms\nMahindra Logistics`}
        />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="inbound" value="yes" className="mt-1" />
          <span>
            Inbound lead (from ads, the website or a campaign)
            <span className="block text-xs text-muted">Shared equally between the team. Gets flagged if nobody touches it.</span>
          </span>
        </label>
        <div className="flex items-center gap-3">
          <SubmitButton pendingText="Adding…">Add companies</SubmitButton>
          <Message state={many} />
        </div>
      </form>
    </div>
  );
}
