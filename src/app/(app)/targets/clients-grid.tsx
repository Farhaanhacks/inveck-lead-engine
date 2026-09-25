'use client';
import { useMemo, useRef, useState, useTransition, type ClipboardEvent, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import type { Client } from '@/lib/db/schema';
import {
  addClientsAction,
  importClientsFileAction,
  importClientsTextAction,
  removeClientAction,
  updateClientFieldAction,
} from '../../actions';

type Field = 'company' | 'website' | 'industry' | 'whyBought';
type Notice = { text: string; tone: 'muted' | 'good' | 'bad' };

const COLUMNS: { field: Field; label: string; width: string; placeholder: string }[] = [
  { field: 'company', label: 'Company', width: 'w-56', placeholder: 'Add a client…' },
  { field: 'website', label: 'Website', width: 'w-44', placeholder: 'company.com' },
  { field: 'industry', label: 'Industry', width: 'w-44', placeholder: 'Industry' },
  { field: 'whyBought', label: 'Why they bought INVECK', width: 'min-w-[20rem]', placeholder: 'Why they bought' },
];

const CELL =
  'block w-full min-w-0 bg-transparent px-2.5 py-2 text-sm text-ink outline-none placeholder:text-muted focus:bg-surface focus:ring-2 focus:ring-inset focus:ring-accent';
const TONE = { muted: 'text-muted', good: 'text-good-ink', bad: 'text-critical-ink' };

/** Moves focus like a spreadsheet: Enter/↓ to the row below, ↑ to the row above. */
function moveFocus(grid: HTMLElement | null, row: number | 'new', col: number, delta: 1 | -1) {
  if (!grid) return;
  const rows = grid.querySelectorAll<HTMLInputElement>(`input[data-col="${col}"]`);
  const list = [...rows];
  const index = list.findIndex((el) => el.dataset.row === String(row));
  list[index + delta]?.focus();
}

function Cell({
  client,
  field,
  row,
  col,
  label,
  grid,
  onNotice,
}: {
  client: Client;
  field: Field;
  row: number;
  col: number;
  label: string;
  grid: RefObject<HTMLDivElement | null>;
  onNotice: (n: Notice) => void;
}) {
  const [saved, setSaved] = useState(client[field]);
  const [failed, setFailed] = useState(false);

  const save = async (input: HTMLInputElement) => {
    const value = input.value.trim();
    if (value === saved) return;
    onNotice({ text: 'Saving…', tone: 'muted' });
    const r = await updateClientFieldAction(client.id, field, value);
    if (r.ok) {
      setSaved(r.value);
      setFailed(false);
      input.value = r.value;
      onNotice({ text: 'All changes saved.', tone: 'good' });
    } else {
      setFailed(true);
      if (field === 'company' && !value) input.value = saved;
      onNotice({ text: r.message || 'Couldn’t save that cell.', tone: 'bad' });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(grid.current, row, col, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(grid.current, row, col, -1);
    } else if (e.key === 'Escape') {
      e.currentTarget.value = saved;
      e.currentTarget.blur();
    }
  };

  return (
    <input
      defaultValue={client[field]}
      title={client[field] || undefined}
      aria-label={`${client.company}: ${label}`}
      data-row={row}
      data-col={col}
      onBlur={(e) => void save(e.currentTarget)}
      onKeyDown={onKeyDown}
      className={`${CELL} ${failed ? 'ring-2 ring-inset ring-critical-ink' : ''}`}
    />
  );
}

/**
 * The client list as a spreadsheet: click a cell to edit (saved when you leave it),
 * Enter moves down, Tab moves right, the last row adds a client, and rows copied from
 * Excel can be pasted into it. CSV files can be uploaded and downloaded.
 */
export function ClientsGrid({ clients }: { clients: Client[] }) {
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, startTransition] = useTransition();
  const grid = useRef<HTMLDivElement>(null);
  const newRow = useRef<HTMLFormElement>(null);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? clients.filter((c) => [c.company, c.website, c.industry, c.whyBought].some((v) => v.toLowerCase().includes(q))) : clients),
    [clients, q],
  );

  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      const r = await addClientsAction(undefined, data);
      setNotice({ text: r.message, tone: r.message.startsWith('Added') ? 'good' : 'muted' });
      if (r.message.startsWith('Added') || r.message.startsWith('Filled')) {
        form.reset();
        // The row's inputs live in the table, linked by form="new-client", so look them up via the form.
        (form.elements.namedItem('company') as HTMLInputElement | null)?.focus();
      }
    });
  };

  const pasteRows = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[\t\n]/.test(text.trim())) return; // a single value: normal paste
    e.preventDefault();
    setNotice({ text: 'Adding pasted rows…', tone: 'muted' });
    startTransition(async () => {
      const r = await importClientsTextAction(text);
      setNotice({ text: r.message, tone: r.ok ? 'good' : 'bad' });
    });
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    const data = new FormData();
    data.set('file', file);
    setNotice({ text: `Importing ${file.name}…`, tone: 'muted' });
    startTransition(async () => {
      const r = await importClientsFileAction(data);
      setNotice({ text: r.message, tone: r.ok ? 'good' : 'bad' });
    });
  };

  const remove = (c: Client) => {
    if (!window.confirm(`Remove ${c.company} from current clients? Leads from this company could then be contacted.`)) return;
    startTransition(async () => {
      await removeClientAction(c.id);
      setNotice({ text: `Removed ${c.company}.`, tone: 'muted' });
    });
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clients"
          aria-label="Search clients"
          className="field h-9 max-w-xs py-1.5"
        />
        <span className="text-xs text-muted tabular-nums">
          {q ? `${shown.length} of ${clients.length}` : clients.length} {clients.length === 1 ? 'client' : 'clients'}
        </span>
        <span className={`ml-auto text-xs ${notice ? TONE[notice.tone] : ''}`} role="status">
          {pending && !notice ? 'Working…' : notice?.text}
        </span>
        <label className={`btn-secondary h-9 cursor-pointer py-1.5 ${pending ? 'pointer-events-none opacity-50' : ''}`}>
          Upload CSV
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        <a href="/api/clients/csv" download className="btn-secondary h-9 py-1.5">
          Download CSV
        </a>
      </div>

      <form ref={newRow} id="new-client" onSubmit={add} />
      {/* relative: keeps absolutely positioned bits (screen-reader labels) inside the scroll area on phones */}
      <div ref={grid} className="relative overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="bg-surface-2 text-left text-xs text-ink-2">
              <th className="w-10 border-r border-b border-line px-2 py-2 text-center font-medium">#</th>
              {COLUMNS.map((c) => (
                <th key={c.field} className={`${c.width} border-r border-b border-line px-2.5 py-2 font-medium`}>
                  {c.label}
                </th>
              ))}
              <th className="w-12 border-b border-line">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c, i) => (
              <tr key={c.id} className="group hover:bg-surface-2/50">
                <td className="border-r border-b border-line px-2 text-center text-xs text-muted tabular-nums">{i + 1}</td>
                {COLUMNS.map((col, j) => (
                  <td key={col.field} className="border-r border-b border-line p-0">
                    <Cell
                      key={`${c.id}:${col.field}:${c[col.field]}`}
                      client={c}
                      field={col.field}
                      row={i}
                      col={j}
                      label={col.label}
                      grid={grid}
                      onNotice={setNotice}
                    />
                  </td>
                ))}
                <td className="border-b border-line text-center">
                  <button
                    type="button"
                    onClick={() => remove(c)}
                    aria-label={`Remove ${c.company}`}
                    title="Remove client"
                    className="rounded px-2 py-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-critical-soft hover:text-critical-ink focus:opacity-100"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            {q && !shown.length && (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="border-b border-line px-4 py-6 text-center text-sm text-muted">
                  No clients match “{query}”.
                </td>
              </tr>
            )}
            <tr className="bg-surface-2/40">
              <td className="border-r border-line px-2 text-center text-muted" aria-hidden>
                +
              </td>
              {COLUMNS.map((col, j) => (
                <td key={col.field} className="border-r border-line p-0">
                  <input
                    form="new-client"
                    name={col.field}
                    placeholder={col.placeholder}
                    aria-label={`New client: ${col.label}`}
                    data-row="new"
                    data-col={j}
                    onPaste={pasteRows}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveFocus(grid.current, 'new', j, -1);
                      }
                    }}
                    className={CELL}
                  />
                </td>
              ))}
              <td className="text-center">
                <button type="submit" form="new-client" disabled={pending} className="rounded px-2 py-1 text-sm font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
                  Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-3 py-2 text-xs text-muted">
        Click any cell to edit; changes save when you leave the cell. Enter moves down, Tab moves right, Esc undoes.
        Paste rows copied from Excel or Google Sheets into the last row, or upload a CSV with the columns
        Company, Website, Industry, Why they bought.
      </p>
    </div>
  );
}
