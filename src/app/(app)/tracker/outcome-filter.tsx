'use client';
import { useRef, useState } from 'react';
import { cleanOutcome, MEDIUMS, OUTCOMES_BY_MEDIUM, type Medium } from '@/lib/tracker';

/**
 * The two connected tracker filters: Medium (Call, LinkedIn, Email), then Outcome, which lists only that medium's outcomes. Changing
 * the medium clears an outcome that doesn't belong to the new one. Both are plain form fields, so the filter form (and its date
 * and search fields) sends them together.
 */
export function OutcomeFilter({ medium: initialMedium, outcome: initialOutcome }: { medium: Medium | ''; outcome: string }) {
  const [medium, setMedium] = useState<Medium | ''>(initialMedium);
  const outcomeRef = useRef<HTMLSelectElement>(null);
  const options = medium ? OUTCOMES_BY_MEDIUM[medium] : [];
  return (
    <>
      <select
        name="medium"
        value={medium}
        aria-label="Medium"
        onChange={(e) => {
          const next = e.target.value as Medium | '';
          // Cleared right now (the filter form reads the fields as this change bubbles up), not after the next render.
          if (outcomeRef.current && cleanOutcome(next, outcomeRef.current.value) !== outcomeRef.current.value) outcomeRef.current.value = '';
          setMedium(next);
        }}
        className="field h-9 w-auto py-1.5"
      >
        <option value="">Any medium</option>
        {MEDIUMS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <select ref={outcomeRef} name="outcome" defaultValue={medium === initialMedium ? cleanOutcome(medium, initialOutcome) : ''} key={medium} aria-label="Outcome" disabled={!medium} className="field h-9 w-auto py-1.5">
        <option value="">{medium ? 'Any outcome' : 'Choose a medium first'}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </>
  );
}
