-- Properties gets a contacts directory like the other divisions, replacing the service providers kept on each property.
-- Contacts gain a city (shown for Properties contacts).

ALTER TABLE div_contacts ADD COLUMN city TEXT NOT NULL DEFAULT '';

-- Copy every service provider into the Properties contacts so nobody's details are lost.
-- The property, address, account number and login go into the notes. Former providers become Archived contacts.
-- Stored passwords are NOT copied: contacts never hold passwords. property_providers is left in place, unused,
-- so the encrypted passwords aren't destroyed; keep account passwords in the password manager.
INSERT INTO div_contacts (id, division, name, organization, role, email, phone, city, owner_id, next_action, follow_up, status, notes, created_by, created_at, updated_at)
  SELECT s.id, 'properties', s.name, s.company, s.services, s.email, s.phone, '', NULL, '', '',
         CASE s.status WHEN 'Active' THEN 'Active' ELSE 'Archived' END,
         trim(
           'Property: ' || p.name ||
           CASE WHEN s.address <> '' THEN char(10) || 'Address: ' || s.address ELSE '' END ||
           CASE WHEN s.account_number <> '' THEN char(10) || 'Account number: ' || s.account_number ELSE '' END ||
           CASE WHEN s.login <> '' THEN char(10) || 'Login: ' || s.login ELSE '' END ||
           CASE WHEN s.notes <> '' THEN char(10) || char(10) || s.notes ELSE '' END
         ),
         s.created_by, s.created_at, s.updated_at
  FROM property_providers s JOIN properties p ON p.id = s.property_id
  WHERE s.id NOT IN (SELECT id FROM div_contacts);
