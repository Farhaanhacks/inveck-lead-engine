import Link from 'next/link';
import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { icps, leads, users } from '@/lib/db/schema';
import { getCurrentUser, listBdas } from '@/lib/users';
import { PageHeader } from '@/components/page-header';
import { AutoFilterForm } from '@/components/auto-filter-form';
import { TierBadge } from '@/components/tier-badge';
import { formatDate, formatTime } from '@/lib/dates';
import { normSegment } from '@/lib/icp-match';
import { icpFor, tierOf, type Tier } from '@/lib/tiers';
import { ensureSequences, istDay } from '@/lib/tasks';
import { bestEffort } from '@/lib/best-effort';
import { FUNNEL_HELP, FUNNEL_LABEL, FUNNEL_STAGES, loadFunnel, type FunnelCard, type FunnelStage } from '@/lib/followups';
import { completeTaskAction } from '../../team-actions';
import { followUpAgainAction, moveFromFunnelAction } from '../../followup-actions';

export const maxDuration = 300;

const SMALL = 'btn-secondary px-2 py-0.5 text-xs';

const STAGE_TONE: Record<FunnelStage, string> = {
  today: 'border-accent/50',
  waiting: 'border-line',
  upcoming: 'border-line',
  finished: 'border-warning-ink/40',
  conversation: 'border-good-ink/40',
};

const OUTCOME: Record<string, string> = {
  connected: 'call connected',
  no_answer: 'call, no answer',
  busy: 'call, busy',
  wrong_number: 'call, wrong number',
  no_contact: 'no contact found',
  sent: 'sent',
  done: 'sent',
  accepted: 'accepted',
  skipped: 'skipped',
};
const KIND: Record<string, string> = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', linkedin: 'LinkedIn' };

function dayLabel(day: string, today: string): string {
  if (day < today) return `overdue since ${formatDate(new Date(`${day}T12:00:00+05:30`))}`;
  if (day === today) return 'today';
  return formatDate(new Date(`${day}T12:00:00+05:30`));
}

function Move({ id, stage, label, primary }: { id: number; stage: string; label: string; primary?: boolean }) {
  return (
    <form action={moveFromFunnelAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="stage" value={stage} />
      <button className={primary ? 'btn-primary px-2 py-0.5 text-xs' : SMALL}>{label}</button>
    </form>
  );
}

function CardView({ card, today, todayHref, canLog, owner, tier }: { card: FunnelCard; today: string; todayHref: string; canLog: boolean; owner: string; tier: Tier }) {
  const { lead, next, last } = card;
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">{lead.company}</Link>
        <span className="text-[11px] text-muted">{lead.segment}{lead.city ? ` · ${lead.city}` : ''}</span>
      </div>
      {lead.contactName && (
        <div className="text-xs text-ink-2">
          {lead.contactName}
          {lead.contactTitle ? <span className="text-muted">, {lead.contactTitle}</span> : null}
          <TierBadge tier={tier} />
        </div>
      )}
      <div className="text-xs text-ink-2">
        <span className="font-medium">{card.round}</span>
        {owner ? <span className="text-muted"> · {owner}</span> : null}
      </div>
      {next && (
        <div className="text-xs">
          Next: {KIND[next.kind]}{next.priority ? ' (promised callback)' : ''}, <span className={next.dueDate < today ? 'font-medium text-critical-ink' : ''}>{dayLabel(next.dueDate, today)}</span>
          {next.slot === 'evening' ? ' at 5 pm' : next.slot === 'morning' ? ' at 9 am' : ''}
        </div>
      )}
      {last?.doneAt && (
        <div className="text-xs text-muted">
          Last: {KIND[last.kind]} {OUTCOME[last.outcome] ?? last.outcome}, {formatDate(last.doneAt)} {formatTime(last.doneAt)} · {card.attempts} {card.attempts === 1 ? 'attempt' : 'attempts'}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {card.stage === 'today' && <Link href={todayHref} className="btn-primary px-2 py-0.5 text-xs">Work it on Today</Link>}
        {card.stage === 'waiting' && card.waitingTask && canLog && (
          <form action={completeTaskAction}>
            <input type="hidden" name="id" value={card.waitingTask.id} />
            <button name="outcome" value="accepted" className="btn-primary px-2 py-0.5 text-xs">Request accepted</button>
          </form>
        )}
        {card.stage === 'finished' && (
          <>
            <form action={followUpAgainAction}>
              <input type="hidden" name="id" value={lead.id} />
              <button className="btn-primary px-2 py-0.5 text-xs">Follow up again</button>
            </form>
            <Move id={lead.id} stage="Replied" label="Got a reply" />
            <Move id={lead.id} stage="Lost" label="Mark lost" />
          </>
        )}
        {card.stage === 'conversation' && (
          <>
            {lead.status !== 'Meeting Booked' && <Move id={lead.id} stage="Meeting Booked" label="Meeting booked" primary />}
            <Move id={lead.id} stage="Won" label="Won" />
            <Move id={lead.id} stage="Lost" label="Lost" />
          </>
        )}
        {(card.stage === 'upcoming' || card.stage === 'waiting') && <Move id={lead.id} stage="Replied" label="Got a reply" />}
        <Link href={`/leads/${lead.id}`} className={SMALL}>Open lead</Link>
      </div>
    </li>
  );
}

export default async function FollowUpsPage({ searchParams }: PageProps<'/followups'>) {
  const me = (await getCurrentUser())!;
  const db = await getDb();
  // The same plan Today works from, so a lead just made ready shows here too.
  await bestEffort('planning Today steps', () => ensureSequences(db), 0);
  const sp = await searchParams;
  const team = await listBdas(db);
  const asked = Number(typeof sp.user === 'string' ? sp.user : 0);
  // Team members see their own; an administrator everyone's, or one person's.
  const viewId = me.role === 'admin' ? (team.find((b) => b.id === asked)?.id ?? null) : me.id;
  const today = istDay();
  const icpRows = await db.select().from(icps).orderBy(asc(icps.id));
  const seg = typeof sp.seg === 'string' ? (icpRows.find((i) => normSegment(i.segment) === normSegment(String(sp.seg)))?.segment ?? '') : '';
  const q = typeof sp.q === 'string' ? sp.q.trim() : '';
  const needle = q.toLowerCase();
  const cards = (await loadFunnel(db, viewId, today)).filter(
    (c) => (!seg || normSegment(c.lead.segment) === normSegment(seg)) && (!needle || [c.lead.company, c.lead.contactName, c.lead.city].some((v) => v.toLowerCase().includes(needle))),
  );
  const ownerIds = [...new Set(cards.map((c) => c.lead.ownerId).filter((x): x is number => !!x))];
  const names = new Map((ownerIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds)) : []).map((u) => [u.id, u.name]));
  const [won, lost] = await Promise.all(
    (['Won', 'Lost'] as const).map(async (status) =>
      (await db.select({ id: leads.id, ownerId: leads.ownerId, segment: leads.segment }).from(leads).where(eq(leads.status, status))).filter(
        (l) => (viewId === null || l.ownerId === viewId) && (!seg || normSegment(l.segment) === normSegment(seg)),
      ).length,
    ),
  );
  const byStage = (s: FunnelStage) => cards.filter((c) => c.stage === s);
  const todayHref = (c: FunnelCard) => {
    const p = new URLSearchParams({ q: c.lead.company, ...(me.role === 'admin' && c.lead.ownerId ? { user: String(c.lead.ownerId) } : {}) });
    return `/today?${p}`;
  };
  const tierFor = (c: FunnelCard): Tier =>
    (['P1', 'P2', 'P3'].includes(c.lead.contactTier) ? c.lead.contactTier : tierOf(c.lead.contactTitle, icpFor(c.lead.segment, icpRows))) as Tier;

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description="Every company in outreach, by where its follow-up stands. The steps are the same ones Today shows: work them there, and move companies on here."
      />
      <AutoFilterForm className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        {me.role === 'admin' && (
          <>
            <label htmlFor="fu-user" className="sr-only">Team member</label>
            <select id="fu-user" name="user" defaultValue={viewId ?? ''} className="field h-9 w-auto py-1.5">
              <option value="">Everyone</option>
              {team.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="fu-seg" className="sr-only">Segment</label>
        <select id="fu-seg" name="seg" defaultValue={seg} className="field h-9 w-auto py-1.5">
          <option value="">All segments</option>
          {icpRows.map((i) => (
            <option key={i.id} value={i.segment}>{i.segment}</option>
          ))}
        </select>
        <label htmlFor="fu-q" className="sr-only">Search company or person</label>
        <input id="fu-q" type="search" name="q" defaultValue={q} placeholder="Search company or person" className="field h-9 max-w-xs py-1.5" />
        <Link href="/today" className="text-xs text-accent hover:underline">Go to Today</Link>
      </AutoFilterForm>

      {/* The funnel at a glance: how many companies at each stage. */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {FUNNEL_STAGES.map((s) => (
          <a key={s} href={`#${s}`} className={`card border-l-4 p-3 hover:bg-surface-2 ${STAGE_TONE[s]}`}>
            <div className="text-xs text-muted">{FUNNEL_LABEL[s]}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{byStage(s).length}</div>
          </a>
        ))}
        <div className="card p-3">
          <div className="text-xs text-muted">Won</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{won}</div>
        </div>
        <div className="card p-3">
          <div className="text-xs text-muted">Lost</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{lost}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {FUNNEL_STAGES.map((s) => {
          const list = byStage(s);
          return (
            <section key={s} id={s} className={`card scroll-mt-4 overflow-hidden border-t-4 ${STAGE_TONE[s]}`}>
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">
                  {FUNNEL_LABEL[s]} <span className="font-normal text-muted tabular-nums">{list.length}</span>
                </h2>
                <p className="text-xs text-muted">{FUNNEL_HELP[s]}</p>
              </div>
              {list.length ? (
                <ul className="max-h-[36rem] divide-y divide-line overflow-y-auto">
                  {list.map((c) => (
                    <CardView
                      key={c.lead.id}
                      card={c}
                      today={today}
                      todayHref={todayHref(c)}
                      canLog={c.lead.ownerId === me.id}
                      owner={me.role === 'admin' && c.lead.ownerId ? (names.get(c.lead.ownerId) ?? '') : ''}
                      tier={tierFor(c)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-center text-xs text-muted">Nothing here{q || seg ? ' for these filters' : ''}.</p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
