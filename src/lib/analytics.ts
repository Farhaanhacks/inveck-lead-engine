import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { Db } from './db';
import { activities, leads, type Lead } from './db/schema';

const REPLIED = ['Replied', 'Meeting Booked', 'Won'];
const MEETING = ['Meeting Booked', 'Won'];
const WEEK = 7 * 24 * 60 * 60 * 1000;
const IST = 5.5 * 60 * 60 * 1000;

export type FunnelStep = { label: string; value: number; rate: number | null; of: string };
export type Week = { start: Date; label: string; sent: number; replied: number };
export type Best = { name: string; hits: number; total: number; rate: number; metric: 'replied' | 'qualified' } | null;

/** "Lookalike of Haldex: …" → "Lookalike of a client". */
export function sourceGroup(source: string): string {
  if (/^lookalike/i.test(source)) return 'Lookalike of a client';
  if (/prospect search/i.test(source)) return 'Prospect search';
  if (/by hand/i.test(source)) return 'Added by hand';
  return source || 'Other';
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

/** Monday 00:00 IST of the week containing `d`, as a UTC Date. */
function weekStart(d: Date): Date {
  const local = new Date(d.getTime() + IST);
  const day = (local.getUTCDay() + 6) % 7; // Monday = 0
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - day * 24 * 60 * 60 * 1000 - IST);
}

/** The group with the best rate; ties go to the bigger group. */
function best(rows: Lead[], key: (l: Lead) => string, hit: (l: Lead) => boolean, metric: 'replied' | 'qualified'): Best {
  const groups = new Map<string, { hits: number; total: number }>();
  for (const l of rows) {
    const k = key(l) || 'None';
    const g = groups.get(k) || { hits: 0, total: 0 };
    g.total++;
    if (hit(l)) g.hits++;
    groups.set(k, g);
  }
  const ranked = [...groups].map(([name, g]) => ({ name, ...g, rate: g.hits / g.total })).sort((a, b) => b.rate - a.rate || b.total - a.total);
  const top = ranked[0];
  return top && top.hits ? { ...top, rate: Math.round(top.rate * 100), metric } : null;
}

export async function getAnalytics(db: Db, now = new Date()) {
  const since = weekStart(new Date(now.getTime() - 7 * WEEK));
  const [all, history, due] = await Promise.all([
    db.select().from(leads),
    db
      .select({ leadId: activities.leadId, kind: activities.kind, stage: activities.stage, at: activities.at })
      .from(activities)
      .where(inArray(activities.kind, ['sent', 'stage']))
      .orderBy(asc(activities.at)),
    db
      .select()
      .from(leads)
      .where(and(eq(leads.status, 'Contacted'), isNotNull(leads.nextFollowUpAt), lte(leads.nextFollowUpAt, now)))
      .orderBy(asc(leads.nextFollowUpAt))
      .limit(8),
  ]);

  // Stages each lead has ever reached (it may have moved on since, e.g. Replied → Lost).
  const reached = new Map<number, Set<string>>();
  for (const a of history) if (a.kind === 'stage' && a.stage) (reached.get(a.leadId) ?? reached.set(a.leadId, new Set()).get(a.leadId)!).add(a.stage);
  const ever = (l: Lead, stages: string[]) => stages.includes(l.status) || stages.some((s) => reached.get(l.id)?.has(s));

  const researched = all.filter((l) => !['New', 'Processing', 'Existing Client'].includes(l.status));
  const qualified = researched.filter((l) => l.qualified);
  // Counted by where leads are now, like the pipeline board. Lost leads count for the steps
  // they reached before they were lost.
  const lost = (l: Lead) => l.status === 'Lost';
  const contacted = all.filter((l) => ['Contacted', ...REPLIED].includes(l.status) || (lost(l) && !!l.sentAt));
  const replied = contacted.filter((l) => REPLIED.includes(l.status) || (lost(l) && ever(l, REPLIED)));
  const meetings = contacted.filter((l) => MEETING.includes(l.status) || (lost(l) && ever(l, MEETING)));
  const won = all.filter((l) => l.status === 'Won');

  const funnel: FunnelStep[] = [
    { label: 'Researched', value: researched.length, rate: null, of: '' },
    { label: 'Qualified', value: qualified.length, rate: pct(qualified.length, researched.length), of: 'of researched' },
    { label: 'Contacted', value: contacted.length, rate: pct(contacted.length, qualified.length), of: 'of qualified' },
    { label: 'Replied', value: replied.length, rate: pct(replied.length, contacted.length), of: 'reply rate' },
    { label: 'Meetings', value: meetings.length, rate: pct(meetings.length, replied.length), of: 'of replies' },
    { label: 'Won', value: won.length, rate: pct(won.length, meetings.length), of: 'of meetings' },
  ];

  // Weekly: first emails sent, and leads replying for the first time.
  const weeks: Week[] = Array.from({ length: 8 }, (_, i) => {
    const start = new Date(since.getTime() + i * WEEK);
    const label = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(start);
    return { start, label, sent: 0, replied: 0 };
  });
  const bucket = (d: Date) => weeks[Math.floor((d.getTime() - since.getTime()) / WEEK)];
  const firstReply = new Set<number>();
  for (const a of history) {
    if (a.at < since) {
      if (a.kind === 'stage' && REPLIED.includes(a.stage)) firstReply.add(a.leadId);
      continue;
    }
    const w = bucket(a.at);
    if (!w) continue;
    if (a.kind === 'sent') w.sent++;
    else if (REPLIED.includes(a.stage) && !firstReply.has(a.leadId)) {
      firstReply.add(a.leadId);
      w.replied++;
    }
  }

  // What's working: reply rate once there are sends, qualification rate before that.
  const useReplies = contacted.length > 0 && replied.length > 0;
  const base = useReplies ? contacted : researched;
  const hit = useReplies ? (l: Lead) => replied.includes(l) : (l: Lead) => !!l.qualified;
  const metric = useReplies ? 'replied' : 'qualified';

  return {
    funnel,
    weeks,
    bestSegment: best(base, (l) => l.segment, hit, metric),
    bestSource: best(base, (l) => sourceGroup(l.source), hit, metric),
    followUpsDue: due,
    replyRate: pct(replied.length, contacted.length),
    awaitingReply: all.filter((l) => l.status === 'Contacted').length,
  };
}
