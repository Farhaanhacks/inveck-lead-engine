'use client';

import { createContext, useContext, useState, useTransition, type ButtonHTMLAttributes, type FormHTMLAttributes, type ReactNode } from 'react';
import { completeTaskAction } from '@/app/team-actions';

type Ctx = { pending: boolean; run: (data: FormData) => void };
const StepCtx = createContext<Ctx | null>(null);

/**
 * The buttons that log one Today step (No answer, Connected, Mark sent, Skip...). They share one pending state:
 * the moment any of them is pressed, every button of the step goes inactive and says "Saving…", so the click is
 * acknowledged at once and a second click (on the same or another outcome) can't send a second request while the
 * first is still being saved. If saving fails the buttons come back, with a message.
 */
export function StepActions({ children, className }: { children: ReactNode; className?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const run = (data: FormData) => {
    setError('');
    start(async () => {
      try {
        await completeTaskAction(data);
      } catch {
        setError("Couldn't save that. Check your connection and try again.");
      }
    });
  };
  return (
    <StepCtx value={{ pending, run }}>
      <div className={className} aria-busy={pending}>
        {children}
        {error && <p role="alert" className="basis-full text-xs text-critical-ink">{error}</p>}
      </div>
    </StepCtx>
  );
}

/** A form that logs the step through the shared pending state (a plain form where there is none). */
export function TaskForm({ children, ...rest }: FormHTMLAttributes<HTMLFormElement>) {
  const ctx = useContext(StepCtx);
  return (
    <form
      {...rest}
      action={ctx ? undefined : completeTaskAction}
      onSubmit={
        ctx
          ? (e) => {
              e.preventDefault();
              if (ctx.pending) return;
              // The button pressed (its outcome) goes in with the fields.
              ctx.run(new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter));
            }
          : undefined
      }
    >
      {children}
    </form>
  );
}

export function TaskButton({ children, pendingText = 'Saving…', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pendingText?: string }) {
  const pending = useContext(StepCtx)?.pending ?? false;
  return (
    <button type="submit" {...rest} disabled={pending || rest.disabled}>
      {pending ? pendingText : children}
    </button>
  );
}
