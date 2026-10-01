'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { updateTrackerFieldAction } from '../../team-actions';
import { AddLeadRow } from './add-lead';

export type TrackerViewRow = {
  id: number;
  cells: Record<string, string>;
  callFeedback: string;
  mailOutcome: string;
  linkedinOutcome: string;
  remark: string;
  linkedin: string;
  website: string;
};

type Field = 'callFeedback' | 'mailOutcome' | 'linkedinOutcome' | 'remark' | 'callRemark';

const CELL = 'w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink hover:border-line focus:border-accent focus:outline-none';

function Choice({ id, field, value, options, label }: { id: number; field: Field; value: string; options: readonly string[]; label: string }) {
  const [v, setV] = useState(value);
  const [state, setState] = useState<'' | 'saving' | 'error'>('');
  const [, start] = useTransition();
  return (
    <select
      aria-label={label}
      value={v}
      onChange={(e) => {
        const next = e.target.value;
        setV(next);
        setState('saving');
        start(async () => {
          const r = await updateTrackerFieldAction(id, field, next);
          setState(r.ok ? '' : 'error');
          if (!r.ok) setV(value);
        });
      }}
      className={`${CELL} min-w-[9rem] border-line bg-surface ${state === 'error' ? 'border-critical-ink' : ''} ${state === 'saving' ? 'opacity-60' : ''}`}
    >
      <option value="">—</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Remark({ id, value, label, field = 'remark', placeholder = 'Add a remark' }: { id: number; value: string; label: string; field?: 'remark' | 'callRemark'; placeholder?: string }) {
  const [saved, setSaved] = useState(value);
  const [error, setError] = useState(false);
  return (
    <input
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={async (e) => {
        const next = e.currentTarget.value.trim();
        if (next === saved) return;
        const r = await updateTrackerFieldAction(id, field, next);
        if (r.ok) {
          setSaved(next);
          setError(false);
        } else setError(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className={`${CELL} min-w-[12rem] ${error ? 'border-critical-ink' : ''}`}
    />
  );
}

export function TrackerTable({
  rows,
  options,
  showOwner,
  segments,
}: {
  segments: string[];
  rows: TrackerViewRow[];
  options: { callFeedback: readonly string[]; mailOutcome: readonly string[]; linkedinOutcome: readonly string[] };
  showOwner: boolean;
}) {
  const th = 'border-b border-r border-line px-2 py-2 text-left font-medium whitespace-nowrap';
  const td = 'border-b border-r border-line px-2 py-1.5 align-top';
  return (
    <div className="card relative overflow-x-auto">
      <table className="w-full min-w-[1800px] border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-surface-2 text-ink-2">
          <tr>
            <th className={`${th} sticky left-0 z-20 bg-surface-2`}>Company Name</th>
            <th className={th}>Location</th>
            <th className={th}>Client Name</th>
            <th className={th}>Designation</th>
            <th className={th}>Point of Contact</th>
            <th className={th}>Contact Number</th>
            <th className={th}>Email ID</th>
            <th className={th}>Call Status</th>
            <th className={th}>Call Outcome / Feedback</th>
            <th className={th}>Call Remark</th>
            <th className={th}>Calls logged</th>
            <th className={th}>Call Date</th>
            <th className={th}>Mail Outcome</th>
            <th className={th}>LinkedIn Outcome</th>
            <th className={th}>Lead Status</th>
            <th className={th}>Remark</th>
            <th className={th}>Company type</th>
            <th className={th}>Date</th>
            {showOwner && <th className={th}>Owner</th>}
          </tr>
        </thead>
        <tbody>
          <AddLeadRow segments={segments} columns={showOwner ? 19 : 18} showOwner={showOwner} />
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-2/50">
              <td className={`${td} sticky left-0 z-[5] bg-surface font-medium`}>
                <Link href={`/leads/${r.id}`} className="hover:underline">{r.cells.company}</Link>
                {r.website && <div className="font-normal text-muted">{r.website}</div>}
              </td>
              <td className={td}>{r.cells.location}</td>
              <td className={td}>
                {r.cells.name}
                {r.linkedin && (
                  <div><a href={r.linkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a></div>
                )}
              </td>
              <td className={`${td} max-w-[14rem]`}>{r.cells.title}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.poc}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.phone}</td>
              <td className={td}>{r.cells.email}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.callStatus}</td>
              <td className={`${td} p-1`}><Choice id={r.id} field="callFeedback" value={r.callFeedback} options={options.callFeedback} label={`${r.cells.company}: call outcome`} /></td>
              <td className={`${td} p-1`}><Remark id={r.id} field="callRemark" value={r.cells.callRemark} placeholder="Add a call remark" label={`${r.cells.company}: call remark`} /></td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.callsDone}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.callDate}</td>
              <td className={`${td} p-1`}><Choice id={r.id} field="mailOutcome" value={r.mailOutcome} options={options.mailOutcome} label={`${r.cells.company}: mail outcome`} /></td>
              <td className={`${td} p-1`}><Choice id={r.id} field="linkedinOutcome" value={r.linkedinOutcome} options={options.linkedinOutcome} label={`${r.cells.company}: LinkedIn outcome`} /></td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.status}</td>
              <td className={`${td} p-1`}><Remark id={r.id} value={r.remark} label={`${r.cells.company}: remark`} /></td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.segment}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.date}</td>
              {showOwner && <td className={td}>{r.cells.owner}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
