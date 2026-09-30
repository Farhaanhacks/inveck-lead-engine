import { cookies } from 'next/headers';
import { Nav } from '@/components/nav';
import { Logo } from '@/components/logo';
import { AppShell } from '@/components/app-shell';
import { SIDEBAR_COOKIE } from '@/components/sidebar-cookie';
import { logout } from '../actions';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/users';
import { getDb } from '@/lib/db';
import { recordPresence } from '@/lib/attendance';
import { authDisabled } from '@/lib/auth';

// Every page reads live data from the database.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const hidden = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'hidden';
  const user = await getCurrentUser();
  // Being in the app counts as being at work: first and last time seen each day.
  if (user?.role === 'bda') await recordPresence(await getDb(), user.id).catch(() => {});
  const sidebar = (
    <>
      <div className="mb-4 flex items-center justify-between pr-10 md:mb-8 md:block md:pr-0">
        <div>
          <Logo className="h-8 w-auto text-ink" />
          <div className="mt-1 text-xs text-muted">Lead Engine</div>
        </div>
        {!authDisabled() && (
          <form action={logout} className="md:hidden">
            <button className="text-xs text-muted hover:text-ink">Log out</button>
          </form>
        )}
      </div>
      <Nav />
      {user && !authDisabled() && (
        <div className="mt-8 hidden px-3 md:block">
          <Link href="/account" className="block text-sm font-medium text-ink-2 hover:text-ink">{user.name}</Link>
          <div className="text-xs text-muted">{user.role === 'admin' ? 'Administrator' : 'BDA'}</div>
          <form action={logout} className="mt-2">
            <button className="text-xs text-muted hover:text-ink">Log out</button>
          </form>
        </div>
      )}
    </>
  );
  return (
    <AppShell initialHidden={hidden} sidebar={sidebar}>
      {user?.mustChangePassword && (
        <div className="mb-6 rounded-lg border border-line bg-warning-soft px-4 py-3 text-sm text-warning-ink" role="status">
          You are still on the starting password. <Link href="/account" className="font-medium underline">Change it now</Link>.
        </div>
      )}
      {children}
    </AppShell>
  );
}
