'use client';
import { useActionState } from 'react';
import { addClientsAction } from '../../actions';
import { SubmitButton } from '@/components/submit-button';

export function AddClientsForm() {
  const [state, action] = useActionState(addClientsAction, undefined);
  return (
    <form action={action} className="card space-y-3 p-5">
      <h3 className="text-sm font-semibold">Add clients</h3>
      <p className="text-xs text-muted">
        One per line: <code>Company, website, industry, why they bought</code>. Matching leads are marked “Existing Client”.
      </p>
      <textarea
        name="bulk"
        rows={6}
        required
        className="field font-mono text-xs"
        placeholder={'Haldex, haldex.com, Brake systems, Multi-plant stock audit\nMaxion Wheels, maxionwheels.com, Wheels'}
      />
      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Adding…">Add clients</SubmitButton>
        {state && <p className="text-sm text-ink-2" role="status">{state.message}</p>}
      </div>
    </form>
  );
}
