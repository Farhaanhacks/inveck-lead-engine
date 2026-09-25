import { Nav } from '@/components/nav';
import { Logo } from '@/components/logo';
import { logout } from '../actions';
import { authDisabled } from '@/lib/auth';

// Every page reads live data from the database.
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col md:flex-row">
      <aside className="border-b border-line px-4 py-4 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0 md:py-6">
        <div className="mb-4 flex items-center justify-between md:mb-8 md:block">
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
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
