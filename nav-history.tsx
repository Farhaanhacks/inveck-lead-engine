'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

// The page someone came from, remembered in this tab, so a lead page's back link returns there
// (Today, the tracker, Contacts…) instead of always to Leads. Filters and search on that page are kept.
const CURRENT = 'inveck:nav:current';
const PREVIOUS = 'inveck:nav:previous';

function read(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function write(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked: the back link falls back to Leads.
  }
}
const pathOf = (url: string) => url.split('?')[0];

/** Records each page visited in this tab (once, in the app layout). */
export function NavHistory() {
  const pathname = usePathname();
  useEffect(() => {
    const now = `${window.location.pathname}${window.location.search}`;
    const before = read(CURRENT);
    // A new page: the one before becomes "previous". The same page with other filters only updates it.
    if (before && pathOf(before) !== pathOf(now)) write(PREVIOUS, before);
    write(CURRENT, now);
  }, [pathname]);
  // Filters change the address without a new page: keep the latest version of this page.
  useEffect(() => {
    const keep = () => write(CURRENT, `${window.location.pathname}${window.location.search}`);
    window.addEventListener('popstate', keep);
    const id = window.setInterval(keep, 1500);
    return () => {
      window.removeEventListener('popstate', keep);
      window.clearInterval(id);
    };
  }, []);
  return null;
}

const LABELS: [RegExp, string][] = [
  [/^\/today/, 'Today'],
  [/^\/tracker/, 'Tracker'],
  [/^\/contacts/, 'Contacts'],
  [/^\/pipeline/, 'Pipeline'],
  [/^\/leads\/\d+/, 'Back'],
  [/^\/leads/, 'Leads'],
  [/^\/targets/, 'ICPs & clients'],
  [/^\/$/, 'Dashboard'],
];

/** "‹ Today": back to the page this one was opened from; Leads when there's none. */
export function BackLink({ fallback = '/leads', fallbackLabel = 'Leads' }: { fallback?: string; fallbackLabel?: string }) {
  // Read from this tab's history once on the client (the server has none: it shows the fallback).
  const prev = useSyncExternalStore(
    () => () => {},
    // Before this page is recorded, the last page recorded is the one just left; after, it's "previous".
    () => {
      const current = read(CURRENT);
      return current && pathOf(current) !== window.location.pathname ? current : read(PREVIOUS);
    },
    () => '',
  );
  const here = usePathname();
  const label = prev && pathOf(prev) !== here ? LABELS.find(([re]) => re.test(pathOf(prev)))?.[1] : undefined;
  const to = label ? { href: prev, label } : { href: fallback, label: fallbackLabel };
  return (
    <Link href={to.href} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
      <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3 5 8l5 5" /></svg>
      {to.label}
    </Link>
  );
}
