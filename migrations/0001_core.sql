-- Momentum phase 1: people and access, JD&Co firm records, division contacts, folders, imports, audit.
-- Money is stored as integer cents. Dates entered by staff are YYYY-MM-DD text; timestamps are ISO 8601 UTC.

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,      -- the Google account used to sign in
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('Owner', 'Administrator', 'Member')),
  divisions TEXT NOT NULL DEFAULT '[]',            -- JSON array of division ids
  active INTEGER NOT NULL DEFAULT 1,
  first_sign_in TEXT,                              -- set on the first successful sign-in
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX one_owner ON members(role) WHERE role = 'Owner';

CREATE TABLE counsel (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  firm TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  practice TEXT NOT NULL DEFAULT '',
  jurisdictions TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  dob TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  import_batch TEXT
);
CREATE INDEX clients_name ON clients(last_name COLLATE NOCASE, first_name COLLATE NOCASE);

CREATE TABLE matters (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  file_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  case_type TEXT NOT NULL,
  loss_date TEXT NOT NULL DEFAULT '',
  lawyer_id TEXT REFERENCES counsel(id),
  staff_id TEXT REFERENCES members(id),
  status TEXT NOT NULL CHECK (status IN ('Open', 'Transferred', 'Closed')),
  opened TEXT NOT NULL DEFAULT '',
  closed TEXT NOT NULL DEFAULT '',
  closing_reason TEXT NOT NULL DEFAULT '',
  box_link TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  import_batch TEXT
);
CREATE INDEX matters_client ON matters(client_id);

CREATE TABLE checklist (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id),
  item TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Not started', 'In progress', 'Complete', 'Not applicable')),
  assignee_id TEXT REFERENCES members(id),
  notes TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  completed_by TEXT REFERENCES members(id),
  completed_at TEXT,
  updated_by TEXT REFERENCES members(id),
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  UNIQUE (matter_id, item)
);

CREATE TABLE pncs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('New', 'Contacting', 'Consult booked', 'Retained', 'Referred', 'Not retained', 'Closed')),
  urgency TEXT NOT NULL DEFAULT 'Normal',
  case_type TEXT NOT NULL DEFAULT '',
  assigned_staff_id TEXT REFERENCES members(id),
  next_action TEXT NOT NULL DEFAULT '',
  follow_up TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',                -- allow-listed intake fields (see src/shared/fields.ts)
  converted_client_id TEXT REFERENCES clients(id),
  converted_matter_id TEXT REFERENCES matters(id),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  import_batch TEXT
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  pnc_id TEXT NOT NULL REFERENCES pncs(id),
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES members(id),  -- the verified staff member who logged it (or imported it)
  historical_staff TEXT NOT NULL DEFAULT '',       -- set only for imported history
  created_at TEXT NOT NULL
);
CREATE INDEX attempts_pnc ON attempts(pnc_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('client', 'marketing')),
  matter_id TEXT REFERENCES matters(id),
  brand TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL CHECK (currency IN ('CAD', 'USD')),
  amount_cents INTEGER NOT NULL,
  hst_cents INTEGER NOT NULL DEFAULT 0,
  pay_status TEXT NOT NULL CHECK (pay_status IN ('Unpaid', 'Paid', 'Reimbursed', 'Unknown')),
  paid_date TEXT NOT NULL DEFAULT '',
  pay_method TEXT NOT NULL DEFAULT '',
  book_status TEXT NOT NULL CHECK (book_status IN ('Not submitted', 'Submitted', 'Reconciled')),
  batch_ref TEXT NOT NULL DEFAULT '',
  receipt TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('Recorded', 'Voided')),
  void_reason TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  import_batch TEXT,
  CHECK (scope <> 'client' OR matter_id IS NOT NULL)
);
CREATE INDEX expenses_scope_date ON expenses(scope, date);
CREATE INDEX expenses_matter ON expenses(matter_id);

CREATE TABLE div_contacts (
  id TEXT PRIMARY KEY,
  division TEXT NOT NULL,
  name TEXT NOT NULL,
  organization TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES members(id),
  next_action TEXT NOT NULL DEFAULT '',
  follow_up TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  import_batch TEXT
);
CREATE INDEX div_contacts_division ON div_contacts(division);

CREATE TABLE folder_items (
  id TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Document',
  status TEXT NOT NULL DEFAULT 'Draft',
  link TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES members(id),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX folder_items_folder ON folder_items(folder);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  rows TEXT NOT NULL,                              -- JSON: [{rowId, n, data, status, message}]
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT REFERENCES members(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'general'            -- 'firm' entries are shown only to JD&Co Law Firm members
);
CREATE INDEX audit_at ON audit(at);
