import { cookies } from 'next/headers';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { Logo } from '@/components/logo';
import { MarketingNav } from '@/components/marketing-nav';
import { MarketingReminder } from '@/components/marketing-reminder';
import { addDays } from '@/lib/content-meta';
import { dueOn } from '@/lib/content-calendar';
import { getDb } from '@/lib/db';
import { istDay } from '@/lib/tasks';
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
  // Content to post today. The browser picks the ones for its own date, so the days either side of India's are sent too.
  const today = istDay();
  const due = (await dueOn(await getDb(), [addDays(today, -1), today, addDays(today, 1)])).map((p) => ({ id: p.id, title: p.title, platform: p.platform, scheduledOn: p.scheduledOn }));
  return (
    <AppShell initialHidden={hidden} sidebar={sidebar} showRunStatus={false}>
      {user.mustChangePassword && (
        <div className="mb-6 rounded-lg border border-line bg-warning-soft px-4 py-3 text-sm text-warning-ink" role="status">
          You are still on the starting password. <Link href="/marketing/account" className="font-medium underline">Change it now</Link>.
        </div>
      )}
      <MarketingReminder posts={due} />
      {children}
    </AppShell>
  );
}
