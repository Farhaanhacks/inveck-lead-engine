import Link from 'next/link';
import { getDb } from '@/lib/db';
import { adminPage } from '@/lib/access';
import { PERIODS, periodDays, teamReport, type Period } from '@/lib/team-report';
import { formatTime } from '@/lib/dates';
import { PageHeader } from '@/components/page-header';
import { drawPool, getDraw, runDailyDraw } from '@/lib/draw';
import { getSettings } from '@/lib/settings';
import { drawNowAction } from '@/app/team-actions';

const hours = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : '—');
const rate = (r: number | null) => (r === null ? '—' : `${r}%`);
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T00:00:00Z`));

export default async function TeamPage({ searchParams }: PageProps<'/team'>) {
  await adminPage();
  const sp = await searchParams;
  const period: Period = PERIODS.some((p) => p.key === sp.period) ? (sp.period as Period) : 'today';
  const { from, to } = periodDays(period);
  const db = await getDb();
  await runDailyDraw(db);
  const [{ people, attendance }, draw, pool, { leadsPerMorning }] = await Promise.all([teamReport(db, from, to), getDraw(db), drawPool(db), getSettings(db)]);
  const totals = people.reduce(
    (t, p) => ({ companies: t.companies + p.companiesDone, attempts: t.attempts + p.callAttempts, connected: t.connected + p.connected, meetings: t.meetings + p.meetings, won: t.won + p.won }),
    { companies: 0, attempts: 0, connected: 0, meetings: 0, won: 0 },
  );
  const th = 'px-3 py-2 text-left font-medium whitespace-nowrap';
  const td = 'px-3 py-2.5 whitespace-nowrap tabular-nums';

  return (
    <>
      <PageHeader title="Team" description="Each BDA's attendance, outreach and conversion. Only administrators see this page." />

      <nav className="mb-6 flex flex-wrap gap-1.5" aria-label="Period">
        {PERIODS.map((p) => (
          <Link
            key={p.key}
            href={p.key === 'today' ? '/team' : `/team?period=${p.key}`}
            aria-current={period === p.key ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${period === p.key ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2 hover:bg-surface-2'}`}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        {(
          [
            ['Companies completed', totals.companies],
            ['Calls attempted', totals.attempts],
            ['Connected calls', `${totals.connected}${totals.attempts ? ` (${Math.round((totals.connected / totals.attempts) * 100)}%)` : ''}`],
            ['Meetings booked', totals.meetings],
            ['Won', totals.won],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="card p-4">
            <div className="text-xs text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <section className="card mb-6 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Morning draw</h2>
            <p className="text-xs text-muted">
              Every working day at 8:00 am, {leadsPerMorning} researched leads nobody has had yet are picked at random and split evenly across the team.
            </p>
          </div>
          {(!draw || (draw.short && pool.total > 0)) && (
            <form action={drawNowAction}>
              <button className="btn-secondary px-3 py-1.5 text-sm">{draw ? `Top up to ${draw.wanted}` : 'Draw today\'s leads now'}</button>
            </form>
          )}
        </div>
        <p className="mt-3 text-sm">
          {draw ? (
            <>
              Today: <span className="font-medium tabular-nums">{draw.drawn}</span> of {draw.wanted} handed out at {formatTime(new Date(draw.at))}
              {people.length > 0 && ' (' + people.map((p) => `${p.name} ${draw.perOwner[p.id] ?? 0}`).join(', ') + ')'}.
            </>
          ) : (
            'Not drawn yet today.'
          )}{' '}
          <span className="text-ink-2">
            Ready for the next draw: <span className="tabular-nums">{pool.total}</span> {pool.total === 1 ? 'lead' : 'leads'}
            {pool.total > 0 && pool.withContact < pool.total && `, ${pool.withContact} with a named decision-maker`}.
          </span>
        </p>
        {(draw?.short || pool.total < leadsPerMorning) && (
          <p className="mt-2 text-xs text-warning-ink">
            {draw?.short ? `Only ${draw.drawn} of ${draw.wanted} were available today. ` : ''}
            {pool.total < leadsPerMorning && `The list has ${pool.total} researched ${pool.total === 1 ? 'lead' : 'leads'} left, short of the ${leadsPerMorning} needed for the next morning. Add companies to keep the draw full.`}
          </p>
        )}
      </section>

      <section className="card mb-6 overflow-x-auto">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Outreach and conversion</h2>
          <p className="text-xs text-muted">
            A company is completed when every step for it that day (call, WhatsApp, email, LinkedIn) is ticked. Connect rate is connected calls out of calls attempted. Meeting rate is meetings booked out of connected calls.
          </p>
        </div>
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-surface-2 text-xs text-ink-2">
            <tr>
              <th className={th}>BDA</th>
              <th className={th}>Leads owned</th>
              <th className={th}>Companies completed</th>
              <th className={th}>Calls attempted</th>
              <th className={th}>Connected</th>
              <th className={th}>Connect rate</th>
              <th className={th}>Emails</th>
              <th className={th}>WhatsApp</th>
              <th className={th}>LinkedIn</th>
              <th className={th}>Meetings booked</th>
              <th className={th}>Meeting rate</th>
              <th className={th}>Won</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {people.map((p) => (
              <tr key={p.id}>
                <td className={`${td} font-medium`}><Link href={`/today?user=${p.id}`} className="hover:underline">{p.name}</Link></td>
                <td className={td}>{p.leadsOwned}</td>
                <td className={td}>{p.companiesDone}</td>
                <td className={td}>{p.callAttempts}</td>
                <td className={td}>{p.connected}</td>
                <td className={td}>{rate(p.connectRate)}</td>
                <td className={td}>{p.emails}</td>
                <td className={td}>{p.whatsapp}</td>
                <td className={td}>{p.linkedin}</td>
                <td className={td}>{p.meetings}</td>
                <td className={td}>{rate(p.meetingRate)}</td>
                <td className={td}>{p.won}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Attendance</h2>
          <p className="text-xs text-muted">Clock-in and clock-out times as each person pressed them, plus when they first and last used the app that day. Indian time.</p>
        </div>
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface-2 text-xs text-ink-2">
            <tr>
              <th className={th}>Day</th>
              <th className={th}>BDA</th>
              <th className={th}>Clocked in</th>
              <th className={th}>Clocked out</th>
              <th className={th}>Time clocked</th>
              <th className={th}>First seen</th>
              <th className={th}>Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {attendance.map((a) => (
              <tr key={`${a.day}-${a.name}`}>
                <td className={td}>{dayLabel(a.day)}</td>
                <td className={`${td} font-medium`}>{a.name}</td>
                <td className={td}>{a.clockInAt ? formatTime(a.clockInAt) : <span className="text-warning-ink">Did not clock in</span>}</td>
                <td className={td}>{a.clockOutAt ? formatTime(a.clockOutAt) : a.clockInAt ? <span className="text-muted">Still clocked in</span> : '—'}</td>
                <td className={td}>{a.clockInAt && a.clockOutAt ? hours((a.clockOutAt.getTime() - a.clockInAt.getTime()) / 60000) : '—'}</td>
                <td className={td}>{formatTime(a.firstSeenAt)}</td>
                <td className={td}>{formatTime(a.lastSeenAt)}</td>
              </tr>
            ))}
            {!attendance.length && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted">Nobody used the app in this period.</td></tr>
            )}
          </tbody>
        </table>
        {people.some((p) => p.daysPresent === 0) && (
          <p className="border-t border-line px-4 py-3 text-xs text-warning-ink">
            Not seen in this period: {people.filter((p) => p.daysPresent === 0).map((p) => p.name).join(', ')}
          </p>
        )}
      </section>
    </>
  );
}
