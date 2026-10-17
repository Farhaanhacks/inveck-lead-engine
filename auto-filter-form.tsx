'use client';
import { useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * A filter form that applies itself: ticking a box or picking an option updates the list at
 * once, and typing in a search box updates it a moment after you stop. No Apply button needed.
 */
export function AutoFilterForm({ className, children }: { className?: string; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const apply = () => {
    if (!form.current) return;
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form.current)) if (typeof v === 'string' && v.trim()) params.append(k, v.trim());
    router.replace(params.size ? `${path}?${params}` : path, { scroll: false });
  };

  return (
    <form
      ref={form}
      role="search"
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        clearTimeout(timer.current);
        apply();
      }}
      onChange={(e) => {
        const t = e.target as unknown as HTMLInputElement;
        clearTimeout(timer.current);
        if (t.type === 'search' || t.type === 'text') timer.current = setTimeout(apply, 350);
        else apply();
      }}
    >
      {children}
    </form>
  );
}
