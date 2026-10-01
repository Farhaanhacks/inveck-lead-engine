import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { Db } from './db';
import { icps, leads, tasks, users, type Lead } from './db/schema';
import { tierOf } from './tiers';

/** What a connected (or attempted) call came to: the "Call Outcome / Feedback" dropdown. */
export const CALL_FEEDBACK = [
  'Interested',
  'Demo scheduled',
  'Call back later',
  'Send details on email / WhatsApp',
  'Not interested',
  'No requirement right now',
  'Already using a solution',
  'Not the right person',
  'Wrong number',
  'Not reachable',
] as const;

export const MAIL_OUTCOMES = ['Not sent', 'Sent', 'No reply', 'Replied: interested', 'Replied: not interested', 'Bounced'] as const;
export const LINKEDIN_OUTCOMES = ['Not sent', 'Request sent', 'Accepted', 'Replied', 'No response', 'Not on LinkedIn'] as const;

export const TRACKER_FIELDS = {
  callFeedback: CALL_FEEDBACK,
  mailOutcome: MAIL_OUTCOMES,
  linkedinOutcome: LINKEDIN_OUTCOMES,
} as const;
export type TrackerField = keyof typeof TRACKER_FIELDS | 'remark';

export function validTrackerValue(field: TrackerField, value: string): boolean {
  if (field === 'remark') return value.length <= 1000;
  return value === '' || (TRACKER_FIELDS[field] as readonly string[]).includes(value);
}

const CALL_STATUS: Record<string, string> = {
  connected: 'Connected',
  no_answer: 'Not connected: no answer',
  busy: 'Not connected: busy',
  wrong_number: 'Wrong number',
};

export type TrackerRow = {
  lead: Lead;
  owner: string;
  callStatus: string;
  callRemark: string;
  callsDone: number;
  lastCallAt: Date | null;
  pointOfContact: string;
  mailOutcome: string;
  linkedinOutcome: string;
};

/** One row per lead with everything the team's Google Sheet had, plus email and LinkedIn outcomes. */
export async function loadTracker(db: Db, ownerId: number | null): Promise<TrackerRow[]> {
  const rows = await db
    .select()
    .from(leads)
    .where(and(ownerId === null ? undefined : eq(leads.ownerId, ownerId), ne(leads.status, 'Disqualified'), ne(leads.status, 'New'), ne(leads.status, 'Processing')))
    .orderBy(desc(leads.updatedAt))
    .limit(2000);
  if (!rows.length) return [];
  const ids = rows.map((l) => l.id);
  const [calls, sent, icpList, team] = await Promise.all([
    db
      .select({ leadId: tasks.leadId, outcome: tasks.outcome, note: tasks.note, doneAt: tasks.doneAt })
      .from(tasks)
      .where(and(inArray(tasks.leadId, ids), eq(tasks.kind, 'call'), isNotNull(tasks.doneAt), inArray(tasks.outcome, Object.keys(CALL_STATUS))))
      .orderBy(desc(tasks.doneAt)),
    db
      .select({ leadId: tasks.leadId, kind: tasks.kind })
      .from(tasks)
      .where(and(inArray(tasks.leadId, ids), inArray(tasks.kind, ['email', 'linkedin']), inArray(tasks.outcome, ['sent', 'done']))),
    db.select().from(icps),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);
  const names = new Map(team.map((u) => [u.id, u.name]));
  const icpBySegment = new Map(icpList.map((i) => [i.segment.toLowerCase(), i]));
  const emailed = new Set(sent.filter((s) => s.kind === 'email').map((s) => s.leadId));
  const linked = new Set(sent.filter((s) => s.kind === 'linkedin').map((s) => s.leadId));
  return rows.map((lead) => {
    const mine = calls.filter((c) => c.leadId === lead.id);
    const last = mine[0];
    const lastConnected = mine.find((c) => c.outcome === 'connected');
    const tier = tierOf(lead.contactTitle, icpBySegment.get(lead.segment.toLowerCase()));
    return {
      lead,
      owner: lead.ownerId ? names.get(lead.ownerId) ?? '' : '',
      callStatus: last ? CALL_STATUS[last.outcome] : 'Not called yet',
      callRemark: lastConnected?.note ?? '',
      callsDone: mine.length,
      lastCallAt: last?.doneAt ?? null,
      pointOfContact: tier === 'Avoid' ? '' : tier,
      // Logged sends fill these in until someone picks an outcome by hand.
      mailOutcome: lead.mailOutcome || (emailed.has(lead.id) || lead.sentAt ? 'Sent' : lead.contactEmail ? 'Not sent' : ''),
      linkedinOutcome: lead.linkedinOutcome || (linked.has(lead.id) ? 'Request sent' : lead.contactLinkedin ? 'Not sent' : 'Not on LinkedIn'),
    };
  });
}

/** The sheet's columns, in the team's order, with the email and LinkedIn outcomes added. */
export const TRACKER_HEADERS = [
  'Company Name',
  'Company Location',
  'Company Website URL',
  'Client Name',
  'Client Designation',
  'Client LinkedIn Profile',
  'Client Contact Number',
  'Call Status',
  'Call Outcome / Feedback',
  'Call Remark',
  'Calls logged',
  'Call Date',
  'Client Email ID',
  'Mail Outcome',
  'LinkedIn Outreach Outcome',
  'Lead_Status',
  'Remark',
  'Company type',
  'Point of Contact',
  'Date',
  'Owner',
] as const;

const day = (d: Date | null) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(d) : '');

export function trackerCells(r: TrackerRow): string[] {
  const l = r.lead;
  return [
    l.company,
    l.city,
    l.website,
    l.contactName,
    l.contactTitle,
    l.contactLinkedin,
    l.contactPhone || l.companyPhone,
    r.callStatus,
    l.callFeedback,
    r.callRemark,
    r.callsDone ? `${r.callsDone} ${r.callsDone === 1 ? 'call' : 'calls'} logged` : 'No calls yet',
    day(r.lastCallAt),
    l.contactEmail,
    r.mailOutcome,
    r.linkedinOutcome,
    l.status,
    l.remark,
    l.segment,
    r.pointOfContact,
    day(l.createdAt),
    r.owner,
  ];
}
