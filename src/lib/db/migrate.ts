// The schema as idempotent SQL, applied on first use. There's no separate migration
// step to forget on deploy; to change the schema later, append statements such as
// `ALTER TABLE leads ADD COLUMN IF NOT EXISTS ...` to this list.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    company TEXT NOT NULL,
    website TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    segment TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'New',
    source TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    contact_title TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    contact_phone TEXT NOT NULL DEFAULT '',
    contact_linkedin TEXT NOT NULL DEFAULT '',
    other_decision_makers TEXT NOT NULL DEFAULT '',
    research_summary TEXT NOT NULL DEFAULT '',
    qualified BOOLEAN,
    fit_score INTEGER,
    fit_reason TEXT NOT NULL DEFAULT '',
    final_score INTEGER,
    score_breakdown TEXT NOT NULL DEFAULT '',
    email_status TEXT NOT NULL DEFAULT '',
    email_subject TEXT NOT NULL DEFAULT '',
    email_body TEXT NOT NULL DEFAULT '',
    linkedin_message TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    sent_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status)`,
  `CREATE TABLE IF NOT EXISTS icps (
    id SERIAL PRIMARY KEY,
    segment TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    description TEXT NOT NULL DEFAULT '',
    industries TEXT NOT NULL DEFAULT '',
    company_size TEXT NOT NULL DEFAULT '',
    geography TEXT NOT NULL DEFAULT '',
    must_haves TEXT NOT NULL DEFAULT '',
    deal_breakers TEXT NOT NULL DEFAULT '',
    target_titles TEXT NOT NULL DEFAULT '',
    pitch_angle TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    company TEXT NOT NULL,
    website TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    why_bought TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id SERIAL PRIMARY KEY,
    find_prospects BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'running',
    trigger TEXT NOT NULL DEFAULT 'manual',
    stats JSONB NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    cancel_requested BOOLEAN NOT NULL DEFAULT false,
    prospects_done BOOLEAN NOT NULL DEFAULT false,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL,
    lead_id INTEGER,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events (run_id, id)`,
  // Added after the first release.
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_phone TEXT NOT NULL DEFAULT ''`,
  // Unconfirmed guessed emails were briefly saved; they're not trusted, so clear them.
  `UPDATE leads SET contact_email = '', email_status = 'no email found' WHERE email_status LIKE 'best guess%'`,
  // Follow-ups, buying signals and the activity timeline.
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_step INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_subject TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_body TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS signals JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS signals_checked_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS activities (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT '',
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS activities_lead_idx ON activities (lead_id, at)`,
  `CREATE INDEX IF NOT EXISTS activities_kind_idx ON activities (kind, at)`,
  `CREATE INDEX IF NOT EXISTS leads_follow_up_idx ON leads (next_follow_up_at)`,
  // Leads moved back before sending used to keep their sent date; they weren't really contacted.
  `UPDATE leads SET sent_at = NULL, follow_up_step = 0, next_follow_up_at = NULL, follow_up_subject = '', follow_up_body = ''
     WHERE sent_at IS NOT NULL AND status IN ('New', 'Processing', 'Awaiting Approval', 'Approved', 'Rejected', 'Low Score', 'Needs Manual Contact', 'Disqualified', 'Error')`,
  // The minimum-score gate is gone: leads it held back as "Low Score" are researched again and get a draft.
  `UPDATE leads SET status = 'New' WHERE status = 'Low Score'`,
  // Every decision-maker found per company.
  `CREATE TABLE IF NOT EXISTS people (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    email_status TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    linkedin TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS people_lead_idx ON people (lead_id)`,
  // New facility radar.
  `CREATE TABLE IF NOT EXISTS opportunities (
    id SERIAL PRIMARY KEY,
    company TEXT NOT NULL,
    headline TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'new_plant',
    segment TEXT NOT NULL DEFAULT '',
    why TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    lead_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS opportunities_status_idx ON opportunities (status, created_at)`,
];
