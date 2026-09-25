'use client';
import { useState, useTransition } from 'react';
import { scanRadarAction } from '@/app/actions';

export function RadarScanButton() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  return (
    <div className="flex items-center gap-2">
      {message && <span className="text-xs text-muted" role="status">{message}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMessage('');
            const r = await scanRadarAction();
            setMessage(r.message);
          })
        }
        className="btn-secondary h-8 py-1 text-xs"
      >
        {pending ? 'Scanning the news…' : 'Scan now'}
      </button>
    </div>
  );
}
