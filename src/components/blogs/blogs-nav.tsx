'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: { label: string; items: { href: string; label: string }[] }[] = [
  {
    label: 'Workflow',
    items: [
      { href: '/blogs', label: 'Overview' },
      { href: '/blogs/topics', label: 'Topic Discovery' },
      { href: '/blogs/approvals', label: 'Topic Approvals' },
      { href: '/blogs/studio', label: 'Article Studio' },
    ],
  },
  {
    label: 'Publishing',
    items: [
      { href: '/blogs/calendar', label: 'Publishing Calendar' },
      { href: '/blogs/queue', label: 'Publishing Queue' },
      { href: '/blogs/published', label: 'Published Articles' },
      { href: '/blogs/analytics', label: 'Analytics' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/blogs/profile', label: 'Inveck Profile & Prompts' },
      { href: '/blogs/settings', label: 'Settings & Integrations' },
      { href: '/blogs/account', label: 'Account' },
    ],
  },
];

/** The Blogs profile's whole menu: the blog workflow, publishing, and its own settings and password. Nothing from the CRM. */
export function BlogsNav() {
  const path = usePathname();
  const active = (href: string) => (href === '/blogs' ? path === '/blogs' : path.startsWith(href));
  return (
    <nav className="flex flex-col gap-4 overflow-x-auto" aria-label="Blogs">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</p>
          <div className="flex gap-1 md:flex-col">
            {g.items.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active(l.href) ? 'page' : undefined}
                className={`rounded-md px-3 py-2 text-sm whitespace-nowrap ${active(l.href) ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
