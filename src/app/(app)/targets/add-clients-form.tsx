'use client';
import { useActionState } from 'react';
import { addClientsAction } from '../../actions';
import { SubmitButton } from '@/components/submit-button';

export function AddClientsForm() {
  const [state, action] = useActionState(addClientsAction, undefined);
  return (
    <form action={action} className="card space-y-3 p-5">
      <h3 className="text-sm font-semibold">Add a client</h3>
      <div>
        <label htmlFor="clientCompany" className="label">Company</label>
        <input id="clientCompany" name="company" className="field" placeholder="Haldex India" />
      </div>
      <div>
        <label htmlFor="clientWebsite" className="label">Website</label>
        <input id="clientWebsite" name="website" className="field" placeholder="haldex.com" />
      </div>
      <div>
        <label htmlFor="clientIndustry" className="label">Industry</label>
        <input id="clientIndustry" name="industry" className="field" placeholder="Brake systems" />
      </div>
      <div>
        <label htmlFor="clientWhy" className="label">Why they bought INVECK</label>
        <textarea id="clientWhy" name="whyBought" rows={3} className="field" placeholder="Multi-plant stock audit, needed faster year-end verification" />
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2">Add many at once</summary>
        <p className="mt-2 text-xs text-muted">
          One per line: <code>Company, website, industry, why they bought</code>
        </p>
        <textarea
          name="bulk"
          rows={5}
          className="field mt-2 font-mono text-xs"
          placeholder={'Haldex, haldex.com, Brake systems, Multi-plant stock audit\nMaxion Wheels, maxionwheels.com, Wheels'}
        />
      </details>

      <p className="text-xs text-muted">Leads that match a client are marked “Existing Client”.</p>
      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Adding…">Add client</SubmitButton>
        {state && <p className="text-sm text-ink-2" role="status">{state.message}</p>}
      </div>
    </form>
  );
}
