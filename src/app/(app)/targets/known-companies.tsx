'use client';
import { useState, useTransition } from 'react';
import { clearKnownCompaniesAction, importKnownCompaniesAction } from '@/app/actions';

/** Upload of the companies already in INVECK's own lead lists, which the prospect search and radar skip. */
export function KnownCompanies({ count, sample }: { count: number; sample: string[] }) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const upload = (file: File | undefined) => {
    if (!file) return;
    const data = new FormData();
    data.set('file', file);
    setNotice({ text: `Importing ${file.name}…`, ok: true });
    startTransition(async () => {
      const r = await importKnownCompaniesAction(data);
      setNotice({ text: r.message, ok: r.ok });
    });
  };

  const clear = () => {
    if (!window.confirm(`Remove all ${count} companies from this list? The prospect search could then find them again.`)) return;
    startTransition(async () => {
      await clearKnownCompaniesAction();
      setNotice({ text: 'List emptied.', ok: true });
    });
  };

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          <span className="font-semibold tabular-nums">{count}</span> {count === 1 ? 'company' : 'companies'} on the list
        </span>
        <span className={`text-xs ${notice?.ok === false ? 'text-critical-ink' : 'text-muted'}`} role="status">
          {pending && !notice ? 'Working…' : notice?.text}
        </span>
        <div className="ml-auto flex gap-2">
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
          {count > 0 && (
            <button type="button" onClick={clear} disabled={pending} className="btn-secondary h-9 py-1.5">
              Remove all
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        A CSV with a Company column (Website optional, other columns ignored). Uploading again adds to the list; companies already on it are skipped.
      </p>
      {sample.length > 0 && <p className="mt-2 truncate text-xs text-ink-2" title={sample.join(', ')}>Includes {sample.join(', ')}{count > sample.length ? '…' : ''}</p>}
    </div>
  );
}
