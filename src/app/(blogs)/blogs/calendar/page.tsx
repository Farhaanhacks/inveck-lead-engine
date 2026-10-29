import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import Link from 'next/link';
import { AutoRefresh } from '@/components/blogs/auto-refresh';
import { SubmitButton } from '@/components/blogs/submit-button';
import { Badge, EmptyState, Notice, PageHeader } from '@/components/blogs/ui';
import { postState } from '@/lib/blogs/status';
import { getDb } from '@/lib/blogs/db/client';
import { articles, publishedPosts } from '@/lib/blogs/db/schema';
import { localDayKey } from '@/lib/blogs/publishing/slots';
import { getSetting } from '@/lib/blogs/settings';
import { zonedTimeToUtc } from '@/lib/blogs/time';
import { cancelSchedule } from '../publishing/actions';

export const dynamic = 'force-dynamic';

type View = 'day' | 'week' | 'month';
const dayParts = (key: string) => key.split('-').map(Number) as [number, number, number];
const shift = (key: string, days: number) => {
  const [y, m, d] = dayParts(key);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const weekdayOf = (key: string) => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0

export default async function CalendarPage({ searchParams }: PageProps<'/blogs/calendar'>) {
  const sp = await searchParams;
  const { saved, error } = sp;
  const { timezone } = await getSetting('queue');
  const view: View = sp.view === 'day' || sp.view === 'month' ? sp.view : 'week';
  const today = localDayKey(timezone, new Date());
  const anchor = typeof sp.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;

  let first: string, last: string; // inclusive local day keys
  if (view === 'day') { first = last = anchor; }
  else if (view === 'week') { first = shift(anchor, -weekdayOf(anchor)); last = shift(first, 6); }
  else {
    const [y, m] = dayParts(anchor);
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    first = shift(monthStart, -weekdayOf(monthStart));
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    last = shift(monthEnd, 6 - weekdayOf(monthEnd));
  }
  const [fy, fm, fd] = dayParts(first);
  const [ly, lm, ld] = dayParts(shift(last, 1));
  const from = zonedTimeToUtc(timezone, fy, fm, fd);
  const to = zonedTimeToUtc(timezone, ly, lm, ld);

  const rows = await (await getDb())
    .select({ p: publishedPosts, title: articles.title, category: articles.category })
    .from(publishedPosts)
    .innerJoin(articles, eq(articles.id, publishedPosts.articleId))
    .where(and(inArray(publishedPosts.status, ['scheduled', 'publishing', 'delayed', 'published', 'failed']), gte(publishedPosts.scheduledFor, from), lt(publishedPosts.scheduledFor, to)))
    .orderBy(asc(publishedPosts.scheduledFor));

  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = localDayKey(timezone, r.p.scheduledFor!);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  const days: string[] = [];
  for (let k = first; k <= last; k = shift(k, 1)) days.push(k);

  const step = view === 'day' ? 1 : view === 'week' ? 7 : 30;
  const nav = (date: string, v: View = view) => `/blogs/calendar?view=${v}&date=${date}`;
  const label = view === 'month' ? new Date(`${anchor}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : view === 'week' ? `${first} to ${last}` : anchor;
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(d);
  const here = `/blogs/calendar?view=${view}&date=${anchor}`;
  const now = new Date();
  const active = rows.some((r) => postState(r.p, now).active);

  const Card = ({ r }: { r: (typeof rows)[number] }) => (
    <li className="rounded-md border border-border bg-surface p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1"><span className="font-medium tabular-nums">{time(r.p.scheduledFor!)}</span>{(() => { const st = postState(r.p, now); return <Badge tone={st.tone}>{st.label}</Badge>; })()}{r.p.isMock && r.p.status !== 'published' ? <Badge tone="warn">mock</Badge> : null}</div>
      <Link href={`/blogs/studio/${r.p.articleId}`} className="mt-1 block font-medium underline underline-offset-2">{r.title}</Link>
      {r.category ? <span className="text-muted">{r.category}</span> : null}
      {['scheduled', 'delayed', 'failed'].includes(r.p.status) ? (
        <div className="mt-1 flex gap-2">
          <Link href={`/blogs/studio/${r.p.articleId}`} className="underline underline-offset-2">Reschedule</Link>
          <form action={cancelSchedule.bind(null, r.p.id, here)}><SubmitButton pendingLabel="Cancelling…" className="!px-2 !py-0.5 !text-xs">Cancel</SubmitButton></form>
        </div>
      ) : null}
    </li>
  );

  return (
    <>
      <PageHeader title="Publishing Calendar" description={`Times shown in ${timezone}.`} />
      <div className="space-y-4">
        {saved ? <Notice tone="ok" title={String(saved)} /> : null}
        {error ? <Notice tone="danger" title={String(error)} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="View">
            {(['day', 'week', 'month'] as const).map((v) => <Link key={v} href={nav(anchor, v)} aria-current={v === view ? 'page' : undefined} className={v === view ? 'btn-primary' : 'btn'}>{v[0].toUpperCase() + v.slice(1)}</Link>)}
          </div>
          <Link className="btn" href={nav(shift(anchor, -step))} aria-label="Previous">←</Link>
          <Link className="btn" href={nav(today)}>Today</Link>
          <Link className="btn" href={nav(shift(anchor, step))} aria-label="Next">→</Link>
          <span className="ml-2 text-sm font-medium">{label}</span>
          <span className="ml-auto"><AutoRefresh active={active} /></span>
        </div>

        {!rows.length && view !== 'month' ? <EmptyState title="Nothing in this period" /> : null}

        {view === 'day' ? (
          <ul className="space-y-2">{(byDay.get(anchor) ?? []).map((r) => <Card key={r.p.id} r={r} />)}</ul>
        ) : (
          <div className={`grid gap-2 ${view === 'week' ? 'md:grid-cols-7' : 'grid-cols-1 md:grid-cols-7'}`}>
            {days.map((k) => {
              const items = byDay.get(k) ?? [];
              const inMonth = view !== 'month' || k.slice(0, 7) === anchor.slice(0, 7);
              return (
                <section key={k} aria-label={k} className={`card min-h-24 p-2 ${inMonth ? '' : 'opacity-50'} ${k === today ? 'border-accent' : ''}`}>
                  <Link href={nav(k, 'day')} className="text-xs font-medium underline underline-offset-2">{new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: view === 'month' ? undefined : 'short', timeZone: 'UTC' })}</Link>
                  <ul className="mt-2 space-y-2">{items.map((r) => <Card key={r.p.id} r={r} />)}</ul>
                </section>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted">Showing {rows.length} item(s).</p>
      </div>
    </>
  );
}
