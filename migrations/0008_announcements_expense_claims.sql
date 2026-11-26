-- Team › Announcements: administrators post, everyone reads; each person's reads are tracked so unread ones raise an alert.
CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Published',          -- Published | Archived
  posted_by TEXT REFERENCES members(id),
  posted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX announcements_status ON announcements (status, posted_at);

CREATE TABLE announcement_reads (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  read_at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, member_id)
);

-- Team › Expense claims: anyone submits what they paid for; administrators review.
-- Card payments keep only the card type and last four digits, never a full card number.
CREATE TABLE team_expenses (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),    -- who submitted it
  division TEXT NOT NULL DEFAULT '',                  -- which business it's for ('' = general)
  charge_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  company TEXT NOT NULL,
  pay_method TEXT NOT NULL,                           -- Credit card | E-transfer
  card_type TEXT NOT NULL DEFAULT '',
  card_last4 TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Submitted',           -- Submitted | Approved | Declined | Reimbursed
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES members(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX team_expenses_member ON team_expenses (member_id, charge_date);
CREATE INDEX team_expenses_status ON team_expenses (status);

-- Invoices are kept inside the database, so they are included in its backups.
CREATE TABLE team_expense_files (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES team_expenses(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  uploaded_by TEXT REFERENCES members(id),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX team_expense_files_expense ON team_expense_files (expense_id);
