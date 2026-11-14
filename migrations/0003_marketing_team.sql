-- Momentum phase 2: marketing workspace, team work, staff updates, reminders and the attention centre.
-- Marketing tables are separate from legal client records; nothing copies firm contacts into them.

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES members(id),
  objective TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('Planned', 'Active', 'Paused', 'Completed', 'Cancelled')),
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  budget_cents INTEGER NOT NULL DEFAULT 0,          -- budget including tax
  landing_url TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  utm_term TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mk_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  brands TEXT NOT NULL DEFAULT '[]',                -- JSON array of brand names
  owner_id TEXT REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mk_contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  company_id TEXT REFERENCES mk_companies(id),
  role TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  brands TEXT NOT NULL DEFAULT '[]',
  owner_id TEXT REFERENCES members(id),
  email_permission TEXT NOT NULL DEFAULT 'Unknown' CHECK (email_permission IN ('Unknown', 'Granted', 'Declined', 'Unsubscribed')),
  permission_date TEXT NOT NULL DEFAULT '',
  permission_evidence TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  follow_up TEXT NOT NULL DEFAULT '',
  campaign_id TEXT REFERENCES campaigns(id),        -- one primary campaign
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  import_batch TEXT
);
CREATE INDEX mk_contacts_email ON mk_contacts(email COLLATE NOCASE);
CREATE INDEX mk_contacts_company ON mk_contacts(company_id);
CREATE INDEX mk_contacts_campaign ON mk_contacts(campaign_id);

CREATE TABLE mk_opportunities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  stage TEXT NOT NULL,
  contact_id TEXT REFERENCES mk_contacts(id),
  company_id TEXT REFERENCES mk_companies(id),
  owner_id TEXT REFERENCES members(id),
  brand TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  value_cents INTEGER NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  expected_close TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  follow_up TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  campaign_id TEXT REFERENCES campaigns(id),
  closed_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX mk_opps_contact ON mk_opportunities(contact_id);
CREATE INDEX mk_opps_company ON mk_opportunities(company_id);
CREATE INDEX mk_opps_campaign ON mk_opportunities(campaign_id);

-- Append-only: contact activity and opportunity stage history.
CREATE TABLE mk_activities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('Activity', 'Stage change')),
  contact_id TEXT REFERENCES mk_contacts(id),
  opportunity_id TEXT REFERENCES mk_opportunities(id),
  at TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  from_stage TEXT NOT NULL DEFAULT '',
  to_stage TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  CHECK (contact_id IS NOT NULL OR opportunity_id IS NOT NULL)
);
CREATE INDEX mk_activities_contact ON mk_activities(contact_id);
CREATE INDEX mk_activities_opp ON mk_activities(opportunity_id);

-- Marketing (and, later, office) software inventory. Passwords stay in the password manager.
CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL DEFAULT 'marketing' CHECK (area IN ('marketing', 'office')),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  sign_in_url TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  account_owner_id TEXT REFERENCES members(id),
  account_login TEXT NOT NULL DEFAULT '',           -- account email or username, never a password
  users_roles TEXT NOT NULL DEFAULT '',
  vault_link TEXT NOT NULL DEFAULT '',
  access_notes TEXT NOT NULL DEFAULT '',
  support TEXT NOT NULL DEFAULT '',
  billing_cycle TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD', 'USD')),
  amount_cents INTEGER NOT NULL DEFAULT 0,          -- reference subscription amount; never posted as an expense
  renewal_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Trial', 'Paused', 'Cancelled')),
  visibility TEXT NOT NULL DEFAULT 'general' CHECK (visibility IN ('general', 'firm', 'admin')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);

-- Team work and content.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  work_type TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES members(id),
  due_date TEXT NOT NULL DEFAULT '',                -- due or publication date
  priority TEXT NOT NULL DEFAULT 'Normal',
  brief TEXT NOT NULL DEFAULT '',
  creative_link TEXT NOT NULL DEFAULT '',
  published_link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('Planned', 'In progress', 'Ready for review', 'Approved', 'Published', 'Completed')),
  campaign_id TEXT REFERENCES campaigns(id),
  approved_by TEXT REFERENCES members(id),
  approved_at TEXT,
  completed_at TEXT,
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX tasks_due ON tasks(due_date);
CREATE INDEX tasks_campaign ON tasks(campaign_id);

-- Marketing expenses can link to a campaign.
ALTER TABLE expenses ADD COLUMN campaign_id TEXT REFERENCES campaigns(id);
CREATE INDEX expenses_campaign ON expenses(campaign_id);

-- Daily and weekly staff updates. Periods are New York business dates.
CREATE TABLE staff_reports (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  scope TEXT NOT NULL CHECK (scope IN ('general', 'firm')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Draft', 'Submitted')),
  completed TEXT NOT NULL DEFAULT '',
  in_progress TEXT NOT NULL DEFAULT '',
  blockers TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  next_priorities TEXT NOT NULL DEFAULT '',
  counters TEXT NOT NULL DEFAULT '{}',              -- activity snapshot taken when the report is saved
  submitted_at TEXT,
  reviewed_by TEXT REFERENCES members(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  UNIQUE (member_id, kind, scope, period_start)
);

-- Personal reminders.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL,
  assignee_id TEXT NOT NULL REFERENCES members(id),
  creator_id TEXT NOT NULL REFERENCES members(id),
  scope TEXT NOT NULL CHECK (scope IN ('general', 'firm')),
  status TEXT NOT NULL CHECK (status IN ('Open', 'Done')),
  completed_by TEXT REFERENCES members(id),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX reminders_assignee ON reminders(assignee_id, status);

-- Per-person read, dismissed and snoozed state for generated alerts.
CREATE TABLE alert_states (
  member_id TEXT NOT NULL REFERENCES members(id),
  alert_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('read', 'dismissed', 'snoozed')),
  snooze_until TEXT NOT NULL DEFAULT '',            -- business date the snooze ends
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, alert_key)
);
