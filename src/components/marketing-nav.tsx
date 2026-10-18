'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/marketing/calendar', label: 'Content Calendar' },
  { href: '/marketing/overview', label: 'Overview' },
  { href: '/marketing/account', label: 'Account' },
];

/** The Marketing profile's whole menu: the calendar, its overview, and its own password. */
export function MarketingNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Marketing">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={path.startsWith(l.href) ? 'page' : undefined}
          className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${
            path.startsWith(l.href) ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
