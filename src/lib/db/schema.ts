import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import type { FitEvidence, FitStatus, RiskFlag } from '../pipeline/fit';
import type { ContentPlatform, ContentStatus } from '../content-meta';

// Keep in sync with the CREATE statements in ./migrate.ts.

export const LEAD_STATUSES = [
  'New',
  'Processing',
  'Existing Client',
  'Disqualified',
  'Low Score',
  'Approved',
  'Contacted',
  'Replied',
  'Meeting Booked',
  'Won',
  'Lost',
  'Rejected',
  'Error',
  'Deleted',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** The sales pipeline, as columns on the board. */
export const PIPELINE_STAGES = ['Approved', 'Contacted', 'Replied', 'Meeting Booked', 'Won', 'Lost'] as const satisfies readonly LeadStatus[];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
/** Stages where the conversation has moved on, so no more follow-ups. */
export const ENGAGED_STAGES: readonly LeadStatus[] = ['Replied', 'Meeting Booked', 'Won', 'Lost'];

/** A recent news item that suggests the company needs INVECK now. */
export type Signal = { headline: string; date: string; url: string; source: string; kind: string };

export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  company: text('company').notNull(),
  /**
   * The name as first found (by prospecting or a CSV), kept when research corrects it to the official
   * name its website shows ("Advanced Forgings" for Advance Forgings): searched as an alias, never written.
   */
  nameAsFound: text('name_as_found').notNull().default(''),
  /** What the company name was checked against: its website, its domain, or the team ('' = not checked yet). */
  nameEvidence: text('name_evidence').notNull().default(''),
  website: text('website').notNull().default(''),
  /** The company's LinkedIn page, when the people-first search found it there ('' otherwise). */
  companyLinkedin: text('company_linkedin').notNull().default(''),
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
  /** Follow-up emails used so far (0-5). nextFollowUpAt is no longer used: the sequence's tasks carry the dates. */
  followUpStep: integer('follow_up_step').notNull().default(0),
  nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
  followUpSubject: text('follow_up_subject').notNull().default(''),
  followUpBody: text('follow_up_body').notNull().default(''),
  /**
   * The India day (YYYY-MM-DD) of the call that started the follow-up sequence (Day 1); '' = never
   * enrolled. A connected call stops the sequence but leaves this set, so it never starts again.
   */
  followUpStartedOn: text('follow_up_started_on').notNull().default(''),
  /** Deleted (soft): why, when, and the stage to restore it to. The lead and its history are kept. */
  deletedReason: text('deleted_reason').notNull().default(''),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  statusBeforeDelete: text('status_before_delete').notNull().default(''),
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
  /** The India day (YYYY-MM-DD) this lead was handed out in the morning draw; empty when it came another way. */
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
  /**
   * When the main contact was confirmed: a LinkedIn profile showing them at this company now, at this
   * site when the lead has a city (or entered by the sales team). Empty until then; the morning draw
   * only hands out leads whose contact is confirmed, or that have none yet.
   */
  contactVerifiedAt: timestamp('contact_verified_at', { withTimezone: true }),
  signals: jsonb('signals').$type<Signal[]>().notNull().default([]),
  signalsCheckedAt: timestamp('signals_checked_at', { withTimezone: true }),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  /** Research attempts that started; a lead whose research keeps timing out stops being retried. */
  researchAttempts: integer('research_attempts').notNull().default(0),
  /**
   * The main contact's email, kept as four separate facts (emailStatus is the readable summary):
   * where it came from ('manual' typed by the team, 'website', 'web', 'prospeo', 'apollo', 'inferred' from the
   * company's format), our verdict ('verified', 'catch_all', 'unverified', 'invalid'), the provider's
   * own status as returned (Prospeo's or Apollo's), and when the provider returned it.
   */
  emailSource: text('email_source').notNull().default(''),
  emailVerification: text('email_verification').notNull().default(''),
  emailProviderStatus: text('email_provider_status').notNull().default(''),
  emailRetrievedAt: timestamp('email_retrieved_at', { withTimezone: true }),
  /**
   * The ICP fit decided from evidence (see pipeline/fit.ts): 'qualified', 'not_fit' or 'review';
   * '' for leads researched before evidence was checked (their fitScore and fitReason still stand).
   */
  fitStatus: text('fit_status').$type<FitStatus | ''>().notNull().default(''),
  /** Why: the must-have that failed or the deal-breaker that applies, what needs review, or what was met. */
  fitDecision: text('fit_decision').notNull().default(''),
  /** Every ICP criterion with its status, the quote and the source it came from. */
  fitEvidence: jsonb('fit_evidence').$type<FitEvidence[]>().notNull().default([]),
  /** Commercial risks seen (insolvency, liquidation): kept apart from the fit. */
  riskFlags: jsonb('risk_flags').$type<RiskFlag[]>().notNull().default([]),
  /** The ICP the fit was checked against, and when. */
  assessedIcp: text('assessed_icp').notNull().default(''),
  assessedAt: timestamp('assessed_at', { withTimezone: true }),
  /** A person's own call on the fit ('qualified' or 'not_fit'), which research again keeps; '' for none. */
  fitOverride: text('fit_override').$type<'' | 'qualified' | 'not_fit'>().notNull().default(''),
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

/**
 * Companies INVECK already has in its own lead lists (uploaded from a CSV), by location: the prospect
 * search and the new facility radar never offer that company at that location again (another plant
 * elsewhere is a new lead). Without a location, the company is skipped everywhere.
 */
export const knownCompanies = pgTable('known_companies', {
  id: serial('id').primaryKey(),
  company: text('company').notNull(),
  website: text('website').notNull().default(''),
  location: text('location').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type KnownCompany = typeof knownCompanies.$inferSelect;

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export type RunStats = {
  prospectsAdded: number;
  processed: number;
  drafted: number;
  disqualified: number;
  /** Absent on runs from before the Needs Review stage. */
  needsReview?: number;
  existingClients: number;
  errors: number;
};

export const runs = pgTable('runs', {
  id: serial('id').primaryKey(),
  findProspects: boolean('find_prospects').notNull().default(false),
  /** Who gets the prospects this run finds: '' (the morning draw), 'team' (split across the team now) or a user id. */
  prospectsTo: text('prospects_to').notNull().default(''),
  status: text('status').$type<'running' | 'done' | 'failed' | 'cancelled'>().notNull().default('running'),
  trigger: text('trigger').notNull().default('manual'),
  stats: jsonb('stats').$type<RunStats>().notNull(),
  error: text('error').notNull().default(''),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  prospectsDone: boolean('prospects_done').notNull().default(false),
  /** The people-first prospect search's progress (see sourcing/morning.ts); null on runs that didn't search. */
  sourcing: jsonb('sourcing'),
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

/**
 * Every Google search the prospect finder has run, kept across runs so later runs search somewhere
 * new instead of repeating themselves. `normQuery` is the query's words as a set (see query-history).
 */
export const prospectSearches = pgTable('prospect_searches', {
  id: serial('id').primaryKey(),
  query: text('query').notNull(),
  normQuery: text('norm_query').notNull().default(''),
  segment: text('segment').notNull().default(''),
  runId: integer('run_id'),
  searchedAt: timestamp('searched_at', { withTimezone: true }).notNull().defaultNow(),
  /** 'ok', or 'failed' when Google refused it (no credits, a wrong key). */
  status: text('status').$type<'ok' | 'failed'>().notNull().default('ok'),
  resultsCount: integer('results_count').notNull().default(0),
  /** Results not about a company already known. */
  freshCount: integer('fresh_count').notNull().default(0),
  /** New companies added from this search. */
  addedCount: integer('added_count').notNull().default(0),
  error: text('error').notNull().default(''),
});
export type ProspectSearch = typeof prospectSearches.$inferSelect;

/**
 * What the searches turned up: each result seen, and each company the AI picked out of them, with what
 * became of it. Companies seen before are skipped before any research is spent on them.
 * outcome: 'known' (a result about a company already known), 'result' (a new result, looked at),
 * 'added' (a company saved as a new prospect), 'duplicate' (a company picked but already known).
 */
export const prospectResults = pgTable('prospect_results', {
  id: serial('id').primaryKey(),
  searchId: integer('search_id'),
  runId: integer('run_id'),
  url: text('url').notNull().default(''),
  domain: text('domain').notNull().default(''),
  title: text('title').notNull().default(''),
  company: text('company').notNull().default(''),
  normCompany: text('norm_company').notNull().default(''),
  /** The location of a company picked (added or duplicate): the same company elsewhere is a new branch. */
  city: text('city').notNull().default(''),
  outcome: text('outcome').$type<'known' | 'result' | 'added' | 'duplicate'>().notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ProspectResult = typeof prospectResults.$inferSelect;

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
  /** Where they were found: LinkedIn, Company website / records, Sales team (Hunter on older rows). */
  source: text('source').notNull().default(''),
  isPrimary: boolean('is_primary').notNull().default(false),
  /** When the P2 flow moved on from this person (no answer, not the right person): not tried again automatically. */
  passedAt: timestamp('passed_at', { withTimezone: true }),
  /**
   * Why they were moved past: 'tried' (no answer, not the right person: not tried again
   * automatically), 'unverified' (LinkedIn couldn't confirm them at this site: checked again later) or
   * 'excluded' (found at the company, not a contact for this site; see whyNot).
   * Empty on rows from before it was recorded.
   */
  passedReason: text('passed_reason').notNull().default(''),
  /** What showed they work at the company, and whether it was dated (shown on the lead page). */
  evidence: text('evidence').notNull().default(''),
  /**
   * Why they aren't the main contact, when set aside: a corporate contact for review, staff at another
   * site, a role not on the ICP lists, not confirmed at the site. passedReason 'excluded' marks someone
   * found at the company who is not a contact for this site (never contacted or checked automatically).
   */
  whyNot: text('why_not').notNull().default(''),
  /** When this person was last checked on LinkedIn (still there, current title); null = not yet. */
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** Where they are based, from their LinkedIn profile ("Jaipur, Rajasthan, India"); empty when unknown. */
  location: text('location').notNull().default(''),
  /** P1, P2 or P3 when the team chose it; '' = worked out from the title. */
  tier: text('tier').notNull().default(''),
  /** Where their current job at the company is, from that job's own entry; empty when not shown. */
  jobLocation: text('job_location').notNull().default(''),
  /** The site their title says they are responsible for ("Plant Head - Coimbatore"); empty when none. */
  responsibility: text('responsibility').notNull().default(''),
  /** The email's source, our verdict, the provider's status and retrieval date (see leads.emailSource). */
  emailSource: text('email_source').notNull().default(''),
  emailVerification: text('email_verification').notNull().default(''),
  emailProviderStatus: text('email_provider_status').notNull().default(''),
  emailRetrievedAt: timestamp('email_retrieved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type Person = typeof people.$inferSelect;

/** Paid lookups already made (Apollo), so a person isn't paid for twice. Never holds phone numbers. */
export const enrichmentCache = pgTable('enrichment_cache', {
  key: text('key').primaryKey(),
  provider: text('provider').notNull().default(''),
  value: jsonb('value').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});
export type NewPerson = typeof people.$inferInsert;

export const USER_ROLES = ['admin', 'bda', 'marketing'] as const;
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
  /** Their own daily list for the morning draw, per segment (null: the Settings numbers). */
  drawManufacturing: integer('draw_manufacturing'),
  drawLogistics: integer('draw_logistics'),
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
  /** connected, no_answer, busy, wrong_number, no_contact, sent, done or skipped. */
  outcome: text('outcome').notNull().default(''),
  /** The lead's stage before logging this moved it on, so Undo can put it back. */
  stageFrom: text('stage_from').notNull().default(''),
  /** An email follow-up marked sent by hand: the follow-up draft and count it used up (JSON), so Undo can put them back. */
  followUpFrom: text('follow_up_from').notNull().default(''),
  /** 1-5 for a task of the follow-up sequence (Follow-up 1 to 5); 0 for any other task. */
  followUpRound: integer('follow_up_round').notNull().default(0),
  /** 1-3 for a task of a CA firm's follow-up rounds (after its LinkedIn request); 0 for any other task. */
  caRound: integer('ca_round').notNull().default(0),
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

/**
 * A team member's Outlook mailbox (Microsoft 365), connected once on the Account page: emails go out
 * from it. Only the refresh token is kept, encrypted (see lib/mail/outlook.ts); never shown anywhere.
 */
export const mailboxes = pgTable('mailboxes', {
  userId: integer('user_id').primaryKey(),
  address: text('address').notNull(),
  displayName: text('display_name').notNull().default(''),
  refreshToken: text('refresh_token').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  /** Why the last send couldn't use it (e.g. the connection expired): shown on the Account page. */
  lastError: text('last_error').notNull().default(''),
  /** What Microsoft said was allowed when it was connected (space-separated); '' for a connection made before calendars were added. */
  scopes: text('scopes').notNull().default(''),
});
export type Mailbox = typeof mailboxes.$inferSelect;

/**
 * Every email sent from the app: what went, from whom, to whom, and Outlook's id for it, so a
 * follow-up is a reply in the same thread. One per Today step (`taskId`), so a second click never
 * sends twice.
 */
export const sentEmails = pgTable('sent_emails', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(),
  taskId: integer('task_id').unique(),
  userId: integer('user_id').notNull(),
  fromAddress: text('from_address').notNull().default(''),
  toAddress: text('to_address').notNull(),
  subject: text('subject').notNull().default(''),
  body: text('body').notNull().default(''),
  /** Outlook's (immutable) message id and conversation. */
  graphId: text('graph_id').notNull().default(''),
  conversationId: text('conversation_id').notNull().default(''),
  /** 'sending' while Outlook is being asked; 'sent' once it took it. */
  status: text('status').notNull().default('sending'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type SentEmail = typeof sentEmails.$inferSelect;

/**
 * A WhatsApp number INVECK is in touch with (`waId`: country code and number, digits only), and
 * whether it may message them from its business number: when and how they agreed, who logged it, and
 * when they asked to stop. Messages from INVECK's number only ever go to numbers that agreed.
 */
export const whatsappContacts = pgTable('whatsapp_contacts', {
  waId: text('wa_id').primaryKey(),
  leadId: integer('lead_id'),
  /** The name on their WhatsApp profile, from their messages. */
  profileName: text('profile_name').notNull().default(''),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  /** The team member who logged it; null when they messaged INVECK themselves. */
  consentBy: integer('consent_by'),
  /** How they agreed, in words: "On a call", "They messaged INVECK on WhatsApp"... */
  consentHow: text('consent_how').notNull().default(''),
  /** The call it was logged on, so undoing the call takes it back. */
  consentTaskId: integer('consent_task_id'),
  /** They asked to stop (STOP): nothing more goes to them until they agree again. */
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
  /** Their last message: for 24 hours after it, a free-text reply may go (otherwise only the approved template). */
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  /** When the approved template last went to them: not again for a week unless they reply. */
  lastTemplateAt: timestamp('last_template_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type WhatsappContact = typeof whatsappContacts.$inferSelect;

/**
 * Every WhatsApp message to and from INVECK's business number. Sent ones are one per Today step
 * (`taskId`), so a second click never sends twice; `wamid` is WhatsApp's id, which delivery updates
 * and replies refer to.
 */
export const whatsappMessages = pgTable('whatsapp_messages', {
  id: serial('id').primaryKey(),
  waId: text('wa_id').notNull(),
  leadId: integer('lead_id'),
  taskId: integer('task_id').unique(),
  /** Who sent it (outgoing). */
  userId: integer('user_id'),
  direction: text('direction').$type<'in' | 'out'>().notNull(),
  /** 'template' or 'text' going out; what came in ('text', 'image', 'button'...). */
  kind: text('kind').notNull().default('text'),
  template: text('template').notNull().default(''),
  /** The text as sent or received (a template filled in). */
  body: text('body').notNull().default(''),
  wamid: text('wamid').notNull().default(''),
  /** Going out: sending, sent, delivered, read or failed. Coming in: received. */
  status: text('status').notNull().default('sending'),
  error: text('error').notNull().default(''),
  /** A message that came in, once dealt with (answered, or marked done): off the replies list. */
  handledAt: timestamp('handled_at', { withTimezone: true }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  statusAt: timestamp('status_at', { withTimezone: true }),
});
export type WhatsappMessage = typeof whatsappMessages.$inferSelect;

/**
 * CA firms taken from the master Google Sheet, one row per firm (never the whole sheet): which firm
 * (sourceKey, from its ICAI profile), who it was given to and on which India day. A firm in this table is
 * never picked again, so a retried allocation can't give the same firm out twice. ownerId is null for a
 * firm that was set aside (it was already a lead or a client).
 */
export const sheetFirms = pgTable('sheet_firms', {
  sourceKey: text('source_key').primaryKey(),
  spreadsheetId: text('spreadsheet_id').notNull().default(''),
  tab: text('tab').notNull().default(''),
  company: text('company').notNull().default(''),
  /** The row it was on when taken (rows can move, so this is for reference only). */
  rowNumber: integer('row_number').notNull().default(0),
  ownerId: integer('owner_id'),
  leadId: integer('lead_id'),
  assignedOn: text('assigned_on').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type SheetFirm = typeof sheetFirms.$inferSelect;

/**
 * A sourcing test: companies found through their LinkedIn pages, screened, and checked for reachable
 * people. Only the report is kept: no lead, no prospect history, nothing sent.
 */
export const sourcingTests = pgTable('sourcing_tests', {
  id: serial('id').primaryKey(),
  segment: text('segment').notNull(),
  /**
   * 'companies': company pages first, then their people; 'people': people with the ICP's titles first, then
   * their companies; 'morning': a Morning Sample Run (tomorrow's run and draw on paper, see sourcing/sample-run.ts).
   */
  mode: text('mode').$type<'companies' | 'people' | 'morning'>().notNull().default('companies'),
  /** People first: prospects wanted. Companies first: companies checked for people. */
  companies: integer('companies').notNull().default(30),
  status: text('status').$type<'running' | 'done' | 'failed'>().notNull().default('running'),
  progress: text('progress').notNull().default(''),
  report: jsonb('report'),
  error: text('error').notNull().default(''),
  startedBy: integer('started_by'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  /** Last saved: a running test that stops saving was stopped by the server's time limit. */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/**
 * Companies a search found people at but didn't get to check (it had what it wanted): kept for the next
 * test or sample to check first, so finding them isn't paid for again. One per segment and company.
 */
export const candidateCompanies = pgTable('candidate_companies', {
  id: serial('id').primaryKey(),
  segment: text('segment').notNull(),
  /** As the people write it, and its normalised form (one row per segment). */
  employer: text('employer').notNull(),
  norm: text('norm').notNull(),
  /** The people found there (FoundContact, best first). */
  contacts: jsonb('contacts').notNull(),
  foundAt: timestamp('found_at', { withTimezone: true }).notNull().defaultNow(),
});
export type SourcingTest = typeof sourcingTests.$inferSelect;

export type { ContentPlatform, ContentStatus };

/**
 * A post on the Marketing content calendar. The date and the status are two separate facts and neither
 * overwrites the other: scheduledOn ('' = not on the calendar yet, a draft in the side list) and status.
 */
export const contentPosts = pgTable('content_posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  platform: text('platform').$type<ContentPlatform>().notNull(),
  /** post, carousel, reel, story, video or article (which ones depends on the platform). */
  format: text('format').notNull().default('post'),
  caption: text('caption').notNull().default(''),
  /** India day (YYYY-MM-DD) it is planned for; '' while it is only a draft with no date. */
  scheduledOn: text('scheduled_on').notNull().default(''),
  status: text('status').$type<ContentStatus>().notNull().default('draft'),
  /** What it is waiting for; kept when the status changes, shown while it is waiting. */
  dependencyNote: text('dependency_note').notNull().default(''),
  /** When it was marked Posted; empty while it isn't. */
  postedAt: timestamp('posted_at', { withTimezone: true }),
  /** Who it is assigned to (a content_people row); null = nobody. */
  assigneeId: integer('assignee_id'),
  /** Google Drive link to the uploaded content; '' = none. */
  driveLink: text('drive_link').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ContentPost = typeof contentPosts.$inferSelect;

/** People content can be assigned to (the Marketing area's People tab). */
export const contentPeople = pgTable('content_people', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ContentPerson = typeof contentPeople.$inferSelect;

/** A one-line to-do on the content calendar: scheduledOn '' while it is only in the side list. Completed ones are deleted for good. */
export const contentTodos = pgTable('content_todos', {
  id: serial('id').primaryKey(),
  text: text('text').notNull(),
  scheduledOn: text('scheduled_on').notNull().default(''),
  done: boolean('done').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ContentTodo = typeof contentTodos.$inferSelect;

/**
 * A Microsoft Teams meeting scheduled from a connected call (the calendar event is in the BDA's own Microsoft 365
 * calendar, which sends the invitation). `requestKey` is unique per lead, step, time and attendee, so retrying never
 * makes a second meeting; `status` is 'creating' until Graph has returned the event and its Teams link.
 */
export const leadMeetings = pgTable('lead_meetings', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull(),
  taskId: integer('task_id'),
  requestKey: text('request_key').notNull().unique(),
  title: text('title').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** The BDA whose calendar holds it, and that mailbox. */
  organizerId: integer('organizer_id').notNull(),
  organizerEmail: text('organizer_email').notNull().default(''),
  attendeeEmail: text('attendee_email').notNull(),
  attendeeName: text('attendee_name').notNull().default(''),
  graphEventId: text('graph_event_id').notNull().default(''),
  joinUrl: text('join_url').notNull().default(''),
  status: text('status').$type<'creating' | 'scheduled'>().notNull().default('creating'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type LeadMeeting = typeof leadMeetings.$inferSelect;
