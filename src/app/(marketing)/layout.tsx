import { cookies } from 'next/headers';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { Logo } from '@/components/logo';
import { MarketingNav } from '@/components/marketing-nav';
import { SIDEBAR_COOKIE } from '@/components/sidebar-cookie';
import { marketingPage } from '@/lib/access';
import { authDisabled } from '@/lib/auth';
import { logout } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The Marketing frame: its own small menu, nothing from the Lead Engine. The pages check the role again
 * (a layout alone isn't a lock), and the proxy keeps this profile out of everything else.
 */
export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const user = await marketingPage();
  const hidden = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'hidden';
  const sidebar = (
    <>
      <div className="mb-4 flex items-center justify-between pr-10 md:mb-8 md:block md:pr-0">
        <div>
          <Logo className="h-8 w-auto text-ink" />
          <div className="mt-1 text-xs text-muted">Marketing</div>
        </div>
        {!authDisabled() && (
          <form action={logout} className="md:hidden">
            <button className="text-xs text-muted hover:text-ink">Log out</button>
          </form>
        )}
      </div>
      <MarketingNav />
      {!authDisabled() && (
        <div className="mt-8 hidden px-3 md:block">
          <div className="text-sm font-medium text-ink-2">{user.name}</div>
          <div className="text-xs text-muted">{user.role === 'admin' ? 'Administrator' : 'Marketing'}</div>
          <form action={logout} className="mt-2">
            <button className="text-xs text-muted hover:text-ink">Log out</button>
          </form>
        </div>
      )}
    </>
  );
  return (
    <AppShell initialHidden={hidden} sidebar={sidebar} showRunStatus={false}>
      {user.mustChangePassword && (
        <div className="mb-6 rounded-lg border border-line bg-warning-soft px-4 py-3 text-sm text-warning-ink" role="status">
          You are still on the starting password. <Link href="/marketing/account" className="font-medium underline">Change it now</Link>.
        </div>
      )}
      <div className="relative isolate">
        {/* Flat pastel shapes behind the frosted glass, so the blur has something to soften. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute -top-6 right-6 h-64 w-64 rounded-full bg-rose-soft" />
          <div className="absolute top-72 -left-10 h-72 w-72 rounded-full bg-violet-soft" />
          <div className="absolute right-1/4 bottom-10 h-60 w-60 rounded-full bg-teal-soft" />
          <div className="absolute top-24 left-1/3 h-40 w-40 rounded-full bg-accent-soft" />
        </div>
        {children}
      </div>
    </AppShell>
  );
}
