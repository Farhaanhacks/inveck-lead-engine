'use client';

import { useState, useTransition } from 'react';
import { saveLinkedinActivityAction } from '@/app/linkedin-activity-actions';
import { LINKEDIN_STATUSES, LINKEDIN_STATUS_LABEL, MAX_REMARKS, type LinkedinStatus } from '@/lib/linkedin-activity';

/**
 * One contact's LinkedIn status and remarks on Today. The status saves the moment it is changed; the remarks save when
 * the field is left (or Enter is pressed). Each contact has its own, so updating one never changes another.
 */
export function LinkedinTracker({ leadId, personId, initialStatus, initialRemarks, readOnly, label }: { leadId: number; personId: number; initialStatus: LinkedinStatus; initialRemarks: string; readOnly: boolean; label?: string }) {
  const [status, setStatus] = useState(initialStatus);
  const [remarks, setRemarks] = useState(initialRemarks);
  const [saved, setSaved] = useState({ status: initialStatus, remarks: initialRemarks });
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const id = `li-${leadId}-${personId}`;

  const save = (next: { status: LinkedinStatus; remarks: string }) => {
    if (next.status === saved.status && next.remarks.trim() === saved.remarks) return;
    setNote('');
    start(async () => {
      try {
        const r = await saveLinkedinActivityAction(leadId, personId, next.status, next.remarks);
        if (r.ok) {
          setSaved({ status: next.status, remarks: next.remarks.trim() });
          setNote('Saved');
        } else {
          setNote(r.error);
        }
      } catch {
        setNote("Couldn't save. Check your connection and try again.");
      }
    });
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={`${id}-s`} className="font-medium text-muted">{label ?? 'LinkedIn'}</label>
      <select id={`${id}-s`} value={status} disabled={readOnly || pending} onChange={(e) => { const s = e.target.value as LinkedinStatus; setStatus(s); save({ status: s, remarks }); }} className="field h-8 w-auto py-1 text-xs">
        {LINKEDIN_STATUSES.map((s) => <option key={s} value={s}>{LINKEDIN_STATUS_LABEL[s]}</option>)}
      </select>
      <label htmlFor={`${id}-r`} className="sr-only">LinkedIn remarks</label>
      <input
        id={`${id}-r`}
        value={remarks}
        disabled={readOnly}
        maxLength={MAX_REMARKS}
        placeholder="Remarks or feedback"
        onChange={(e) => setRemarks(e.target.value)}
        onBlur={() => save({ status, remarks })}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
        className="field h-8 min-w-48 flex-1 py-1 text-xs"
      />
      <span role="status" className={`min-w-14 ${note && note !== 'Saved' ? 'text-critical-ink' : 'text-good-ink'}`}>{pending ? 'Saving…' : note}</span>
    </div>
  );
}
