import { cookies } from 'next/headers';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { BlogsNav } from '@/components/blogs/blogs-nav';
import { Logo } from '@/components/logo';
import { SIDEBAR_COOKIE } from '@/components/sidebar-cookie';
import { blogsPage } from '@/lib/access';
import { authDisabled } from '@/lib/auth';
import { logout } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The Blogs frame: its own menu, nothing from the Lead Engine / CRM. The pages and actions check the role again (a layout alone isn't
 * a lock), and the proxy keeps the Blogs profile out of everything else.
 */
export default async function BlogsLayout({ children }: { children: React.ReactNode }) {
  const user = await blogsPage();
  const hidden = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'hidden';
  const sidebar = (
    <>
      <div className="mb-4 flex items-center justify-between pr-10 md:mb-8 md:block md:pr-0">
        <div>
          <Logo className="h-8 w-auto text-ink" />
          <div className="mt-1 text-xs text-muted">Blogs</div>
        </div>
        {!authDisabled() && (
          <form action={logout} className="md:hidden">
            <button className="text-xs text-muted hover:text-ink">Log out</button>
          </form>
        )}
      </div>
      <BlogsNav />
      {!authDisabled() && (
        <div className="mt-8 hidden px-3 md:block">
          <div className="text-sm font-medium text-ink-2">{user.name}</div>
          <div className="text-xs text-muted">{user.role === 'admin' ? 'Administrator' : 'Blogs'}</div>
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
          You are still on the starting password. <Link href="/blogs/account" className="font-medium underline">Change it now</Link>.
        </div>
      )}
      <div className="blogs-area">{children}</div>
    </AppShell>
  );
}
