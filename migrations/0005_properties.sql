-- Properties: each property with its ownership, purchase and sale, manager, mortgage and insurance details,
-- plus its tenants (lease details and contact information) and service providers (with an encrypted password).
-- Access: the "properties" division, which only the Owner can grant.

CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  ownership TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD', 'USD')),
  purchase_date TEXT NOT NULL DEFAULT '',
  purchase_price_cents INTEGER,
  sold_date TEXT NOT NULL DEFAULT '',
  sold_price_cents INTEGER,
  pm_name TEXT NOT NULL DEFAULT '',
  pm_address TEXT NOT NULL DEFAULT '',
  pm_email TEXT NOT NULL DEFAULT '',
  pm_phone TEXT NOT NULL DEFAULT '',
  cra_business_number TEXT NOT NULL DEFAULT '',
  mortgage_company TEXT NOT NULL DEFAULT '',
  loan_number TEXT NOT NULL DEFAULT '',
  insurer TEXT NOT NULL DEFAULT '',
  policy_number TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Sold', 'Archived')),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX properties_name ON properties (name COLLATE NOCASE);

CREATE TABLE property_tenants (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  emergency_contact TEXT NOT NULL DEFAULT '',
  lease_start TEXT NOT NULL DEFAULT '',
  lease_end TEXT NOT NULL DEFAULT '',
  rent_cents INTEGER,
  rent_frequency TEXT NOT NULL DEFAULT 'Monthly',
  rent_due_day TEXT NOT NULL DEFAULT '',
  deposit_cents INTEGER,
  lease_link TEXT NOT NULL DEFAULT '',
  lease_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Current' CHECK (status IN ('Current', 'Former')),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX property_tenants_property ON property_tenants (property_id);

CREATE TABLE property_providers (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  services TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  login TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM, "v1.<iv>.<ciphertext>" (base64url); NULL when no password is stored. Never returned in lists.
  password_enc TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Former')),
  created_by TEXT REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX property_providers_property ON property_providers (property_id);
