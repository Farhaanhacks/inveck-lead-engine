import { cookies } from 'next/headers';
import { Nav } from '@/components/nav';
import { Logo } from '@/components/logo';
import { AppShell } from '@/components/app-shell';
import { SIDEBAR_COOKIE } from '@/components/sidebar-cookie';
import { logout } from '../actions';
import { authDisabled } from '@/lib/auth';

// Every page reads live data from the database.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const hidden = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'hidden';
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
      {!authDisabled() && (
        <form action={logout} className="mt-8 hidden md:block">
          <button className="px-3 text-xs text-muted hover:text-ink">Log out</button>
        </form>
      )}
    </>
  );
  return (
    <AppShell initialHidden={hidden} sidebar={sidebar}>
      {children}
    </AppShell>
  );
}
