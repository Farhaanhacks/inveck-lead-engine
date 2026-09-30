'use client';
import { useActionState } from 'react';
import { changePasswordAction } from '../../team-actions';
import { SubmitButton } from '@/components/submit-button';

export function PasswordForm() {
  const [state, action] = useActionState(changePasswordAction, undefined);
  return (
    <form action={action} className="card max-w-md space-y-4 p-5">
      <h2 className="text-sm font-semibold">Change your password</h2>
      {(
        [
          ['current', 'Current password', 'current-password'],
          ['next', 'New password (at least 8 characters)', 'new-password'],
          ['confirm', 'New password again', 'new-password'],
        ] as const
      ).map(([name, label, auto]) => (
        <div key={name}>
          <label htmlFor={name} className="label">{label}</label>
          <input id={name} name={name} type="password" autoComplete={auto} required className="field" />
        </div>
      ))}
      {state && (
        <p className={`text-sm ${state.ok ? 'text-good-ink' : 'text-critical-ink'}`} role={state.ok ? 'status' : 'alert'}>
          {state.message}
        </p>
      )}
      <SubmitButton pendingText="Saving…">Change password</SubmitButton>
    </form>
  );
}
