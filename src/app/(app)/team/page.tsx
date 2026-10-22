import Link from 'next/link';
import { getDb } from '@/lib/db';
import { adminPage } from '@/lib/access';
import { PERIODS, periodDays, teamReport, type Period } from '@/lib/team-report';
import { formatTime } from '@/lib/dates';
import { PageHeader } from '@/components/page-header';
import { DRAW_SEGMENTS, drawPool, getDraw, handedOut, quotaOf, quotaTotal, runDailyDraw, shortfalls, teamQuotas, teamTotal, topUpDraw } from '@/lib/draw';
import { LOGISTICS, MANUFACTURING } from '@/lib/db/seed';
import { istDay } from '@/lib/tasks';
import { CA_PER_ASSOCIATE, getCaDraw, runCaDraw } from '@/lib/ca-sheet';
import { googleCredentials } from '@/lib/google-sheet';
import { getSettings } from '@/lib/settings';
import { drawNowAction, saveDrawQuotaAction } from '@/app/team-actions';
import { refetchProgress, startRefetchIfWaiting } from '@/lib/run-driver';

const hours = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : '—');
const rate = (r: number | null) => (r === null ? '—' : `${r}%`);
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${d}T00:00:00Z`));

// A run picked up again from here (see startRefetchIfWaiting) works in this invocation.
export const maxDuration = 300;

export default async function TeamPage({ searchParams }: PageProps<'/team'>) {
  await adminPage();
  const sp = await searchParams;
  const period: Period = PERIODS.some((p) => p.key === sp.period) ? (sp.period as Period) : 'today';
  const { from, to } = periodDays(period);
  const db = await getDb();
  await runDailyDraw(db);
  await topUpDraw(db);
  await runCaDraw(db).catch(() => null);
  const caConfigured = !!googleCredentials();
  const caDraw = await getCaDraw(db);
  await startRefetchIfWaiting();
  const refetch = await refetchProgress();
  const resetRecent = refetch.recent;
  const [{ people, attendance }, draw, pool, drawSettings, hands] = await Promise.all([teamReport(db, from, to), getDraw(db), drawPool(db), getSettings(db), handedOut(db, istDay())]);
  // Per associate: their own quota in each segment (the Settings one for anyone without their own numbers).
  const fallback = quotaOf(drawSettings);
  const own = await teamQuotas(db, drawSettings);
  const quotaFor = (id: number) => own.get(id) ?? fallback;
  const quotas = new Map(people.map((p) => [p.id, quotaFor(p.id)]));
  const team = teamTotal(quotas);
  const teamWanted = quotaTotal(team);
  const teamDrawn = people.reduce((n, p) => n + (hands[String(p.id)]?.[MANUFACTURING] ?? 0) + (hands[String(p.id)]?.[LOGISTICS] ?? 0), 0);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const shortage = shortfalls(quotas, hands);
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

      {(refetch.waiting > 0 || resetRecent) && (
        <section className={`card mb-6 p-4 ${refetch.waiting ? 'border-warning-ink/40' : ''}`}>
          <h2 className="text-sm font-semibold">Contacts reset</h2>
          <p className="mt-1 text-sm">
            {refetch.waiting
              ? `All saved contacts were cleared. Finding them again with the current rules: ${refetch.waiting} ${refetch.waiting === 1 ? 'company' : 'companies'} still to go. This page updates when you reload it.`
              : 'Done: every company has had its contacts found again from scratch with the current rules.'}
          </p>
          <p className="mt-1 text-xs text-muted">Fresh start: every lead starts again unassigned, with no calls, outcomes or stages; the morning draw hands them out.</p>
        </section>
      )}

      <section className="card mb-6 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Morning draw</h2>
            <p className="text-xs text-muted">
              Every working day at 8:00 am, each associate is handed their daily list of researched leads nobody has had yet, per segment, picked at random: the numbers in the table, set per person (anyone without their own gets {fallback[MANUFACTURING]} {MANUFACTURING} + {fallback[LOGISTICS]} {LOGISTICS} from Settings). Team-wide
              that is {teamWanted} a day ({team[MANUFACTURING]} {MANUFACTURING} + {team[LOGISTICS]} {LOGISTICS}). A segment that runs short is never filled from the other segment or from CA firms.
            </p>
          </div>
          {(!draw || (draw.short && pool.total > 0)) && (
            <form action={drawNowAction}>
              <button className="btn-secondary px-3 py-1.5 text-sm">{draw ? 'Top up the shortfalls' : 'Draw today\'s leads now'}</button>
            </form>
          )}
        </div>
        <p className="mt-3 text-sm">
          {draw ? (
            <>
              Team-wide today: <span className="font-medium tabular-nums">{teamDrawn}</span> of {teamWanted} handed out (first draw at {formatTime(new Date(draw.at))}).
            </>
          ) : (
            'Not drawn yet today.'
          )}{' '}
          <span className="text-ink-2">
            Ready for the next draw: <span className="tabular-nums">{pool.bySegment[MANUFACTURING]}</span> {MANUFACTURING}, <span className="tabular-nums">{pool.bySegment[LOGISTICS]}</span> {LOGISTICS}
            {pool.total > 0 && pool.withContact < pool.total && ` (${pool.withContact} with a named decision-maker)`}.
          </span>
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-xs text-ink-2">
              <tr>
                <th className={th}>Associate</th>
                {DRAW_SEGMENTS.map((s) => (
                  <th key={s} className={th}>{s} today</th>
                ))}
                <th className={th}>Total today</th>
                <th className={th}>Daily list</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {people.map((p) => {
                const h = hands[String(p.id)];
                const quota = quotaFor(p.id);
                return (
                  <tr key={p.id}>
                    <td className={`${td} font-medium`}>{p.name}</td>
                    {DRAW_SEGMENTS.map((s) => {
                      const got = h?.[s] ?? 0;
                      return (
                        <td key={s} className={td}>
                          {got} <span className="text-xs text-muted">of {quota[s]}</span>
                          {got < quota[s] && draw && <span className="ml-1 text-xs text-warning-ink">{quota[s] - got} short</span>}
                        </td>
                      );
                    })}
                    <td className={td}>
                      {(h?.[MANUFACTURING] ?? 0) + (h?.[LOGISTICS] ?? 0)} <span className="text-xs text-muted">of {quotaTotal(quota)}</span>
                    </td>
                    <td className={td}>
                      <form action={saveDrawQuotaAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="userId" value={p.id} />
                        <label className="sr-only" htmlFor={`m-${p.id}`}>{p.name}: {MANUFACTURING} a day</label>
                        <input id={`m-${p.id}`} name="manufacturing" type="number" min={0} max={200} defaultValue={quota[MANUFACTURING]} className="field h-8 w-16 py-1 text-sm" />
                        <span className="text-xs text-muted">Mfg +</span>
                        <label className="sr-only" htmlFor={`l-${p.id}`}>{p.name}: {LOGISTICS} a day</label>
                        <input id={`l-${p.id}`} name="logistics" type="number" min={0} max={200} defaultValue={quota[LOGISTICS]} className="field h-8 w-16 py-1 text-sm" />
                        <span className="text-xs text-muted">3PL</span>
                        <button className="btn-secondary px-2 py-1 text-xs">Save</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shortage.length > 0 && draw && (
          <p className="mt-2 text-xs text-warning-ink">
            Shortfall: {shortage.map((s) => `${names.get(s.owner) ?? 'Associate'} ${s.short} ${s.segment}`).join('; ')}. They are topped up as soon as more {pool.total === 0 ? 'researched leads' : 'leads'} are available the same day.
          </p>
        )}
        {pool.bySegment[MANUFACTURING] < team[MANUFACTURING] || pool.bySegment[LOGISTICS] < team[LOGISTICS] ? (
          <p className="mt-2 text-xs text-warning-ink">
            The list is short of tomorrow&apos;s need ({team[MANUFACTURING]} {MANUFACTURING} and {team[LOGISTICS]} {LOGISTICS}). The 6 am run searches for what is short; companies added by hand count too.
          </p>
        ) : null}
      </section>

      <section className="card mb-6 p-4">
        <h2 className="text-sm font-semibold">CA firms from the Google Sheet</h2>
        <p className="text-xs text-muted">
          Every working day Anchal and Puja are each given {CA_PER_ASSOCIATE} CA firms picked at random from the master sheet, {CA_PER_ASSOCIATE * 2} in all, never a firm given before. They are separate from the Manufacturing and 3PL draw above, and never fill it.
        </p>
        {!caConfigured ? (
          <p className="mt-2 text-xs text-warning-ink">The sheet isn&apos;t connected yet: add the service-account key as GOOGLE_SERVICE_ACCOUNT_JSON on the server (see the README).</p>
        ) : caDraw ? (
          <>
            <p className="mt-3 text-sm">
              Today: <span className="font-medium tabular-nums">{caDraw.drawn}</span> of {caDraw.wanted} given ({caDraw.perAssociate.map((a) => `${a.name} ${a.drawn} of ${a.wanted}`).join(', ')}).{' '}
              {caDraw.remaining !== null && <span className="text-ink-2">Left in the sheet for the next draw: <span className="tabular-nums">{caDraw.remaining}</span>.</span>}
            </p>
            {caDraw.short && !caDraw.problem && (
              <p className="mt-2 text-xs text-warning-ink">
                Shortfall: {caDraw.perAssociate.filter((a) => a.drawn < a.wanted).map((a) => `${a.name} ${a.wanted - a.drawn} short`).join('; ')}. The sheet has no more eligible firms; the draw checks again about every half hour today.
              </p>
            )}
            {caDraw.problem && <p className="mt-2 text-xs text-warning-ink">{caDraw.problem}.</p>}
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-2">Not drawn yet today (it runs from 8:00 am on working days).</p>
        )}
      </section>

      <section className="card mb-6 overflow-x-auto">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Outreach and conversion</h2>
          <p className="text-xs text-muted">
            A company is completed when every step for it that day (call, WhatsApp, email, LinkedIn) is ticked. Connect rate is connected calls out of calls attempted. Meetings booked counts every call logged as Demo scheduled, plus leads moved to Meeting Booked on the pipeline board. Meeting rate is meetings booked out of connected calls.
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
