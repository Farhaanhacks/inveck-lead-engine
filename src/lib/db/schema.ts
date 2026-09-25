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
  'Rejected',
  'Error',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

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
  targetTitles: text('target_titles').notNull().default(''),
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
