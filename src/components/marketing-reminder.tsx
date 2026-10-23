'use client';
import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { PlatformLogo } from './platform-logo';
import { PLATFORM_LABEL, type ContentPlatform } from '@/lib/content-meta';

export type DuePost = { id: number; title: string; platform: ContentPlatform; scheduledOn: string };

/** The viewer's own date (YYYY-MM-DD), not the server's. */
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const KEY = (day: string) => `marketing-reminder-dismissed:${day}`;
const CHANGED = 'marketing-reminder-changed';
const subscribe = (cb: () => void) => {
  window.addEventListener(CHANGED, cb);
  return () => window.removeEventListener(CHANGED, cb);
};
const readDismissed = () => {
  try {
    return localStorage.getItem(KEY(localDay())) ?? '[]';
  } catch {
    return '[]';
  }
};

/**
 * What is to be posted today: content scheduled for the viewer's current date and not posted yet, one line per piece
 * (never twice, whatever the list holds), with its title and platform. Each one can be dismissed for the day.
 */
export function MarketingReminder({ posts }: { posts: DuePost[] }) {
  // Nothing is drawn on the server (it doesn't know the viewer's date); the browser fills it in.
  const day = useSyncExternalStore(subscribe, () => localDay(), () => '');
  const stored = useSyncExternalStore(subscribe, readDismissed, () => '[]');
  const [session, setSession] = useState<number[]>([]);
  if (!day) return null;
  let saved: number[] = [];
  try {
    saved = JSON.parse(stored);
  } catch {
    saved = [];
  }
  const seen = new Set<number>();
  const due = posts.filter((p) => p.scheduledOn === day && !saved.includes(p.id) && !session.includes(p.id) && !seen.has(p.id) && seen.add(p.id));
  if (!due.length) return null;
  const dismiss = (id: number) => {
    setSession((s) => [...s, id]);
    try {
      localStorage.setItem(KEY(day), JSON.stringify([...saved, id]));
      window.dispatchEvent(new Event(CHANGED));
    } catch {
      // not remembered across visits: it shows again next time
    }
  };
  return (
    <section role="status" aria-label="To post today" className="glass mb-5 rounded-2xl p-4">
      <h2 className="text-sm font-semibold">To post today <span className="font-normal text-muted tabular-nums">({due.length})</span></h2>
      <ul className="mt-2 space-y-1.5">
        {due.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-sm">
            <PlatformLogo platform={p.platform} size={18} />
            <span className="min-w-0 flex-1 truncate"><span className="font-medium">{p.title}</span> <span className="text-muted">on {PLATFORM_LABEL[p.platform]}</span></span>
            <Link href="/marketing/content-bank" className="text-xs text-accent hover:underline">Open</Link>
            <button type="button" onClick={() => dismiss(p.id)} className="text-xs text-muted hover:text-ink" aria-label={`Dismiss the reminder for ${p.title}`}>Dismiss</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
