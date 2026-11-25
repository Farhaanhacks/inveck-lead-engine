'use client';
import Link from 'next/link';
import { Fragment, useRef, useState, useTransition } from 'react';
import { updateTrackerContactFieldAction, updateTrackerEmailAction, updateTrackerFieldAction, updateTrackerPhoneAction } from '../../team-actions';
import { addPointOfContactAction } from '../../actions';
import { AddLeadRow } from './add-lead';
import { LI_REPLIED_LEGACY, linkedinOutcomeLabel } from '@/lib/linkedin-outcomes';

/** Someone the team added at a company beside the main contact, with their own statuses. */
export type ContactView = {
  id: number;
  name: string;
  title: string;
  phone: string;
  email: string;
  linkedin: string;
  callStatus: string;
  callFeedback: string;
  callRemark: string;
  mailOutcome: string;
  linkedinOutcome: string;
  remark: string;
};

export type TrackerViewRow = {
  id: number;
  cells: Record<string, string>;
  callStatus: string;
  autoCallStatus: string;
  callFeedback: string;
  contactChannel: string;
  autoChannel: string;
  mailOutcome: string;
  linkedinOutcome: string;
  remark: string;
  linkedin: string;
  website: string;
  origin: string;
  contacts: ContactView[];
};

type Field = 'callFeedback' | 'callStatus' | 'contactChannel' | 'mailOutcome' | 'linkedinOutcome' | 'remark' | 'callRemark';

const CELL = 'w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink hover:border-line focus:border-accent focus:outline-none';

/** A company's cell saves on the lead; an extra contact's (`contact`) on that person, so each is tracked on their own. */
const saveField = (contact: boolean) => (contact ? updateTrackerContactFieldAction : updateTrackerFieldAction);

function Choice({ id, field, value, options, label, empty = '—', narrow = false, labels = {}, contact = false }: { id: number; field: Field; value: string; options: readonly string[]; label: string; empty?: string; narrow?: boolean; labels?: Record<string, string>; contact?: boolean }) {
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
          const r = await saveField(contact)(id, field, next);
          setState(r.ok ? '' : 'error');
          if (!r.ok) setV(value);
        });
      }}
      className={`${CELL} ${narrow ? 'min-w-[7.5rem]' : 'min-w-[9rem]'} border-line bg-surface ${state === 'error' ? 'border-critical-ink' : ''} ${state === 'saving' ? 'opacity-60' : ''}`}
    >
      <option value="">{empty}</option>
      {options.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
    </select>
  );
}

function Remark({ id, value, label, field = 'remark', placeholder = 'Add a remark', contact = false }: { id: number; value: string; label: string; field?: 'remark' | 'callRemark'; placeholder?: string; contact?: boolean }) {
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
        const r = await saveField(contact)(id, field, next);
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

/** The Contact Number cell: typed in place, saved on leaving the cell (or Enter). */
function Phone({ id, value, label }: { id: number; value: string; label: string }) {
  const [saved, setSaved] = useState(value);
  const [error, setError] = useState(false);
  return (
    <input
      type="tel"
      inputMode="tel"
      aria-label={label}
      defaultValue={value}
      placeholder="Add a number"
      title={error ? 'Numbers only (digits, spaces, + - ( ) /), at least 6 digits' : undefined}
      onBlur={async (e) => {
        const input = e.currentTarget;
        const next = input.value.trim();
        if (next === saved) return;
        const r = await updateTrackerPhoneAction(id, next);
        if (r.ok) {
          setSaved(r.value ?? next);
          input.value = r.value ?? next;
          setError(false);
        } else setError(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = saved;
          setError(false);
          e.currentTarget.blur();
        }
      }}
      className={`${CELL} min-w-[9rem] ${error ? 'border-critical-ink' : ''}`}
    />
  );
}

/** The Email cell: the main contact's email, typed in place and saved on leaving the cell (or Enter), like the number. */
function Email({ id, value, label }: { id: number; value: string; label: string }) {
  const [saved, setSaved] = useState(value);
  const [error, setError] = useState(false);
  return (
    <input
      type="email"
      inputMode="email"
      aria-label={label}
      defaultValue={value}
      placeholder="Add an email"
      title={error ? 'Not an email address (one address, like name@company.com)' : undefined}
      onBlur={async (e) => {
        const input = e.currentTarget;
        const next = input.value.trim().toLowerCase();
        if (next === saved) return;
        const r = await updateTrackerEmailAction(id, next);
        if (r.ok) {
          setSaved(r.value ?? next);
          input.value = r.value ?? next;
          setError(false);
        } else setError(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = saved;
          setError(false);
          e.currentTarget.blur();
        }
      }}
      className={`${CELL} min-w-[13rem] ${error ? 'border-critical-ink' : ''}`}
    />
  );
}

/** "+ Contact" under a company: another person at it, who is then tracked on their own row. */
function AddContact({ id, company }: { id: number; company: string }) {
  const box = useRef<HTMLDetailsElement>(null);
  const [problem, setProblem] = useState(false);
  return (
    <details ref={box} className="mt-1 font-normal">
      <summary className="cursor-pointer text-xs text-accent hover:underline">+ Contact</summary>
      <form
        className="mt-1 grid w-60 gap-1"
        action={async (fd) => {
          const before = fd.get('name');
          await addPointOfContactAction(fd);
          // Nothing is added from a form with nothing valid in it: it stays open to be corrected.
          setProblem(!before && !fd.get('phone') && !fd.get('email') && !fd.get('linkedin'));
          if (before || fd.get('phone') || fd.get('email') || fd.get('linkedin')) box.current?.removeAttribute('open');
        }}
      >
        <input type="hidden" name="id" value={id} />
        {([['name', 'Name'], ['title', 'Designation'], ['phone', 'Number'], ['email', 'Email'], ['linkedin', 'LinkedIn URL']] as const).map(([n, l]) => (
          <input key={n} name={n} placeholder={l} aria-label={`${company}: new contact ${l.toLowerCase()}`} className={`${CELL} border-line bg-surface`} />
        ))}
        {problem && <span role="alert" className="text-critical-ink">Add at least a name, number, email or LinkedIn.</span>}
        <button className="btn-secondary h-7 px-2 py-0 text-xs">Add contact</button>
      </form>
    </details>
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
  options: { contactChannel: readonly string[]; callStatus: readonly string[]; callFeedback: readonly string[]; mailOutcome: readonly string[]; linkedinOutcome: readonly string[] };
  showOwner: boolean;
}) {
  const th = 'border-b border-r border-line px-2 py-2 text-left font-medium whitespace-nowrap';
  const td = 'border-b border-r border-line px-2 py-1.5 align-top';
  return (
    <div className="card relative overflow-x-auto">
      <table className="w-full min-w-[2000px] border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-surface-2 text-ink-2">
          <tr>
            <th className={`${th} sticky left-0 z-20 bg-surface-2`}>Company Name</th>
            <th className={th}>Location</th>
            <th className={th}>Client Name</th>
            <th className={th}>Designation</th>
            <th className={th}>Point of Contact</th>
            <th className={th}>Contact Number</th>
            <th className={th}>Email</th>
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
          <AddLeadRow segments={segments} columns={showOwner ? 20 : 19} showOwner={showOwner} />
          {rows.map((r) => (
            <Fragment key={r.id}>
            <tr className="hover:bg-surface-2/50">
              <td className={`${td} sticky left-0 z-[5] bg-surface font-medium`}>
                <Link href={`/leads/${r.id}`} className="hover:underline">{r.cells.company}</Link>
                {r.website && <div className="font-normal text-muted">{r.website}</div>}
                <div className="text-xs font-normal text-muted">{r.origin}</div>
                <AddContact id={r.id} company={r.cells.company} />
              </td>
              <td className={td}>{r.cells.location}</td>
              <td className={td}>
                {r.cells.name}
                {r.linkedin && (
                  <div><a href={r.linkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a></div>
                )}
              </td>
              <td className={`${td} max-w-[14rem]`}>{r.cells.title}</td>
              <td className={`${td} p-1`}>
                <Choice
                  id={r.id}
                  field="contactChannel"
                  value={r.contactChannel}
                  options={options.contactChannel}
                  empty={r.autoChannel ? `Auto: ${r.autoChannel}` : '—'}
                  narrow
                  label={`${r.cells.company}: point of contact`}
                />
              </td>
              <td className={`${td} p-1`}><Phone id={r.id} value={r.cells.phone} label={`${r.cells.company}: contact number`} /></td>
              <td className={`${td} p-1`}><Email id={r.id} value={r.cells.email} label={`${r.cells.company}: email`} /></td>
              <td className={`${td} p-1`}>
                <Choice id={r.id} field="callStatus" value={r.callStatus} options={options.callStatus} empty={`Auto: ${r.autoCallStatus}`} label={`${r.cells.company}: call status`} />
              </td>
              <td className={`${td} p-1`}><Choice id={r.id} field="callFeedback" value={r.callFeedback} options={options.callFeedback} label={`${r.cells.company}: call outcome`} /></td>
              <td className={`${td} p-1`}><Remark id={r.id} field="callRemark" value={r.cells.callRemark} placeholder="Add a call remark" label={`${r.cells.company}: call remark`} /></td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.callsDone}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.callDate}</td>
              <td className={`${td} p-1`}><Choice id={r.id} field="mailOutcome" value={r.mailOutcome} options={options.mailOutcome} label={`${r.cells.company}: mail outcome`} /></td>
              <td className={`${td} p-1`}><Choice id={r.id} field="linkedinOutcome" value={r.linkedinOutcome} options={r.linkedinOutcome === LI_REPLIED_LEGACY ? [...options.linkedinOutcome, LI_REPLIED_LEGACY] : options.linkedinOutcome} labels={{ [LI_REPLIED_LEGACY]: linkedinOutcomeLabel(LI_REPLIED_LEGACY) }} label={`${r.cells.company}: LinkedIn outcome`} /></td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.status}</td>
              <td className={`${td} p-1`}><Remark id={r.id} value={r.remark} label={`${r.cells.company}: remark`} /></td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.segment}</td>
              <td className={`${td} whitespace-nowrap`}>{r.cells.date}</td>
              {showOwner && <td className={td}>{r.cells.owner}</td>}
            </tr>
            {r.contacts.map((c) => (
              <tr key={`c${c.id}`} className="bg-surface-2/30 hover:bg-surface-2/50">
                <td className={`${td} sticky left-0 z-[5] bg-surface pl-5 font-normal text-ink-2`}>↳ {r.cells.company}</td>
                <td className={td} />
                <td className={td}>
                  {c.name}
                  {c.linkedin && <div><a href={c.linkedin} target="_blank" rel="noreferrer" className="text-accent hover:underline">LinkedIn</a></div>}
                </td>
                <td className={`${td} max-w-[14rem]`}>{c.title}</td>
                <td className={td} />
                <td className={td}>{c.phone}</td>
                <td className={td}>{c.email}</td>
                <td className={`${td} p-1`}><Choice contact id={c.id} field="callStatus" value={c.callStatus} options={options.callStatus} label={`${c.name}: call status`} /></td>
                <td className={`${td} p-1`}><Choice contact id={c.id} field="callFeedback" value={c.callFeedback} options={options.callFeedback} label={`${c.name}: call outcome`} /></td>
                <td className={`${td} p-1`}><Remark contact id={c.id} field="callRemark" value={c.callRemark} placeholder="Add a call remark" label={`${c.name}: call remark`} /></td>
                <td className={td} />
                <td className={td} />
                <td className={`${td} p-1`}><Choice contact id={c.id} field="mailOutcome" value={c.mailOutcome} options={options.mailOutcome} label={`${c.name}: mail outcome`} /></td>
                <td className={`${td} p-1`}><Choice contact id={c.id} field="linkedinOutcome" value={c.linkedinOutcome} options={c.linkedinOutcome === LI_REPLIED_LEGACY ? [...options.linkedinOutcome, LI_REPLIED_LEGACY] : options.linkedinOutcome} labels={{ [LI_REPLIED_LEGACY]: linkedinOutcomeLabel(LI_REPLIED_LEGACY) }} label={`${c.name}: LinkedIn outcome`} /></td>
                <td className={td} />
                <td className={`${td} p-1`}><Remark contact id={c.id} value={c.remark} label={`${c.name}: remark`} /></td>
                <td className={td} />
                <td className={td} />
                {showOwner && <td className={td} />}
              </tr>
            ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
