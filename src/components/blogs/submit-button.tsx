'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`size-3.5 shrink-0 animate-spin motion-reduce:animate-none ${className}`} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A form's submit button that reflects the submission: disabled (so a second click cannot send it twice), a spinner, and a
 * pending label, until the server action finishes and the page shows the saved result. It only covers the request itself;
 * work that continues in the background is shown from the database on the page, not by keeping this spinning.
 */
export function SubmitButton({
  children,
  pendingLabel = 'Working…',
  primary = false,
  className = '',
  disabled = false,
}: {
  children: ReactNode;
  pendingLabel?: string;
  primary?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} className={`${primary ? 'btn-primary' : 'btn'} ${className}`}>
      {pending ? (
        <>
          <Spinner />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
      <span className="sr-only" aria-live="polite">{pending ? pendingLabel : ''}</span>
    </button>
  );
}
