'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { syncNowAction, type SyncSummary } from '@/app/inbound-actions';

/** Sync now: starts a sync of the sheet, shows that it is working, then what it did. */
export function InboundSync() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SyncSummary | null>(null);
  const router = useRouter();
  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        onClick={() => {
          setResult(null);
          start(async () => {
            try {
              setResult(await syncNowAction());
              router.refresh();
            } catch {
              setResult({ ok: false, message: "The sync couldn't be started. Check your connection and try again.", lines: [] });
            }
          });
        }}
      >
        {pending ? 'Syncing…' : 'Sync now'}
      </button>
      {pending && <p role="status" className="max-w-sm text-right text-xs text-muted">Reading the Google Sheet and bringing the leads up to date. This can take a few seconds.</p>}
      {result && (
        <div role="status" className={`max-w-sm rounded-md border px-3 py-2 text-xs ${result.ok ? 'border-line bg-surface-2 text-ink-2' : 'border-line bg-critical-soft text-critical-ink'}`}>
          <div className="font-medium">{result.message}</div>
          {result.lines.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{result.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
