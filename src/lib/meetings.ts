import { createHash } from 'node:crypto';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from './db';
import { leadMeetings, leads, users, type Lead, type LeadMeeting } from './db/schema';
import { logActivity } from './activity';
import { validDay } from './holidays';
import { createTeamsMeeting, MailError } from './mail/outlook';
import { istDay, istDayBounds } from './tasks';

/** Teams meetings from a connected call. Times are India time, like the rest of the app. */
export const MEETING_DURATIONS = [15, 30, 45, 60, 90] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IST_MS = 330 * 60_000;
/** A retry of a request still being made, within this long, is refused instead of risking two. */
const CREATING_HOLD_MS = 2 * 60_000;

export const defaultMeetingTitle = (company: string) => `Demo for ${company.trim()} - Inveck`;

/** A date (YYYY-MM-DD) and time (HH:MM) in India, and a length, as instants and as Graph's local times. */
export function meetingSlot(date: string, time: string, minutes: number, now = new Date()): { ok: true; startsAt: Date; endsAt: Date; startLocal: string; endLocal: string } | { ok: false; error: string } {
  if (!validDay(date)) return { ok: false, error: 'Choose a date for the meeting.' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: 'Choose a time for the meeting.' };
  if (!(MEETING_DURATIONS as readonly number[]).includes(minutes)) return { ok: false, error: 'Choose how long the meeting is.' };
  const startsAt = new Date(`${date}T${time}:00+05:30`);
  if (startsAt.getTime() <= now.getTime()) return { ok: false, error: 'The meeting time has already passed: choose a later time.' };
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  return { ok: true, startsAt, endsAt, startLocal: `${date}T${time}:00`, endLocal: new Date(endsAt.getTime() + IST_MS).toISOString().slice(0, 19) };
}

const keyOf = (leadId: number, taskId: number | null, startsAt: Date, email: string) => createHash('sha256').update(`${leadId}|${taskId ?? ''}|${startsAt.toISOString()}|${email}`).digest('hex');

/** Whether a Teams meeting is scheduled for the lead (a call can only be logged as Demo scheduled after one is). */
export async function hasScheduledMeeting(db: Db, leadId: number): Promise<boolean> {
  return (await db.select({ id: leadMeetings.id }).from(leadMeetings).where(and(eq(leadMeetings.leadId, leadId), eq(leadMeetings.status, 'scheduled'))).limit(1)).length > 0;
}

export type ScheduleInput = { lead: Lead; taskId: number | null; userId: number; title: string; date: string; time: string; minutes: number };

/**
 * Creates the Teams meeting in the lead owner's own calendar and records it. Nothing is created without a saved
 * address for the prospect, and nothing is recorded unless Graph returned the event and its Teams link. The same
 * request (lead, step, time, attendee) twice never makes two meetings: a finished one is returned as it is, one
 * being made is refused for a moment, and one Microsoft never answered about is retried under the same
 * transaction id, so Graph returns the same event.
 */
export async function scheduleMeeting(db: Db, input: ScheduleInput, now = new Date()): Promise<{ ok: true; meeting: LeadMeeting; already: boolean } | { ok: false; error: string }> {
  const { lead } = input;
  if (lead.ownerId !== input.userId) return { ok: false, error: 'Only the person this company belongs to can schedule its meeting.' };
  const email = lead.contactEmail.trim().toLowerCase();
  if (!email || !EMAIL.test(email)) return { ok: false, error: "No email address is saved for this contact, so the invitation can't be sent. Add one under Edit point of contact first." };
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (!title) return { ok: false, error: 'Give the meeting a title.' };
  if (title.length > 200) return { ok: false, error: 'The meeting title is too long.' };
  const slot = meetingSlot(input.date, input.time, input.minutes, now);
  if (!slot.ok) return slot;

  const requestKey = keyOf(lead.id, input.taskId, slot.startsAt, email);
  const [existing] = await db.select().from(leadMeetings).where(eq(leadMeetings.requestKey, requestKey));
  if (existing?.status === 'scheduled') return { ok: true, meeting: existing, already: true };
  if (existing && now.getTime() - existing.createdAt.getTime() < CREATING_HOLD_MS) return { ok: false, error: 'This meeting is already being created. Wait a moment and check the lead before trying again.' };
  if (!existing) {
    const claimed = await db
      .insert(leadMeetings)
      .values({ leadId: lead.id, taskId: input.taskId, requestKey, title, startsAt: slot.startsAt, endsAt: slot.endsAt, organizerId: input.userId, attendeeEmail: email, attendeeName: lead.contactName, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: leadMeetings.id });
    if (!claimed.length) return { ok: false, error: 'This meeting is already being created. Wait a moment and check the lead before trying again.' };
  } else {
    await db.update(leadMeetings).set({ createdAt: now }).where(eq(leadMeetings.id, existing.id));
  }

  let made: Awaited<ReturnType<typeof createTeamsMeeting>>;
  try {
    made = await createTeamsMeeting(db, input.userId, { subject: title, startLocal: slot.startLocal, endLocal: slot.endLocal, attendeeEmail: email, attendeeName: lead.contactName, transactionId: requestKey.slice(0, 40) });
  } catch (e) {
    // Microsoft never said whether it was made: kept, so a retry (same transaction id) finds the same event.
    if (!(e instanceof MailError && e.unconfirmed)) await db.delete(leadMeetings).where(eq(leadMeetings.requestKey, requestKey));
    if (!(e instanceof MailError)) console.error('[meetings] could not create the meeting:', e);
    return { ok: false, error: e instanceof MailError ? e.message : "Couldn't create the meeting. Try again in a moment." };
  }
  const [meeting] = await db
    .update(leadMeetings)
    .set({ status: 'scheduled', graphEventId: made.eventId, joinUrl: made.joinUrl, organizerEmail: made.organizer })
    .where(eq(leadMeetings.requestKey, requestKey))
    .returning();
  const when = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(slot.startsAt);
  await logActivity(db, lead.id, 'note', `Teams meeting scheduled: “${title}” on ${when} IST with ${email}, organised by ${made.organizer}. Microsoft sent the invitation. Event ${made.eventId}`);
  return { ok: true, meeting, already: false };
}

export type MeetingToday = { meeting: LeadMeeting; lead: Lead };

/** The Teams meetings on an India day (default today) for one BDA, earliest first. Only that day: none before, none after. */
export async function meetingsOn(db: Db, ownerId: number, day = istDay()): Promise<MeetingToday[]> {
  const { start, end } = istDayBounds(day);
  const rows = await db
    .select({ meeting: leadMeetings, lead: leads })
    .from(leadMeetings)
    .innerJoin(leads, eq(leadMeetings.leadId, leads.id))
    .where(and(eq(leadMeetings.organizerId, ownerId), eq(leadMeetings.status, 'scheduled'), gte(leadMeetings.startsAt, start), lt(leadMeetings.startsAt, end)))
    .orderBy(asc(leadMeetings.startsAt));
  return rows;
}

/** The newest scheduled meeting of a lead, for showing on its page. */
export async function latestMeeting(db: Db, leadId: number): Promise<LeadMeeting | null> {
  const rows = await db.select().from(leadMeetings).where(and(eq(leadMeetings.leadId, leadId), eq(leadMeetings.status, 'scheduled'))).orderBy(asc(leadMeetings.startsAt));
  return rows.at(-1) ?? null;
}

export const organizerName = async (db: Db, id: number) => (await db.select({ name: users.name }).from(users).where(eq(users.id, id)))[0]?.name ?? '';
