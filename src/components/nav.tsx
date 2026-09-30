'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/today', label: 'Today' },
  { href: '/', label: 'Dashboard', admin: true },
  { href: '/leads', label: 'Leads' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/leads/new', label: 'Add companies' },
  { href: '/targets', label: 'ICPs & clients', admin: true },
  { href: '/settings', label: 'Settings', admin: true },
];

export function Nav({ admin }: { admin: boolean }) {
  const path = usePathname();
  const active = (href: string) =>
    href === '/' ? path === '/' : href === '/leads' ? path === '/leads' || /^\/leads\/\d+/.test(path) : path.startsWith(href);
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {LINKS.filter((l) => admin || !l.admin).map((l) => (
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
