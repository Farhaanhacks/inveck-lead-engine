'use client';
import { useActionState } from 'react';
import { login } from '../actions';
import { SubmitButton } from '@/components/submit-button';

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label htmlFor="password" className="label">Password</label>
        <input id="password" name="password" type="password" required autoFocus className="field" />
      </div>
      {state?.error && <p className="text-sm text-critical-ink" role="alert">{state.error}</p>}
      <SubmitButton className="btn-primary w-full" pendingText="Checking…">Log in</SubmitButton>
    </form>
  );
}
