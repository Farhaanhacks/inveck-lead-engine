'use client';

import Link from 'next/link';
import { useActionState, useState, type FormEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { sendEmailAction, writeFollowUpForTaskAction, type SendMailState } from '@/app/mail-actions';

const SMALL = 'btn-secondary px-2.5 py-1 text-xs';
const MAIN = 'btn-primary rounded-r-none px-2.5 py-1 text-xs';

/** The email, ready in the person's own email app (lines as mail apps expect them). */
function mailtoUrl(to: string, subject: string, body: string): string {
  const q = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`].filter(Boolean);
  return `mailto:${to.trim()}${q.length ? `?${q.join('&')}` : ''}`;
}

function WriteButton() {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} className={SMALL}>
      {pending ? 'Writing…' : 'Write it for me'}
    </button>
  );
}

/**
 * "Send mail" for a Today email step, with the arrow beside it to review (and edit) the email first.
 * With the person's Outlook connected it sends from their mailbox in one click; until then it opens
 * their email app with the address, subject and message filled in, and they log it with Mark sent.
 */
export function SendMail({
  taskId,
  from,
  configured,
  addresses,
  subject,
  body,
  followUp,
  threaded,
}: {
  taskId: number;
  /** The connected mailbox it goes from; empty: it opens their email app instead. */
  from: string;
  /** Outlook sending is set up on the server (they could connect theirs). */
  configured: boolean;
  addresses: string[];
  subject: string;
  body: string;
  followUp: boolean;
  /** A reply in the thread of the last email sent to them (Outlook keeps its subject). */
  threaded: boolean;
}) {
  const [state, send, pending] = useActionState<SendMailState, FormData>(sendEmailAction, { error: '' });
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const outlook = !!from;
  const ready = !!body.trim();
  const reviewId = `review-mail-${taskId}`;
  const toMailApp = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    window.location.href = mailtoUrl(String(f.get('to') ?? ''), String(f.get('subject') ?? ''), String(f.get('body') ?? ''));
    setOpened(true);
  };
  return (
    // Open, the email takes the whole row (under the buttons), like the Connected call form.
    <div className={`flex flex-col items-start gap-2 ${open ? 'basis-full' : ''}`}>
      <div className="inline-flex">
        {/* Nothing written yet: the button opens the email to write instead. */}
        {!ready ? (
          <button type="button" onClick={() => setOpen(true)} disabled={pending} className={MAIN}>
            Write and send
          </button>
        ) : outlook ? (
          <form action={send}>
            <input type="hidden" name="id" value={taskId} />
            <button disabled={pending} className={MAIN}>{pending ? 'Sending…' : 'Send mail'}</button>
          </form>
        ) : (
          <a href={mailtoUrl(addresses[0] ?? '', subject, body)} onClick={() => setOpened(true)} title="Opens your email app with this email ready to send" className={MAIN}>
            Send mail
          </a>
        )}
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
          <form action={outlook ? send : undefined} onSubmit={outlook ? undefined : toMailApp} key={`${subject}\n${body}`} className="space-y-2">
            <input type="hidden" name="id" value={taskId} />
            {outlook ? (
              <p className="text-xs text-muted">
                From {from}
                {followUp ? (threaded ? '. A follow-up, sent as a reply in the same thread as the last email (quoted below it).' : '. A follow-up.') : '.'}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {followUp ? 'A follow-up. ' : ''}Send mail opens your email app with this email filled in: send it from there, then click Mark sent.
                {configured && (
                  <>
                    {' '}
                    <Link href="/account" className="text-accent hover:underline">Connect your Outlook</Link> to send from here in one click.
                  </>
                )}
              </p>
            )}
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
      {!outlook && opened && <p className="text-xs text-muted">Sent it from your email app? Click Mark sent.</p>}
      {state.error && (
        <p role="alert" className="max-w-md text-xs text-critical-ink">
          {state.error}
        </p>
      )}
    </div>
  );
}
