'use client';

import { useEffect, useState, useTransition } from 'react';
import { scheduleMeetingAction } from '@/app/meeting-actions';

export type MeetingInfo = {
  company: string;
  contactName: string;
  /** The saved email address of the prospect ('' = none saved). */
  email: string;
  title: string;
  /** India dates (YYYY-MM-DD): today, and the day the picker starts on. */
  today: string;
  defaultDate: string;
};

const TIMES = Array.from({ length: 22 }, (_, i) => {
  const mins = 9 * 60 + i * 30;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
});
const label = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/**
 * "Meeting scheduled" for a connected call: shows who the Teams meeting is with and when, and nothing is created until
 * Approve and Schedule is pressed. The call itself is logged only after the meeting exists.
 */
export function MeetingDialog({ info, call, onClose, onDone }: { info: MeetingInfo; call: FormData; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(info.title);
  const [date, setDate] = useState(info.defaultDate);
  const [time, setTime] = useState('11:00');
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState('');
  const [busy, start] = useTransition();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose, busy]);

  const approve = () => {
    setError('');
    const fd = new FormData();
    for (const [k, v] of call.entries()) fd.append(k, v);
    fd.set('meetingTitle', title);
    fd.set('meetingDate', date);
    fd.set('meetingTime', time);
    fd.set('meetingMinutes', String(minutes));
    start(async () => {
      try {
        const r = await scheduleMeetingAction(fd);
        if (r.error) setError(r.error);
        else onDone();
      } catch {
        setError("Couldn't reach the server. Trying again is safe: a meeting already made is not made twice.");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Schedule a Microsoft Teams meeting" className="card mt-10 w-full max-w-lg space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Schedule a Microsoft Teams meeting</h2>
          <p className="mt-1 text-xs text-muted">The invitation is sent by your Outlook calendar. Nothing is created, and the lead stays where it is, until you approve.</p>
        </div>
        <dl className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-surface-2 p-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted">Prospect</dt><dd className="font-medium">{info.contactName || 'No name saved'}</dd></div>
          <div><dt className="text-xs text-muted">Company</dt><dd className="font-medium">{info.company}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted">Invitation goes to</dt><dd className="truncate font-medium">{info.email || <span className="text-critical-ink">No email saved</span>}</dd></div>
        </dl>
        {!info.email && <p role="alert" className="text-sm text-critical-ink">Add this contact&apos;s email under Edit point of contact first: the meeting can&apos;t be scheduled without it.</p>}
        <div>
          <label htmlFor="m-title" className="label">Meeting title</label>
          <input id="m-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="field" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="m-date" className="label">Date</label>
            <input id="m-date" type="date" value={date} min={info.today} onChange={(e) => setDate(e.target.value)} className="field" />
          </div>
          <div>
            <label htmlFor="m-time" className="label">Time (India)</label>
            <select id="m-time" value={time} onChange={(e) => setTime(e.target.value)} className="field">
              {TIMES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="m-len" className="label">Length</label>
            <select id="m-len" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="field">
              {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy || !info.email || !title.trim() || !date} onClick={approve}>{busy ? 'Scheduling…' : 'Approve and Schedule'}</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
