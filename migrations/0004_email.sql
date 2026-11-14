-- Momentum email: per-entity subscriber lists, bulk imports, mass mailings sent through Amazon SES,
-- unsubscribes, and bounce/complaint suppression. Brand ids are the entity's division id (jdco, lawgirl, ...).

-- One sending identity per entity.
CREATE TABLE email_senders (
  brand TEXT PRIMARY KEY,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  reply_to TEXT NOT NULL DEFAULT '',
  postal_address TEXT NOT NULL DEFAULT '',          -- required in every commercial email (CASL / CAN-SPAM)
  daily_limit INTEGER NOT NULL DEFAULT 500,         -- raise gradually while the domain warms up
  logo_url TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '#C14B8A',
  footer_note TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES members(id),
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);

-- One row per email address, shared by every entity's list.
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  contact_id TEXT REFERENCES mk_contacts(id),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);

-- Membership of an entity's list, with the consent that allows mailing.
CREATE TABLE subscriptions (
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  brand TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Subscribed', 'Unsubscribed')),
  consent_type TEXT NOT NULL CHECK (consent_type IN ('Express', 'Implied')),
  consent_date TEXT NOT NULL,
  consent_source TEXT NOT NULL DEFAULT '',          -- evidence: form, event, purchase, email
  implied_until TEXT NOT NULL DEFAULT '',           -- implied consent stops allowing mail after this date
  unsubscribed_at TEXT,
  unsubscribe_source TEXT NOT NULL DEFAULT '',
  import_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, brand)
);
CREATE INDEX subscriptions_brand ON subscriptions(brand, status);

-- Never mail these again (hard bounces, spam complaints, manual blocks), for every entity.
CREATE TABLE suppressions (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL CHECK (reason IN ('Hard bounce', 'Complaint', 'Manual')),
  detail TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL
);

CREATE TABLE subscriber_imports (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  consent_type TEXT NOT NULL,
  consent_basis TEXT NOT NULL DEFAULT '',
  consent_date TEXT NOT NULL,
  consent_source TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  existing INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',                -- JSON: first problems found [{row, email, message}]
  chunks TEXT NOT NULL DEFAULT '[]',                -- JSON: chunk numbers already applied (retries are ignored)
  status TEXT NOT NULL CHECK (status IN ('Open', 'Complete')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE mailings (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html')),
  body TEXT NOT NULL DEFAULT '',
  campaign_id TEXT REFERENCES campaigns(id),
  status TEXT NOT NULL CHECK (status IN ('Draft', 'Scheduled', 'Sending', 'Paused', 'Sent', 'Cancelled')),
  scheduled_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  pause_reason TEXT NOT NULL DEFAULT '',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  complaint_count INTEGER NOT NULL DEFAULT 0,
  unsubscribe_count INTEGER NOT NULL DEFAULT 0,
  sent_by TEXT REFERENCES members(id),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX mailings_status ON mailings(status);

CREATE TABLE mailing_recipients (
  id TEXT PRIMARY KEY,
  mailing_id TEXT NOT NULL REFERENCES mailings(id),
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Queued', 'Sending', 'Sent', 'Failed', 'Skipped')),
  claim TEXT,
  claimed_at TEXT,
  provider_id TEXT,
  error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  bounced INTEGER NOT NULL DEFAULT 0,
  complained INTEGER NOT NULL DEFAULT 0,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mailing_id, subscriber_id)
);
CREATE INDEX mailing_recipients_queue ON mailing_recipients(mailing_id, status);
CREATE INDEX mailing_recipients_claim ON mailing_recipients(claim);
CREATE INDEX mailing_recipients_provider ON mailing_recipients(provider_id);

-- Messages sent per entity per New York day, for daily sending limits.
CREATE TABLE send_counts (
  brand TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, day)
);
