'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { sendEmailAction, writeFollowUpForTaskAction, type SendMailState } from '@/app/mail-actions';

const SMALL = 'btn-secondary px-2.5 py-1 text-xs';

function WriteButton() {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} className={SMALL}>
      {pending ? 'Writing…' : 'Write it for me'}
    </button>
  );
}

/**
 * "Send mail" for a Today email step: sends the draft from the person's own Outlook in one click; the
 * arrow beside it opens the email to review (and edit) before sending.
 */
export function SendMail({
  taskId,
  from,
  addresses,
  subject,
  body,
  followUp,
  threaded,
}: {
  taskId: number;
  /** The connected mailbox it goes from. */
  from: string;
  addresses: string[];
  subject: string;
  body: string;
  followUp: boolean;
  /** A reply in the thread of the last email sent to them (Outlook keeps its subject). */
  threaded: boolean;
}) {
  const [state, send, pending] = useActionState<SendMailState, FormData>(sendEmailAction, { error: '' });
  const [open, setOpen] = useState(false);
  const ready = !!body.trim();
  const reviewId = `review-mail-${taskId}`;
  return (
    // Open, the email takes the whole row (under the buttons), like the Connected call form.
    <div className={`flex flex-col items-start gap-2 ${open ? 'basis-full' : ''}`}>
      <div className="inline-flex">
        <form action={send}>
          <input type="hidden" name="id" value={taskId} />
          {/* Nothing written yet: the button opens the email to write instead of sending. */}
          <button
            type={ready ? 'submit' : 'button'}
            onClick={ready ? undefined : () => setOpen(true)}
            disabled={pending}
            className="btn-primary rounded-r-none px-2.5 py-1 text-xs"
          >
            {pending ? 'Sending…' : ready ? 'Send mail' : 'Write and send'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={pending}
          aria-expanded={open}
          aria-controls={reviewId}
          aria-label="Review the email before sending"
          title="Review the email before sending"
          className="btn-primary rounded-l-none border-l border-white/30 px-1.5 py-1 text-xs"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={open ? 'rotate-180' : ''}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div id={reviewId} className="w-[min(34rem,calc(100vw-5rem))] space-y-2 rounded-lg border border-line bg-surface-2 p-4">
          {/* A new draft (written for them) replaces the fields. */}
          <form action={send} key={`${subject}\n${body}`} className="space-y-2">
            <input type="hidden" name="id" value={taskId} />
            <p className="text-xs text-muted">
              From {from}
              {followUp ? (threaded ? '. A follow-up, sent as a reply in the same thread as the last email (quoted below it).' : '. A follow-up.') : '.'}
            </p>
            <label htmlFor={`to-${taskId}`} className="label">To</label>
            <select id={`to-${taskId}`} name="to" defaultValue={addresses[0]} className="field">
              {addresses.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <label htmlFor={`subject-${taskId}`} className="label">Subject</label>
            {threaded ? (
              <>
                <input type="hidden" name="subject" value={subject} />
                <p id={`subject-${taskId}`} className="text-sm text-ink-2">{subject} (kept from the thread)</p>
              </>
            ) : (
              <input id={`subject-${taskId}`} name="subject" defaultValue={subject} required className="field" />
            )}
            <label htmlFor={`body-${taskId}`} className="label">Message</label>
            <textarea id={`body-${taskId}`} name="body" defaultValue={body} rows={10} required className="field font-[inherit] leading-relaxed" />
            <div className="flex flex-wrap gap-2">
              <button disabled={pending} className="btn-primary px-2.5 py-1 text-xs">{pending ? 'Sending…' : 'Send mail'}</button>
              <button type="button" onClick={() => setOpen(false)} className={SMALL}>Close</button>
            </div>
          </form>
          {followUp && !ready && (
            <form action={writeFollowUpForTaskAction} className="flex items-center gap-2 border-t border-line pt-2">
              <input type="hidden" name="id" value={taskId} />
              <span className="text-xs text-muted">No follow-up written yet.</span>
              <WriteButton />
            </form>
          )}
        </div>
      )}
      {state.error && (
        <p role="alert" className="max-w-md text-xs text-critical-ink">
          {state.error}
        </p>
      )}
    </div>
  );
}
