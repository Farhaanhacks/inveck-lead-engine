import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// Keep in sync with the CREATE statements in ./migrate.ts.

export const LEAD_STATUSES = [
  'New',
  'Processing',
  'Existing Client',
  'Disqualified',
  'Needs Manual Contact',
  'Low Score',
  'Awaiting Approval',
  'Approved',
  'Contacted',
  'Replied',
  'Meeting Booked',
  'Won',
  'Lost',
  'Rejected',
  'Error',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** The sales pipeline, as columns on the board. */
export const PIPELINE_STAGES = ['Awaiting Approval', 'Approved', 'Contacted', 'Replied', 'Meeting Booked', 'Won', 'Lost'] as const satisfies readonly LeadStatus[];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
/** Stages where the conversation has moved on, so no more follow-ups. */
export const ENGAGED_STAGES: readonly LeadStatus[] = ['Replied', 'Meeting Booked', 'Won', 'Lost'];

/** A recent news item that suggests the company needs INVECK now. */
export type Signal = { headline: string; date: string; url: string; source: string; kind: string };

export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  company: text('company').notNull(),
  website: text('website').notNull().default(''),
  city: text('city').notNull().default(''),
  segment: text('segment').notNull().default(''),
  status: text('status').$type<LeadStatus>().notNull().default('New'),
  source: text('source').notNull().default(''),
  contactName: text('contact_name').notNull().default(''),
  contactTitle: text('contact_title').notNull().default(''),
  contactEmail: text('contact_email').notNull().default(''),
  contactPhone: text('contact_phone').notNull().default(''),
  companyPhone: text('company_phone').notNull().default(''),
  contactLinkedin: text('contact_linkedin').notNull().default(''),
  otherDecisionMakers: text('other_decision_makers').notNull().default(''),
  researchSummary: text('research_summary').notNull().default(''),
  qualified: boolean('qualified'),
  fitScore: integer('fit_score'),
  fitReason: text('fit_reason').notNull().default(''),
  finalScore: integer('final_score'),
  scoreBreakdown: text('score_breakdown').notNull().default(''),
  emailStatus: text('email_status').notNull().default(''),
  emailSubject: text('email_subject').notNull().default(''),
  emailBody: text('email_body').notNull().default(''),
  linkedinMessage: text('linkedin_message').notNull().default(''),
  lastError: text('last_error').notNull().default(''),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  /** Follow-ups sent so far (0–2); the next one is due at nextFollowUpAt. */
  followUpStep: integer('follow_up_step').notNull().default(0),
  nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
  followUpSubject: text('follow_up_subject').notNull().default(''),
  followUpBody: text('follow_up_body').notNull().default(''),
  /** The BDA who works this lead. */
  ownerId: integer('owner_id'),
  /** Tracker sheet: what the last conversation came to, a free remark, and how email and LinkedIn outreach went. */
  callFeedback: text('call_feedback').notNull().default(''),
  remark: text('remark').notNull().default(''),
  /** What was said on the last call; filled from a connected call's note and editable on the tracker. */
  callRemark: text('call_remark').notNull().default(''),
  mailOutcome: text('mail_outcome').notNull().default(''),
  linkedinOutcome: text('linkedin_outcome').notNull().default(''),
  /** Came in from ads, the website or a campaign: shared equally between the team and must never sit untouched. */
  inbound: boolean('inbound').notNull().default(false),
  /** No longer used (the morning draw was removed); kept so old rows load. */
  drawnOn: text('drawn_on').notNull().default(''),
  /** Point of contact tier (P1, P2, P3) set by hand on the tracker; empty means worked out from the designation. */
  contactTier: text('contact_tier').notNull().default(''),
  /** Tracker "Point of Contact": the channel they were reached on (Phone, WhatsApp, Email, LinkedIn...), set by hand; empty = from what was logged. */
  contactChannel: text('contact_channel').notNull().default(''),
  /** Contacts to be found again from scratch (after a reset), keeping the research and the lead's stage. */
  refetchPending: boolean('refetch_pending').notNull().default(false),
  refetchClaimedAt: timestamp('refetch_claimed_at', { withTimezone: true }),
  /** When the current point of contact took over: unanswered calls are counted from here (P2 flow). */
  contactSince: timestamp('contact_since', { withTimezone: true }),
  /** When the point of contact was last checked on LinkedIn (profile and current designation); null = not yet. */
  contactCheckedAt: timestamp('contact_checked_at', { withTimezone: true }),
  signals: jsonb('signals').$type<Signal[]>().notNull().default([]),
  signalsCheckedAt: timestamp('signals_checked_at', { withTimezone: true }),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

export const icps = pgTable('icps', {
  id: serial('id').primaryKey(),
  segment: text('segment').notNull(),
  active: boolean('active').notNull().default(true),
  description: text('description').notNull().default(''),
  industries: text('industries').notNull().default(''),
  companySize: text('company_size').notNull().default(''),
  geography: text('geography').notNull().default(''),
  mustHaves: text('must_haves').notNull().default(''),
  dealBreakers: text('deal_breakers').notNull().default(''),
  /** P1: the decision-makers to approach first. */
  targetTitles: text('target_titles').notNull().default(''),
  /** P2: process owners, approached only when P1 doesn't respond. */
  p2Titles: text('p2_titles').notNull().default(''),
  /** P3: process-level contacts, the last resort. */
  p3Titles: text('p3_titles').notNull().default(''),
  /** Functions never to target first (HR, admin, quality). */
  avoidTitles: text('avoid_titles').notNull().default(''),
  pitchAngle: text('pitch_angle').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Icp = typeof icps.$inferSelect;

export const clients = pgTable('clients', {
  id: serial('id').primaryKey(),
  company: text('company').notNull(),
  website: text('website').notNull().default(''),
  industry: text('industry').notNull().default(''),
  whyBought: text('why_bought').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Client = typeof clients.$inferSelect;

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export type RunStats = {
  prospectsAdded: number;
  processed: number;
  drafted: number;
  disqualified: number;
  existingClients: number;
  errors: number;
};

export const runs = pgTable('runs', {
  id: serial('id').primaryKey(),
  findProspects: boolean('find_prospects').notNull().default(false),
  /** Who gets the prospects this run finds: '' (nobody yet; the admin assigns them), 'team' (split across the team now) or a user id. */
  prospectsTo: text('prospects_to').notNull().default(''),
  status: text('status').$type<'running' | 'done' | 'failed' | 'cancelled'>().notNull().default('running'),
  trigger: text('trigger').notNull().default('manual'),
  stats: jsonb('stats').$type<RunStats>().notNull(),
  error: text('error').notNull().default(''),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  prospectsDone: boolean('prospects_done').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
export type Run = typeof runs.$inferSelect;

export const runEvents = pgTable('run_events', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull(),
  leadId: integer('lead_id'),
  level: text('level').$type<'info' | 'warn' | 'error'>().notNull().default('info'),
  message: text('message').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
export type RunEvent = typeof runEvents.$inferSelect;

export const ACTIVITY_KINDS = [
  'added', 'researched', 'contact', 'draft', 'approved', 'sent', 'follow_up_drafted', 'follow_up_sent',
  'stage', 'note', 'call', 'meeting', 'signal', 'error',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Everything that happened to a lead, for its timeline and the analytics. */
export const activities = pgTable('activities', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(),
  kind: text('kind').$type<ActivityKind>().notNull(),
  text: text('text').notNull().default(''),
  /** For stage changes: the stage moved to. */
  stage: text('stage').notNull().default(''),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
export type Activity = typeof activities.$inferSelect;

/** A new plant, warehouse or facility spotted in the news: a chance to be the first to approach it. */
export const opportunities = pgTable('opportunities', {
  id: serial('id').primaryKey(),
  company: text('company').notNull(),
  headline: text('headline').notNull(),
  location: text('location').notNull().default(''),
  kind: text('kind').notNull().default('new_plant'),
  segment: text('segment').notNull().default(''),
  why: text('why').notNull().default(''),
  url: text('url').notNull(),
  source: text('source').notNull().default(''),
  date: text('date').notNull().default(''),
  status: text('status').$type<'new' | 'added' | 'dismissed'>().notNull().default('new'),
  leadId: integer('lead_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Opportunity = typeof opportunities.$inferSelect;

/** Everyone found at a lead's company: the main contact and the other decision-makers. */
export const people = pgTable('people', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(),
  name: text('name').notNull(),
  title: text('title').notNull().default(''),
  email: text('email').notNull().default(''),
  emailStatus: text('email_status').notNull().default(''),
  phone: text('phone').notNull().default(''),
  linkedin: text('linkedin').notNull().default(''),
  /** Where they were found: LinkedIn, Company website / records, Hunter, Sales team. */
  source: text('source').notNull().default(''),
  isPrimary: boolean('is_primary').notNull().default(false),
  /** When the P2 flow moved on from this person (no answer, not the right person): not tried again automatically. */
  passedAt: timestamp('passed_at', { withTimezone: true }),
  /** When this person was last checked on LinkedIn (still there, current title); null = not yet. */
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** Where they are based, from their LinkedIn profile ("Jaipur, Rajasthan, India"); empty when unknown. */
  location: text('location').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;

export const USER_ROLES = ['admin', 'bda'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Team members. Usernames look like parimal@inveck. */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').$type<UserRole>().notNull().default('bda'),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type User = typeof users.$inferSelect;

export const TASK_KINDS = ['call', 'whatsapp', 'email', 'linkedin'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** One thing a BDA has to do for a lead on a given day: the P1 outreach sequence, and promised callbacks. */
export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(),
  ownerId: integer('owner_id').notNull(),
  kind: text('kind').$type<TaskKind>().notNull(),
  /** "Day 1", "Follow-up 2"... */
  step: text('step').notNull().default(''),
  title: text('title').notNull().default(''),
  /** Indian date, YYYY-MM-DD. */
  dueDate: text('due_date').notNull(),
  slot: text('slot').$type<'morning' | 'day' | 'evening'>().notNull().default('day'),
  /** Promised callbacks: worked before everything else. */
  priority: boolean('priority').notNull().default(false),
  note: text('note').notNull().default(''),
  doneAt: timestamp('done_at', { withTimezone: true }),
  /** connected, no_answer, busy, wrong_number, sent, done or skipped. */
  outcome: text('outcome').notNull().default(''),
  /** The lead's stage before logging this moved it on, so Undo can put it back. */
  stageFrom: text('stage_from').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Task = typeof tasks.$inferSelect;

/** One row per person per Indian day: when they first showed up, last showed up, and clocked in and out. */
export const attendance = pgTable('attendance', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  day: text('day').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  clockInAt: timestamp('clock_in_at', { withTimezone: true }),
  clockOutAt: timestamp('clock_out_at', { withTimezone: true }),
});
export type Attendance = typeof attendance.$inferSelect;

/** A company whose every step for the day was ticked off: what the admin counts as a company completed. */
export const companyDays = pgTable('company_days', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(),
  ownerId: integer('owner_id').notNull(),
  /** Indian date, YYYY-MM-DD. */
  day: text('day').notNull(),
  doneAt: timestamp('done_at', { withTimezone: true }).notNull().defaultNow(),
});
