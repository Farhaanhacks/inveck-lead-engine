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
  `CREATE TABLE IF NOT EXISTS prospect_searches (
    id SERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    norm_query TEXT NOT NULL DEFAULT '',
    segment TEXT NOT NULL DEFAULT '',
    run_id INTEGER,
    searched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'ok',
    results_count INTEGER NOT NULL DEFAULT 0,
    fresh_count INTEGER NOT NULL DEFAULT 0,
    added_count INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS prospect_searches_at_idx ON prospect_searches (searched_at DESC)`,
  `CREATE TABLE IF NOT EXISTS prospect_results (
    id SERIAL PRIMARY KEY,
    search_id INTEGER,
    run_id INTEGER,
    url TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    norm_company TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS prospect_results_domain_idx ON prospect_results (domain)`,
  `CREATE INDEX IF NOT EXISTS prospect_results_company_idx ON prospect_results (norm_company)`,
  `ALTER TABLE prospect_results ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT ''`,
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
  // Team: owners, tasks and attendance.
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_id INTEGER`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS inbound BOOLEAN NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads (owner_id)`,
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'bda',
    password_hash TEXT NOT NULL,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    owner_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    step TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL,
    slot TEXT NOT NULL DEFAULT 'day',
    priority BOOLEAN NOT NULL DEFAULT false,
    note TEXT NOT NULL DEFAULT '',
    done_at TIMESTAMPTZ,
    outcome TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_owner_due_idx ON tasks (owner_id, due_date)`,
  `CREATE INDEX IF NOT EXISTS tasks_lead_idx ON tasks (lead_id)`,
  `CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    UNIQUE (user_id, day)
  )`,
  // P1/P2/P3 contact targeting, and the tracker sheet's columns.
  `ALTER TABLE icps ADD COLUMN IF NOT EXISTS p2_titles TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE icps ADD COLUMN IF NOT EXISTS p3_titles TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE icps ADD COLUMN IF NOT EXISTS avoid_titles TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_feedback TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS remark TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS mail_outcome TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_outcome TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_remark TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS drawn_on TEXT NOT NULL DEFAULT ''`,
  // Call remarks written before they were editable lived only on the logged call: copy the latest one over, once.
  `UPDATE leads SET call_remark = t.note FROM (
     SELECT DISTINCT ON (lead_id) lead_id, note FROM tasks WHERE kind = 'call' AND outcome = 'connected' AND note <> '' ORDER BY lead_id, done_at DESC
   ) t WHERE leads.id = t.lead_id AND leads.call_remark = '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'callRemarkV1')`,
  `INSERT INTO settings (key, value) VALUES ('callRemarkV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // LinkedIn is no longer an outreach step: close the LinkedIn tasks still open (once; they don't count as work).
  `UPDATE tasks SET done_at = now(), outcome = 'closed' WHERE kind = 'linkedin' AND done_at IS NULL AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'noLinkedinTasks')`,
  `INSERT INTO settings (key, value) VALUES ('noLinkedinTasks', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS company_days (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    owner_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (lead_id, day)
  )`,
  // Every company now gets all four steps at once (call, WhatsApp, email, LinkedIn). Once, for sequences already
  // running: a LinkedIn request today where none was sent, and an email beside each open call where there was none.
  `INSERT INTO tasks (lead_id, owner_id, kind, step, title, due_date, slot)
   SELECT DISTINCT ON (t.lead_id) t.lead_id, t.owner_id, 'linkedin', 'Day 1', 'Send the LinkedIn connection request', to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD'), 'day'
   FROM tasks t
   WHERE t.done_at IS NULL AND t.priority = false
     AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.lead_id = t.lead_id AND x.kind = 'linkedin' AND x.outcome = 'sent')
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'allChannelsV1')`,
  `INSERT INTO tasks (lead_id, owner_id, kind, step, title, due_date, slot)
   SELECT t.lead_id, t.owner_id, 'email', t.step, t.step || ': email', t.due_date, t.slot
   FROM tasks t
   WHERE t.kind = 'call' AND t.done_at IS NULL AND t.priority = false
     AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.lead_id = t.lead_id AND x.kind = 'email')
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'allChannelsV1')`,
  `INSERT INTO settings (key, value) VALUES ('allChannelsV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage_from TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_tier TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_channel TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS refetch_pending BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS refetch_claimed_at TIMESTAMPTZ`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_since TIMESTAMPTZ`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_checked_at TIMESTAMPTZ`,
  // The score is now the ICP fit times ten (9/10 = 90); rescore every lead once.
  `UPDATE leads SET final_score = LEAST(100, GREATEST(0, fit_score * 10)), score_breakdown = ''
   WHERE fit_score IS NOT NULL AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'scoreIsFitV1')`,
  `INSERT INTO settings (key, value) VALUES ('scoreIsFitV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Every contact is checked again once for who they work for now (former employees were kept before).
  `UPDATE leads SET contact_checked_at = NULL WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'employerCheckV1')`,
  `INSERT INTO settings (key, value) VALUES ('employerCheckV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS passed_at TIMESTAMPTZ`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS passed_reason TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS evidence TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS job_location TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS responsibility TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS why_not TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS name_as_found TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS name_evidence TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS research_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_verified_at TIMESTAMPTZ`,
  // The LinkedIn search got broader: everyone it couldn't find before is searched again, once.
  `UPDATE leads SET contact_checked_at = NULL WHERE contact_linkedin = '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'broaderLinkedinV1')`,
  `UPDATE people SET checked_at = NULL WHERE linkedin = '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'broaderLinkedinV1')`,
  `INSERT INTO settings (key, value) VALUES ('broaderLinkedinV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Contacts reset (asked for once): every contact the engine or the team saved is wiped and found again
  // with the current rules. Research, stages, owners, call logs and tracker outcomes stay. Leads in an
  // active conversation (a connected call, Replied, Meeting Booked, Won) keep the person they talk to.
  `UPDATE leads SET refetch_pending = true, refetch_claimed_at = NULL
   WHERE status NOT IN ('New', 'Processing', 'Disqualified', 'Existing Client', 'Won', 'Replied', 'Meeting Booked')
     AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = leads.id AND t.kind = 'call' AND t.outcome = 'connected')
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'contactsResetV1')`,
  `DELETE FROM people WHERE lead_id IN (SELECT id FROM leads WHERE refetch_pending)
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'contactsResetV1')`,
  `UPDATE leads SET contact_name = '', contact_title = '', contact_email = '', contact_phone = '', contact_linkedin = '',
     email_status = '', other_decision_makers = '', contact_tier = '', contact_channel = '', contact_since = NULL, contact_checked_at = NULL
   WHERE refetch_pending AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'contactsResetV1')`,
  `INSERT INTO settings (key, value) VALUES ('contactsResetV1', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING`,
  // Fresh start before the team begins (asked for once): every contact is wiped and found again, live
  // conversations included, and everything done so far is cleared: call logs and Today steps, completed
  // companies, attendance, timelines, tracker outcomes and remarks, follow-ups and stages. Every lead
  // comes off its BDA and waits in the pool for the morning draw. Companies and their research stay.
  `UPDATE leads SET refetch_pending = true, refetch_claimed_at = NULL
   WHERE status NOT IN ('New', 'Processing', 'Disqualified', 'Existing Client') AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `DELETE FROM people WHERE lead_id IN (SELECT id FROM leads WHERE refetch_pending) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `UPDATE leads SET contact_name = '', contact_title = '', contact_email = '', contact_phone = '', contact_linkedin = '',
     email_status = '', other_decision_makers = '', contact_tier = '', contact_channel = '', contact_since = NULL, contact_checked_at = NULL
   WHERE refetch_pending AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `DELETE FROM tasks WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `DELETE FROM company_days WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `DELETE FROM attendance WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `DELETE FROM activities WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `UPDATE leads SET owner_id = NULL, drawn_on = '', call_feedback = '', remark = '', call_remark = '', mail_outcome = '', linkedin_outcome = '',
     sent_at = NULL, follow_up_step = 0, next_follow_up_at = NULL, follow_up_subject = '', follow_up_body = '',
     status = CASE WHEN status IN ('Approved', 'Contacted', 'Replied', 'Meeting Booked', 'Won', 'Lost', 'Rejected') THEN 'Approved' ELSE status END
   WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `DELETE FROM settings WHERE (key LIKE 'draw:%' OR key = 'rrNext') AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  // No draw on the day of the fresh start: the first leads go out on the next working morning.
  `INSERT INTO settings (key, value)
   SELECT 'draw:' || to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD'),
     jsonb_build_object('day', to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD'), 'at', now(), 'wanted', 0, 'drawn', 0, 'perOwner', '{}'::jsonb, 'short', false)
   WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO settings (key, value) VALUES ('contactsResetV1', jsonb_build_object('at', now())) ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('at', now()) WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'freshStartV1')`,
  `INSERT INTO settings (key, value) VALUES ('freshStartV1', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS prospects_to TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS prospects_wanted JSONB`,
  // Clear everything (asked for once, before the team starts): every lead and all that hangs off it,
  // research runs and radar finds. Logins, ICPs, settings and the current-clients list stay.
  `DELETE FROM people WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM tasks WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM company_days WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM attendance WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM activities WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM run_events WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM runs WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM opportunities WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM leads WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `DELETE FROM settings WHERE key = 'rrNext' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  // The contacts-reset note on the Team page no longer applies (its own key must stay, so it never runs again).
  `UPDATE settings SET value = jsonb_build_object('at', '2000-01-01T00:00:00Z') WHERE key = 'contactsResetV1' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearAllV1')`,
  `INSERT INTO settings (key, value) VALUES ('clearAllV1', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING`,
  // Names from company records were accepted when they appeared in a search result about another firm
  // (BC Shetty & Co got a "Divya Somani" who doesn't work there). Companies whose main contact came from
  // there have their contacts found again under the stricter rules, once.
  `UPDATE leads SET refetch_pending = true, refetch_claimed_at = NULL
   WHERE id IN (SELECT lead_id FROM people WHERE is_primary AND source = 'Company website / records') AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'webLeadersRecheckV1')`,
  `DELETE FROM people WHERE lead_id IN (SELECT id FROM leads WHERE refetch_pending) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'webLeadersRecheckV1')`,
  `UPDATE leads SET contact_name = '', contact_title = '', contact_email = '', contact_phone = '', contact_linkedin = '',
     email_status = '', other_decision_makers = '', contact_tier = '', contact_since = NULL, contact_checked_at = NULL
   WHERE refetch_pending AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'webLeadersRecheckV1')`,
  `INSERT INTO settings (key, value) VALUES ('webLeadersRecheckV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // People whose LinkedIn was found but whose role wasn't read (it was only in Google's snippet) are
  // checked again once, so the role is filled in.
  `UPDATE leads SET contact_checked_at = NULL WHERE contact_title = '' AND contact_name <> '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'blankTitleRecheckV1')`,
  `UPDATE people SET checked_at = NULL WHERE title = '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'blankTitleRecheckV1')`,
  `INSERT INTO settings (key, value) VALUES ('blankTitleRecheckV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Google's line under each LinkedIn result now decides where someone works today: every saved
  // contact is checked again once, so people who have left (their About text still names the
  // company) are replaced.
  `UPDATE leads SET contact_checked_at = NULL WHERE contact_name <> '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'currentJobRecheckV1')`,
  `UPDATE people SET checked_at = NULL WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'currentJobRecheckV1')`,
  `INSERT INTO settings (key, value) VALUES ('currentJobRecheckV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Leads that stopped on an AI reply that couldn't be read (now repaired, with more retries) are
  // researched again, once.
  `UPDATE leads SET status = 'New', last_error = '' WHERE status = 'Error' AND sent_at IS NULL
     AND (last_error LIKE 'Could not read the AI JSON%' OR last_error LIKE 'The AI draft is missing%' OR last_error LIKE 'AI response was cut off%' OR last_error LIKE 'The AI did not return%' OR last_error LIKE 'The AI returned no text%')
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'aiJsonRetryV1')`,
  `INSERT INTO settings (key, value) VALUES ('aiJsonRetryV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // People based outside India (a "Supply Chain Manager at Rheinmetall" in Detroit) are now dropped:
  // every saved contact is checked again once.
  `UPDATE leads SET contact_checked_at = NULL WHERE contact_name <> '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'abroadRecheckV1')`,
  `UPDATE people SET checked_at = NULL WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'abroadRecheckV1')`,
  `INSERT INTO settings (key, value) VALUES ('abroadRecheckV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // The People list gets the main contact's LinkedIn link and title as checked on LinkedIn (they were
  // only saved on the lead), once.
  `UPDATE people p SET linkedin = l.contact_linkedin FROM leads l
     WHERE p.lead_id = l.id AND (p.is_primary OR lower(p.name) = lower(l.contact_name)) AND l.contact_linkedin <> '' AND p.linkedin <> l.contact_linkedin
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'peopleSyncV1')`,
  `UPDATE people p SET title = l.contact_title FROM leads l
     WHERE p.lead_id = l.id AND (p.is_primary OR lower(p.name) = lower(l.contact_name)) AND l.contact_title <> '' AND p.title <> l.contact_title
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'peopleSyncV1')`,
  `INSERT INTO settings (key, value) VALUES ('peopleSyncV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // The first "based abroad" check also dropped people in Indian towns it didn't know (Jalandhar,
  // Belagavi): every lead that lost someone that way has its contacts found again, once.
  `UPDATE leads SET refetch_pending = true, refetch_claimed_at = NULL
     WHERE id IN (SELECT lead_id FROM activities WHERE lead_id IS NOT NULL AND (text LIKE '%based outside India%' OR text LIKE '%based abroad:%'))
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'abroadRefindV1')`,
  `INSERT INTO settings (key, value) VALUES ('abroadRefindV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Brands are no longer matched on what a company does ("NBC Bearings" matched RBC Bearings), and a
  // lead is one site: people at the company's other locations are left out. Once: leads nobody has
  // worked yet have their contacts found again; on the rest, every saved contact is checked again.
  `UPDATE leads SET refetch_pending = true, refetch_claimed_at = NULL
     WHERE status IN ('Awaiting Approval', 'Approved', 'Needs Manual Contact', 'Low Score')
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = leads.id AND t.done_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = leads.id AND (a.text LIKE 'Main contact changed%' OR a.text LIKE 'Point of contact updated%'))
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'siteRulesV1')`,
  `UPDATE leads SET contact_checked_at = NULL WHERE contact_name <> '' AND NOT refetch_pending AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'siteRulesV1')`,
  `UPDATE people SET checked_at = NULL WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'siteRulesV1')`,
  `INSERT INTO settings (key, value) VALUES ('siteRulesV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // A brand alone no longer makes two companies the same ("Ultra Corpotech" is not Ultra Drugs; Tata
  // Steel is not Tata Motors). Once: every main contact is checked on LinkedIn again.
  `UPDATE leads SET contact_checked_at = NULL WHERE contact_name <> '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'strictBrandV1')`,
  `INSERT INTO settings (key, value) VALUES ('strictBrandV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Phone numbers aren't collected any more (the team finds their own). Once: numbers the app fetched
  // itself are cleared; numbers the team typed in (logged as added by the team, or a point of contact
  // they edited, or a company added by hand) stay.
  `UPDATE leads SET company_phone = '' WHERE company_phone <> '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'phonesOffV1')`,
  `UPDATE leads SET contact_phone = ''
     WHERE contact_phone <> '' AND source NOT IN ('Added by hand', 'Inbound lead')
       AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = leads.id AND (a.text LIKE '%added by the team%' OR a.text LIKE 'Point of contact updated%' OR a.text LIKE 'Main contact changed%'))
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'phonesOffV1')`,
  `UPDATE people SET phone = ''
     WHERE phone <> '' AND source NOT IN ('Added by the team', 'Sales team')
       AND NOT (is_primary AND EXISTS (SELECT 1 FROM leads l WHERE l.id = people.lead_id AND l.contact_phone <> '' AND l.contact_phone = people.phone))
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'phonesOffV1')`,
  `INSERT INTO settings (key, value) VALUES ('phonesOffV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // A contact an earlier research run had picked was labelled 'Sales team' when the lead was researched
  // again (and so kept as if the team had chosen it). Once: those are relabelled; contacts the team really
  // entered (on a company added by hand or as an inbound lead, or set on the lead by someone since) keep it.
  `UPDATE people SET source = 'Earlier research'
     WHERE source = 'Sales team'
       AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = people.lead_id AND l.source IN ('Added by hand', 'Inbound lead'))
       AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = people.lead_id
         AND (a.text LIKE 'Point of contact updated%' OR a.text LIKE 'Main contact changed%' OR a.text LIKE '%added by the team%'))
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'salesTeamLabelV1')`,
  `INSERT INTO settings (key, value) VALUES ('salesTeamLabelV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // A company whose steps were all skipped was counted as done for the day. Once: such records are
  // removed (a company is done only when something was really done for it that day).
  `DELETE FROM company_days cd
     WHERE NOT EXISTS (
       SELECT 1 FROM tasks t
       WHERE t.lead_id = cd.lead_id AND t.done_at IS NOT NULL AND t.outcome NOT IN ('skipped', 'closed', '')
         AND to_char(t.done_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') = cd.day)
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'skipOnlyDaysV1')`,
  `INSERT INTO settings (key, value) VALUES ('skipOnlyDaysV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // Callbacks and call-again days planned before every day got the full set: add their WhatsApp and email, once.
  `INSERT INTO tasks (lead_id, owner_id, kind, step, title, due_date, slot)
   SELECT c.lead_id, c.owner_id, k.kind, c.step, c.step || ': ' || k.label, c.due_date, 'day'
   FROM tasks c CROSS JOIN (VALUES ('whatsapp', 'WhatsApp'), ('email', 'email')) AS k(kind, label)
   WHERE c.kind = 'call' AND c.done_at IS NULL AND (c.priority = true OR c.note LIKE 'auto-retry:%')
     AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.lead_id = c.lead_id AND x.kind = k.kind AND x.due_date = c.due_date AND x.done_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'callbackFullSetV1')`,
  `INSERT INTO settings (key, value) VALUES ('callbackFullSetV1', 'true'::jsonb) ON CONFLICT (key) DO NOTHING`,
  // The fit is decided from evidence per ICP criterion. New columns only: leads researched before keep
  // their status and research; a disqualified one is assessed again only when someone asks for it.
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_status TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_decision TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_evidence JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS assessed_icp TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS assessed_at TIMESTAMPTZ`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_override TEXT NOT NULL DEFAULT ''`,
  // Emails: source, verification, the provider's own status and retrieval date kept apart (Apollo).
  // New columns only; older rows keep their readable email status.
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_source TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verification TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_provider_status TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_retrieved_at TIMESTAMPTZ`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS email_source TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS email_verification TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS email_provider_status TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS email_retrieved_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS enrichment_cache (
    key TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT '',
    value JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Emails the app had looked up itself were cleared once, when it stopped looking them up. That
  // clearing ran on every start and also erased the addresses the team saves (on Today, by import, in
  // Edit point of contact): it is gone. Emails are never looked up, so only the team's are stored.
  `DELETE FROM enrichment_cache WHERE key LIKE 'apollo:%' OR key LIKE 'prospeo:%'`,
  `CREATE TABLE IF NOT EXISTS known_companies (
    id SERIAL PRIMARY KEY,
    company TEXT NOT NULL,
    website TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE known_companies ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS mailboxes (
    user_id INTEGER PRIMARY KEY,
    address TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    refresh_token TEXT NOT NULL,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS sent_emails (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    task_id INTEGER UNIQUE,
    user_id INTEGER NOT NULL,
    from_address TEXT NOT NULL DEFAULT '',
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    graph_id TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sending',
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS sent_emails_lead ON sent_emails (lead_id)`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS follow_up_from TEXT NOT NULL DEFAULT ''`,
  // The follow-up sequence (five rounds, every other working day, started by a no answer / busy / wrong number call).
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_started_on TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_reason TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS status_before_delete TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS follow_up_round INTEGER NOT NULL DEFAULT 0`,
  // CA firms: three follow-up rounds after the LinkedIn request, and the firms taken from the Google Sheet.
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ca_round INTEGER NOT NULL DEFAULT 0`,
  // Marketing's content calendar.
  `CREATE TABLE IF NOT EXISTS content_posts (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    platform TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'post',
    caption TEXT NOT NULL DEFAULT '',
    scheduled_on TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    dependency_note TEXT NOT NULL DEFAULT '',
    posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS content_posts_day_idx ON content_posts (scheduled_on)`,
  `CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    search_prompt TEXT NOT NULL DEFAULT '',
    search_mode TEXT NOT NULL DEFAULT 'ai_planner',
    active BOOLEAN NOT NULL DEFAULT true,
    config_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS search_mode TEXT NOT NULL DEFAULT 'ai_planner'`,
  `ALTER TABLE icps ADD COLUMN IF NOT EXISTS product_id INTEGER`,
  `ALTER TABLE icps ADD COLUMN IF NOT EXISTS search_instructions TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_id INTEGER`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS icp_id INTEGER`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS config_version INTEGER`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS product_id INTEGER`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS config_version INTEGER`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS planner_prompt TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS user_products (user_id INTEGER NOT NULL, product_id INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS user_products_idx ON user_products (user_id, product_id)`,
  `CREATE TABLE IF NOT EXISTS allocation_targets (user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, daily_total INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS allocation_targets_idx ON allocation_targets (user_id, product_id)`,
  `CREATE TABLE IF NOT EXISTS allocation_rules (user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, icp_id INTEGER NOT NULL, daily_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS allocation_rules_idx ON allocation_rules (user_id, product_id, icp_id)`,
  `CREATE TABLE IF NOT EXISTS message_templates (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    icp_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS message_templates_idx ON message_templates (product_id, icp_id, channel)`,
  `CREATE TABLE IF NOT EXISTS email_templates (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    icp_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS email_template_steps (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    icp_id INTEGER NOT NULL,
    step INTEGER NOT NULL,
    template_id INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_template_steps_idx ON email_template_steps (product_id, icp_id, step)`,
  `CREATE TABLE IF NOT EXISTS followup_rules (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    icp_id INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 5,
    spacing_days INTEGER NOT NULL DEFAULT 2,
    outcomes TEXT NOT NULL DEFAULT 'no_answer,busy,wrong_number',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS followup_rules_idx ON followup_rules (product_id, icp_id)`,
  `CREATE TABLE IF NOT EXISTS inbound_demo_rows (
    id SERIAL PRIMARY KEY,
    row_key TEXT NOT NULL UNIQUE,
    sheet_row INTEGER NOT NULL DEFAULT 0,
    submitted_at TIMESTAMPTZ,
    email TEXT NOT NULL DEFAULT '',
    alloc_slot INTEGER,
    alloc_name TEXT NOT NULL DEFAULT '',
    owner_id INTEGER,
    lead_id INTEGER,
    meeting_id INTEGER,
    state TEXT NOT NULL DEFAULT 'imported',
    reason TEXT NOT NULL DEFAULT '',
    raw JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS inbound_demo_rows_lead_idx ON inbound_demo_rows (lead_id)`,
  `CREATE TABLE IF NOT EXISTS contact_linkedin (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'not_started',
    remarks TEXT NOT NULL DEFAULT '',
    updated_by INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS contact_linkedin_person_idx ON contact_linkedin (lead_id, person_id)`,
  `ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS scopes TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS lead_meetings (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    task_id INTEGER,
    request_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    organizer_id INTEGER NOT NULL,
    organizer_email TEXT NOT NULL DEFAULT '',
    attendee_email TEXT NOT NULL,
    attendee_name TEXT NOT NULL DEFAULT '',
    graph_event_id TEXT NOT NULL DEFAULT '',
    join_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'creating',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS lead_meetings_lead_idx ON lead_meetings (lead_id)`,
  `CREATE INDEX IF NOT EXISTS lead_meetings_start_idx ON lead_meetings (starts_at)`,
  `ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS assignee_id INTEGER`,
  `ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS drive_link TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS content_people (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS content_todos (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    scheduled_on TEXT NOT NULL DEFAULT '',
    done BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sheet_firms (
    source_key TEXT PRIMARY KEY,
    spreadsheet_id TEXT NOT NULL DEFAULT '',
    tab TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    row_number INTEGER NOT NULL DEFAULT 0,
    owner_id INTEGER,
    lead_id INTEGER,
    assigned_on TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS sheet_firms_day_idx ON sheet_firms (assigned_on)`,
  `CREATE TABLE IF NOT EXISTS whatsapp_contacts (
    wa_id TEXT PRIMARY KEY,
    lead_id INTEGER,
    profile_name TEXT NOT NULL DEFAULT '',
    consent_at TIMESTAMPTZ,
    consent_by INTEGER,
    consent_how TEXT NOT NULL DEFAULT '',
    consent_task_id INTEGER,
    opted_out_at TIMESTAMPTZ,
    last_inbound_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id SERIAL PRIMARY KEY,
    wa_id TEXT NOT NULL,
    lead_id INTEGER,
    task_id INTEGER UNIQUE,
    user_id INTEGER,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    template TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    wamid TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sending',
    error TEXT NOT NULL DEFAULT '',
    handled_at TIMESTAMPTZ,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status_at TIMESTAMPTZ
  )`,
  // WhatsApp sends a webhook again when it isn't sure it arrived: a message is stored once.
  `CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_wamid ON whatsapp_messages (wamid) WHERE wamid <> ''`,
  `CREATE INDEX IF NOT EXISTS whatsapp_messages_lead ON whatsapp_messages (lead_id)`,
  `CREATE INDEX IF NOT EXISTS whatsapp_messages_wa ON whatsapp_messages (wa_id)`,
  `ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS last_template_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS sourcing_tests (
    id SERIAL PRIMARY KEY,
    segment TEXT NOT NULL,
    companies INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'running',
    progress TEXT NOT NULL DEFAULT '',
    report JSONB,
    error TEXT NOT NULL DEFAULT '',
    started_by INTEGER,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`,
  `ALTER TABLE sourcing_tests ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'companies'`,
  `ALTER TABLE sourcing_tests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS candidate_companies (
    id SERIAL PRIMARY KEY,
    segment TEXT NOT NULL,
    employer TEXT NOT NULL,
    norm TEXT NOT NULL,
    contacts JSONB NOT NULL,
    found_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS candidate_companies_segment_norm ON candidate_companies (segment, norm)`,
  // People first in the scheduled run: where its prospect search got to, and each company's LinkedIn page.
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS sourcing JSONB`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_linkedin TEXT NOT NULL DEFAULT ''`,
  // Each associate's own daily list for the morning draw (empty: the Settings numbers).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS draw_manufacturing INTEGER`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS draw_logistics INTEGER`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`,
  // INVECK's daily lists (20 Oct 2026), set once: Anchal and Puja 40 Manufacturing each (their CA firms come
  // apart); Parimal and Anuradha 40 each in the 12:8 ratio, 24 Manufacturing and 16 3PL. Editable on the Team page.
  `UPDATE users SET draw_manufacturing = 40, draw_logistics = 0
   WHERE role = 'bda' AND lower(split_part(btrim(name), ' ', 1)) IN ('anchal', 'aanchal', 'puja')
   AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'drawQuotasV1')`,
  `UPDATE users SET draw_manufacturing = 24, draw_logistics = 16
   WHERE role = 'bda' AND lower(split_part(btrim(name), ' ', 1)) IN ('parimal', 'anuradha')
   AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'drawQuotasV1')`,
  `INSERT INTO settings (key, value) VALUES ('drawQuotasV1', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING`,
  // INVECK's go-live (21 Oct 2026): the new morning search and draw start on Thursday 22 October, not before.
  // Set once on the live database (a new one has no team yet when this runs, so it starts at once).
  `INSERT INTO settings (key, value) SELECT 'morningStartsOn', to_jsonb('2026-10-22'::text)
   WHERE EXISTS (SELECT 1 FROM users) ON CONFLICT (key) DO NOTHING`,
  // Clear the current leads before handover (asked for once): every lead and all that hangs off it,
  // research runs, radar finds and the prospect search history. Logins, attendance, ICPs, settings, the
  // clients list and the list of INVECK's own leads stay. Runs once, then never again.
  `DELETE FROM people WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM tasks WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM company_days WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM activities WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM run_events WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM runs WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM opportunities WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM prospect_results WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM prospect_searches WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM leads WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `DELETE FROM settings WHERE key = 'rrNext' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'clearLeadsV2')`,
  `INSERT INTO settings (key, value) VALUES ('clearLeadsV2', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING`,
  // Awaiting Approval is gone (INVECK's decision, 20 Oct 2026): passing the ICP check is the approval. Leads
  // still in it become Approved, with a note on their timeline. Matches nothing once done.
  `INSERT INTO activities (lead_id, kind, text, stage)
   SELECT id, 'approved', 'Approved: Awaiting Approval was removed, so a company that passed the ICP check is Approved', 'Approved'
   FROM leads WHERE status = 'Awaiting Approval'`,
  `UPDATE leads SET status = 'Approved', updated_at = now() WHERE status = 'Awaiting Approval'`,
  // No daily Google search limit for now (INVECK's decision, 21 Oct 2026), to see what a run really uses: a
  // budget saved in Settings before is cleared once. One can be set again in Settings.
  `UPDATE settings SET value = value - 'dailySearchBudget'
   WHERE key = 'app' AND jsonb_typeof(value) = 'object' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'searchBudgetOffV1')`,
  `INSERT INTO settings (key, value) VALUES ('searchBudgetOffV1', jsonb_build_object('at', now())) ON CONFLICT (key) DO NOTHING`,
  // Nothing runs on its own on Thursday 22 October 2026 (INVECK's decision, 22 Oct 00:15): see lib/pause.ts.
  `INSERT INTO settings (key, value) SELECT 'pausedDays', '["2026-10-22"]'::jsonb WHERE EXISTS (SELECT 1 FROM users) ON CONFLICT (key) DO NOTHING`,
  // Nor on Friday 23 October 2026 (INVECK's decision, 22 Oct evening): added to the paused days once.
  `UPDATE settings SET value = value || '["2026-10-23"]'::jsonb
   WHERE key = 'pausedDays' AND jsonb_typeof(value) = 'array' AND NOT value @> '["2026-10-23"]'::jsonb
   AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'pauseFriday23V1')`,
  `INSERT INTO settings (key, value) SELECT 'pauseFriday23V1', jsonb_build_object('at', now()) WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'pausedDays') ON CONFLICT (key) DO NOTHING`,
  // P1 only (INVECK's decision, 25 Oct 2026): their P1 designations for Manufacturing and 3PL & Logistics, and no P2
  // or P3. Set once on the live database (raising the product's configuration version, as saving the ICP does); the
  // Configuration page can change them afterwards.
  `UPDATE icps SET target_titles = 'Plant Head, Plant Manager, Head of Manufacturing, Head of Operations, Head of Supply Chain, Supply Chain Manager, General Manager – Operations, General Manager – Supply Chain, Head of Warehouse & Logistics, Director of Operations, Chief Operating Officer (COO), Head of Procurement & Supply Chain', p2_titles = '', p3_titles = ''
   WHERE lower(segment) = 'manufacturing' AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'icpP1OnlyV1')`,
  `UPDATE icps SET target_titles = 'National Head – Operations, Regional Head – Operations, Head of Operations, Head of Logistics, Head of Supply Chain, National Operations Manager, Regional Operations Manager, General Manager – Operations, General Manager – Logistics, Chief Operating Officer (COO), Head of Warehouse Operations, Warehouse Manager, Head of Procurement & Supply Chain', p2_titles = '', p3_titles = ''
   WHERE lower(segment) = '3pl & logistics' AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'icpP1OnlyV1')`,
  `UPDATE products SET config_version = config_version + 1
   WHERE id IN (SELECT product_id FROM icps WHERE lower(segment) IN ('manufacturing', '3pl & logistics'))
   AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'icpP1OnlyV1')`,
  `INSERT INTO settings (key, value) SELECT 'icpP1OnlyV1', jsonb_build_object('at', now()) WHERE EXISTS (SELECT 1 FROM users) ON CONFLICT (key) DO NOTHING`,
  // INVECK's decision, 26 Oct 2026: Finance Head and Finance Controller on the Manufacturing P1 list, and a Store
  // Incharge is never a contact (Manufacturing and 3PL & Logistics; CA firms keep their own rules). Set once, as above.
  `UPDATE icps SET target_titles = 'Plant Head, Plant Manager, Head of Manufacturing, Head of Operations, Head of Supply Chain, Supply Chain Manager, General Manager – Operations, General Manager – Supply Chain, Head of Warehouse & Logistics, Director of Operations, Chief Operating Officer (COO), Finance Head, Finance Controller, Head of Procurement & Supply Chain'
   WHERE lower(segment) = 'manufacturing' AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'icpFinanceStoreV1')`,
  `UPDATE icps SET avoid_titles = CASE WHEN trim(avoid_titles) = '' THEN 'Store Incharge' ELSE avoid_titles || ', Store Incharge' END
   WHERE lower(segment) IN ('manufacturing', '3pl & logistics') AND avoid_titles NOT ILIKE '%store incharge%'
   AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'icpFinanceStoreV1')`,
  `UPDATE products SET config_version = config_version + 1
   WHERE id IN (SELECT product_id FROM icps WHERE lower(segment) IN ('manufacturing', '3pl & logistics'))
   AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'icpFinanceStoreV1')`,
  `INSERT INTO settings (key, value) SELECT 'icpFinanceStoreV1', jsonb_build_object('at', now()) WHERE EXISTS (SELECT 1 FROM users) ON CONFLICT (key) DO NOTHING`,
  // "No contact found" ends a company's follow-ups (INVECK's decision, 27 Oct 2026; see completeTaskAction). Once, for
  // companies where it was logged during their follow-ups before that: their open rounds are ticked off, with a note.
  // CA firms keep their own flow.
  `INSERT INTO activities (lead_id, kind, text)
   SELECT DISTINCT t.lead_id, 'note', 'Follow-ups stopped: "No contact found" was logged during them (tidied up on 27 Oct 2026; open follow-up rounds ticked off)'
   FROM tasks t WHERE t.follow_up_round > 0 AND t.done_at IS NULL
     AND EXISTS (SELECT 1 FROM leads l WHERE l.id = t.lead_id AND l.status <> 'Deleted' AND l.segment !~* '\\m(ca|chartered|audit|accountant)')
     AND EXISTS (SELECT 1 FROM tasks c WHERE c.lead_id = t.lead_id AND c.kind = 'call' AND c.outcome = 'no_contact' AND c.done_at IS NOT NULL
       AND c.done_at >= (SELECT min(r.created_at) FROM tasks r WHERE r.lead_id = t.lead_id AND r.follow_up_round > 0))
     AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'noContactFollowUpsV1')`,
  `UPDATE tasks t SET done_at = now(), outcome = 'closed' WHERE t.follow_up_round > 0 AND t.done_at IS NULL
     AND EXISTS (SELECT 1 FROM leads l WHERE l.id = t.lead_id AND l.status <> 'Deleted' AND l.segment !~* '\\m(ca|chartered|audit|accountant)')
     AND EXISTS (SELECT 1 FROM tasks c WHERE c.lead_id = t.lead_id AND c.kind = 'call' AND c.outcome = 'no_contact' AND c.done_at IS NOT NULL
       AND c.done_at >= (SELECT min(r.created_at) FROM tasks r WHERE r.lead_id = t.lead_id AND r.follow_up_round > 0))
     AND EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'noContactFollowUpsV1')`,
  `INSERT INTO settings (key, value) SELECT 'noContactFollowUpsV1', jsonb_build_object('at', now()) WHERE EXISTS (SELECT 1 FROM users) ON CONFLICT (key) DO NOTHING`,
];
