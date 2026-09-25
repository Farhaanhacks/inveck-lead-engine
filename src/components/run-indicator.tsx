'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/** "● Research running" in the side menu while a run is going, on every page. */
export function RunIndicator() {
  const [run, setRun] = useState<{ id: number; processed: number } | null>(null);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/runs/active', { cache: 'no-store' });
        if (res.ok && !stop) setRun(await res.json());
      } catch {}
    };
    void check();
    const timer = setInterval(check, 8000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  if (!run) return null;
  return (
    <Link href="/#activity" className="mt-4 flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-xs font-medium text-accent">
      <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
      Research running · {run.processed} done
    </Link>
  );
}
