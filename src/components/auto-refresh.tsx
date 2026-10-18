'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Reloads the page's data every few seconds while something is running on the server. */
export function AutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
