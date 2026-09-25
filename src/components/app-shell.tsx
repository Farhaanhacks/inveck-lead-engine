'use client';
import { useState, type ReactNode } from 'react';
import { SIDEBAR_COOKIE } from './sidebar-cookie';

function remember(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? 'hidden' : 'shown'}; path=/; max-age=31536000; samesite=lax`;
}

/** The page frame. The side menu can be hidden, and the choice is remembered. */
export function AppShell({ initialHidden, sidebar, children }: { initialHidden: boolean; sidebar: ReactNode; children: ReactNode }) {
  const [hidden, setHidden] = useState(initialHidden);
  const toggle = () => {
    remember(!hidden);
    setHidden(!hidden);
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[96rem] flex-col md:flex-row">
      {!hidden && (
        <aside className="relative border-b border-line px-4 py-4 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0 md:py-6">
          <button
            type="button"
            onClick={toggle}
            className="absolute top-4 right-3 rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-ink md:top-6"
            aria-label="Hide menu"
            title="Hide menu"
          >
            <span aria-hidden>«</span>
          </button>
          {sidebar}
        </aside>
      )}
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        {hidden && (
          <button type="button" onClick={toggle} className="btn-secondary mb-4 gap-2 text-sm" aria-label="Show menu">
            <span aria-hidden>☰</span> Menu
          </button>
        )}
        {children}
      </main>
    </div>
  );
}
