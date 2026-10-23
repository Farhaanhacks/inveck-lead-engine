'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useState, useTransition, type ButtonHTMLAttributes, type FormHTMLAttributes, type ReactNode } from 'react';
import { completeTaskAction } from '@/app/team-actions';
import { MeetingDialog, type MeetingInfo } from './meeting-dialog';

/** Longer than this and the save is treated as failed (the step stays; it can be tried again). */
const SAVE_TIMEOUT_MS = 45_000;

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
  const router = useRouter();
  const run = (data: FormData) => {
    setError('');
    start(async () => {
      try {
        // A request that never answers must not leave "Saving…" on the button for good.
        const r = await Promise.race([
          completeTaskAction(data),
          new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), SAVE_TIMEOUT_MS)),
        ]);
        // Refused (with the reason) or saved: the list is refreshed either way, so it matches what the server holds.
        if (!r.ok) setError(r.error);
        router.refresh();
      } catch {
        setError("Couldn't save that. Check your connection and try again: the step is still there.");
        router.refresh();
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

/**
 * A form that logs the step through the shared pending state (a plain form where there is none). With `meeting`, saving
 * a connected call as "Demo scheduled" opens the Teams meeting dialog first instead of saving: the call is logged
 * (and the lead moved to Meeting Booked) only when the meeting is approved and created.
 */
export function TaskForm({ children, meeting, ...rest }: FormHTMLAttributes<HTMLFormElement> & { meeting?: MeetingInfo }) {
  const ctx = useContext(StepCtx);
  const [call, setCall] = useState<FormData | null>(null);
  return (
    <>
      <form
        {...rest}
        action={ctx ? undefined : async (f: FormData) => void (await completeTaskAction(f))}
        onSubmit={
          ctx
            ? (e) => {
                e.preventDefault();
                if (ctx.pending) return;
                // The button pressed (its outcome) goes in with the fields.
                const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
                if (meeting && data.get('outcome') === 'connected' && data.get('feedback') === 'Demo scheduled') {
                  setCall(data);
                  return;
                }
                ctx.run(data);
              }
            : undefined
        }
      >
        {children}
      </form>
      {meeting && call && <MeetingDialog info={meeting} call={call} onClose={() => setCall(null)} onDone={() => setCall(null)} />}
    </>
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
