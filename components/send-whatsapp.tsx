'use client';

import { useActionState, useState } from 'react';
import { sendWhatsAppAction, sendWhatsAppMessageAction, type SendWhatsAppState } from '@/app/whatsapp-actions';

const SMALL = 'btn-secondary px-2.5 py-1 text-xs';

/**
 * "Send WhatsApp" from INVECK's number, with the arrow beside it to review the message first. Until
 * they write back, WhatsApp only allows the approved template, so the review shows it filled in; within
 * 24 hours of their last message the text can be written freely.
 */
export function SendWhatsApp({
  taskId,
  leadId,
  to,
  template,
  text,
  freeUntil,
}: {
  /** A Today step (logged as sent once it goes), or else the company page's lead. */
  taskId?: number;
  leadId?: number;
  /** The number it goes to, as shown: +919845012345. */
  to: string;
  template: boolean;
  text: string;
  /** While free text may go: "until 5:40 pm". */
  freeUntil?: string;
}) {
  const [state, send, pending] = useActionState<SendWhatsAppState, FormData>(taskId ? sendWhatsAppAction : sendWhatsAppMessageAction, { error: '' });
  const [open, setOpen] = useState(false);
  const idField = taskId ? <input type="hidden" name="id" value={taskId} /> : <input type="hidden" name="leadId" value={leadId} />;
  const key = taskId ?? `lead-${leadId}`;
  const reviewId = `review-wa-${key}`;
  // Free text with nothing written yet: open the message to write it instead.
  const ready = template || !!text.trim();
  return (
    <div className={`flex flex-col items-start gap-2 ${open ? 'basis-full' : ''}`}>
      <div className="inline-flex">
        {ready ? (
          <form action={send}>
            {idField}
            <button disabled={pending} className="btn-primary rounded-r-none px-2.5 py-1 text-xs">{pending ? 'Sending…' : 'Send WhatsApp'}</button>
          </form>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="btn-primary rounded-r-none px-2.5 py-1 text-xs">Write and send</button>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={pending}
          aria-expanded={open}
          aria-controls={reviewId}
          aria-label="Review the WhatsApp before sending"
          title="Review the WhatsApp before sending"
          className="btn-primary rounded-l-none border-l border-white/30 px-1.5 py-1 text-xs"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={open ? 'rotate-180' : ''}>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div id={reviewId} className="w-[min(34rem,calc(100vw-5rem))] space-y-2 rounded-lg border border-line bg-surface-2 p-4">
          <form action={send} key={text} className="space-y-2">
            {idField}
            <p className="text-xs text-muted">
              From INVECK&apos;s WhatsApp number to {to}.{' '}
              {template
                ? "Until they write back, WhatsApp only allows the template Meta approved, so it goes exactly as below."
                : `They wrote in the last 24 hours, so you can write freely${freeUntil ? ` ${freeUntil}` : ''}.`}
            </p>
            <label htmlFor={`wa-body-${key}`} className="label">Message</label>
            {template ? (
              <p id={`wa-body-${key}`} className="whitespace-pre-line rounded-md border border-line bg-surface p-3 text-sm leading-relaxed">{text}</p>
            ) : (
              <textarea id={`wa-body-${key}`} name="body" defaultValue={text} rows={8} required maxLength={4096} className="field font-[inherit] leading-relaxed" />
            )}
            <div className="flex flex-wrap gap-2">
              <button disabled={pending} className="btn-primary px-2.5 py-1 text-xs">{pending ? 'Sending…' : 'Send WhatsApp'}</button>
              <button type="button" onClick={() => setOpen(false)} className={SMALL}>Close</button>
            </div>
          </form>
        </div>
      )}
      {state.error && (
        <p role="alert" className="max-w-md text-xs text-critical-ink">
          {state.error}
        </p>
      )}
      {!taskId && state.sent && !state.error && <p className="text-xs text-good-ink" role="status">Sent.</p>}
    </div>
  );
}
