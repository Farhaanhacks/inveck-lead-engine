'use client';

import { useState, useTransition } from 'react';
import { openedWhatsAppAction } from '@/app/whatsapp-actions';

/**
 * "Send WhatsApp": opens the chat with the message filled in, in the WhatsApp already signed in on this device
 * (or WhatsApp Web). The BDA reads it and presses Send there. Once the chat opens, the step is logged as sent;
 * if the browser blocks it from opening, nothing is logged. With no message to send, the button is off and says why.
 */
export function OpenWhatsApp({ taskId, url, problem }: { taskId: number; url: string; problem?: string }) {
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  if (!url) {
    return (
      <div className="flex flex-col items-start gap-1">
        <button type="button" disabled className="btn-primary px-2.5 py-1 text-xs">Send WhatsApp</button>
        {problem && <p className="max-w-md text-xs text-warning-ink">{problem}</p>}
      </div>
    );
  }
  const open = () => {
    const w = window.open(url, '_blank');
    if (!w) {
      setError('Your browser blocked WhatsApp from opening. Allow pop-ups for this site and click again.');
      return;
    }
    w.opener = null;
    setError('');
    start(async () => {
      const r = await openedWhatsAppAction(taskId);
      if (r.error) setError(r.error);
    });
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={open} disabled={pending} className="btn-primary px-2.5 py-1 text-xs">{pending ? 'Logging…' : 'Send WhatsApp'}</button>
      {error && <p role="alert" className="max-w-md text-xs text-critical-ink">{error}</p>}
    </div>
  );
}
