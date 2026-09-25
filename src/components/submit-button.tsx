'use client';
import { useFormStatus } from 'react-dom';

export function SubmitButton({
  children,
  pendingText,
  className = 'btn-primary',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || rest.disabled} className={className} {...rest}>
      {pending ? pendingText || 'Working…' : children}
    </button>
  );
}
