'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/leads', label: 'Leads' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/leads/new', label: 'Add companies' },
  { href: '/targets', label: 'ICPs & clients' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const path = usePathname();
  const active = (href: string) =>
    href === '/' ? path === '/' : href === '/leads' ? path === '/leads' || /^\/leads\/\d+/.test(path) : path.startsWith(href);
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${
            active(l.href) ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
