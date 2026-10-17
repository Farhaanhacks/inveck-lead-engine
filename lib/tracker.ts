import { and, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { Db } from './db';
import { leads, tasks, users, type Lead } from './db/schema';

/** What a connected (or attempted) call came to: the "Call Outcome / Feedback" dropdown. */
export const CALL_FEEDBACK = [
  'Interested',
  'Demo scheduled',
  'Demo completed',
  'Client onboarded',
  'Already a client',
  'Call back later',
  'Send details on email / WhatsApp',
  'Not interested',
  'No requirement right now',
  'Already using a solution',
  'Not the right person',
  'Wrong number',
  'No contact found',
  'Not reachable',
] as const;

/** Call outcomes that end the outreach: no WhatsApp, email or LinkedIn after them. */
export const NOT_INTERESTED = ['Not interested', 'No requirement right now', 'Already using a solution'] as const;
/** Call outcomes that mean they are a client (now, or already were): outreach ends too. */
export const CLIENT_OUTCOMES = ['Client onboarded', 'Already a client'] as const;

export const MAIL_OUTCOMES = ['Not sent', 'Sent', 'No reply', 'Replied: interested', 'Replied: not interested', 'Bounced'] as const;
export const LINKEDIN_OUTCOMES = ['Not sent', 'Request sent', 'Accepted', 'Replied', 'No response', 'Not on LinkedIn'] as const;

export const CONTACT_TIERS = ['P1', 'P2', 'P3'] as const;
/** Tracker "Point of Contact": where the conversation happened. */
export const CONTACT_CHANNELS = ['Phone', 'WhatsApp', 'Email', 'LinkedIn', 'Referral', 'Other'] as const;

export const TRACKER_FIELDS = {
  callFeedback: CALL_FEEDBACK,
  contactTier: CONTACT_TIERS,
  contactChannel: CONTACT_CHANNELS,
  mailOutcome: MAIL_OUTCOMES,
  linkedinOutcome: LINKEDIN_OUTCOMES,
} as const;
export type TrackerField = keyof typeof TRACKER_FIELDS | 'remark' | 'callRemark';

/**
 * A contact number as typed on the tracker: spaces tidied; digits, spaces and + - ( ) / , . only, at
 * least 6 digits (several numbers may be listed). '' clears it; null when it isn't a number.
 */
export function cleanPhone(value: string): string | null {
  const phone = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!phone) return '';
  if (phone.length > 120 || !/^[0-9+\-()/,; .]+$/.test(phone) || phone.replace(/\D/g, '').length < 6) return null;
  return phone;
}

export function validTrackerValue(field: TrackerField, value: string): boolean {
  if (field === 'remark' || field === 'callRemark') return value.length <= 1000;
  return value === '' || (TRACKER_FIELDS[field] as readonly string[]).includes(value);
}

const CALL_STATUS: Record<string, string> = {
  connected: 'Connected',
  no_answer: 'Not connected: no answer',
  busy: 'Not connected: busy',
  wrong_number: 'Wrong number',
  no_contact: 'No contact found',
};

export type TrackerRow = {
  lead: Lead;
  owner: string;
  callStatus: string;
  callRemark: string;
  callsDone: number;
  lastCallAt: Date | null;
  /** The channel they were reached on: set by hand, else from what was logged. */
  pointOfContact: string;
  /** What the log says, shown as the automatic choice. */
  autoChannel: string;
  mailOutcome: string;
  linkedinOutcome: string;
};

/** Where the conversation happened, from what was logged: a connected call, an email or LinkedIn reply. */
function channelFromLog(lead: Lead, calls: { outcome: string }[]): string {
  if (calls.some((c) => c.outcome === 'connected')) return 'Phone';
  if (lead.mailOutcome.startsWith('Replied')) return 'Email';
  if (lead.linkedinOutcome === 'Accepted' || lead.linkedinOutcome === 'Replied') return 'LinkedIn';
  return '';
}

/** One row per lead with the columns INVECK's office listed, plus email and LinkedIn outcomes. */
export async function loadTracker(db: Db, ownerId: number | null): Promise<TrackerRow[]> {
  const rows = await db
    .select()
    .from(leads)
    // Not companies ruled out, or whose fit is still being reviewed (they aren't worked yet).
    .where(and(ownerId === null ? undefined : eq(leads.ownerId, ownerId), notInArray(leads.status, ['Disqualified', 'Needs Review', 'Deleted'])))
    .orderBy(desc(leads.updatedAt))
    .limit(2000);
  if (!rows.length) return [];
  const ids = rows.map((l) => l.id);
  const [calls, sent, team] = await Promise.all([
    db
      .select({ leadId: tasks.leadId, outcome: tasks.outcome, note: tasks.note, doneAt: tasks.doneAt })
      .from(tasks)
      .where(and(inArray(tasks.leadId, ids), eq(tasks.kind, 'call'), isNotNull(tasks.doneAt), inArray(tasks.outcome, Object.keys(CALL_STATUS))))
      .orderBy(desc(tasks.doneAt)),
    db
      .select({ leadId: tasks.leadId, kind: tasks.kind })
      .from(tasks)
      .where(and(inArray(tasks.leadId, ids), inArray(tasks.kind, ['email', 'linkedin']), inArray(tasks.outcome, ['sent', 'done']))),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);
  const names = new Map(team.map((u) => [u.id, u.name]));
  const emailed = new Set(sent.filter((s) => s.kind === 'email').map((s) => s.leadId));
  const linked = new Set(sent.filter((s) => s.kind === 'linkedin').map((s) => s.leadId));
  return rows.map((lead) => {
    const mine = calls.filter((c) => c.leadId === lead.id);
    const last = mine[0];
    return {
      lead,
      owner: lead.ownerId ? names.get(lead.ownerId) ?? '' : '',
      callStatus: last ? CALL_STATUS[last.outcome] : 'Not called yet',
      callRemark: lead.callRemark,
      // Calls actually dialled (a "No contact found" isn't one).
      callsDone: mine.filter((c) => c.outcome !== 'no_contact').length,
      lastCallAt: last?.doneAt ?? null,
      pointOfContact: lead.contactChannel || channelFromLog(lead, mine),
      autoChannel: channelFromLog(lead, mine),
      // Logged sends fill these in until someone picks an outcome by hand.
      mailOutcome: lead.mailOutcome || (emailed.has(lead.id) || lead.sentAt ? 'Sent' : ''),
      linkedinOutcome: lead.linkedinOutcome || (linked.has(lead.id) ? 'Request sent' : lead.contactLinkedin ? 'Not sent' : 'Not on LinkedIn'),
    };
  });
}

/** The sheet's columns, in the team's order, with the mail and LinkedIn outcomes added (no email address: emails aren't kept). */
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
