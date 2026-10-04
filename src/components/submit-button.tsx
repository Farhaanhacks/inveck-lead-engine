'use client';
import { useFormStatus } from 'react-dom';

export function SubmitButton({
  children,
  pendingText,
  className = 'btn-primary',
  confirmText,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pendingText?: string; confirmText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || rest.disabled}
      className={className}
      {...rest}
      onClick={(e) => {
        // An action that can't be undone asks first.
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
        rest.onClick?.(e);
      }}
    >
      {pending ? pendingText || 'Working…' : children}
    </button>
  );
}
