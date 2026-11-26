import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CURRENCIES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { requireDivision } from '../policy';
import { assertUpdated, audit, body, fail, httpsUrl, newId, nowIso, optDate, optEmail, rev, rowsToApi, text, toApi } from '../util';

/**
 * Properties, each with a tenants folder. Service providers and other people live in the Properties contacts (routes/directory.ts).
 * Everything here needs the "properties" division, which only the Owner can grant.
 */
export const properties = new Hono<AppEnv>();

const DIVISION = 'properties';
properties.use('*', async (c, next) => { requireDivision(c, DIVISION); await next(); });

const cents = z.number().int().min(0).max(100_000_000_000).nullable().default(null);
const note = (c: Context<AppEnv>, action: string, entity: string) => audit(c, action, entity, 'properties');

async function loadProperty(c: Context<AppEnv>, id: string) {
  const p = await c.env.DB.prepare('SELECT id, name FROM properties WHERE id = ?').bind(id).first<{ id: string; name: string }>();
  if (!p) fail(404, 'Property not found.');
  return p!;
}

/* ---------------- Properties ---------------- */
const propertyBase = z.object({
  name: z.string().trim().min(1, 'is required').max(160),
  address: z.string().trim().min(1, 'is required').max(400),
  ownership: text(400),
  currency: z.enum(CURRENCIES).default('CAD'),
  purchaseDate: optDate, purchasePriceCents: cents,
  soldDate: optDate, soldPriceCents: cents,
  pmName: text(160), pmAddress: text(400), pmEmail: optEmail, pmPhone: text(80),
  craBusinessNumber: z.string().trim().max(40).regex(/^[0-9A-Za-z ]*$/, 'should be the 9-digit number, optionally with its program account (e.g. 123456789 RT0001)').default(''),
  mortgageCompany: text(200), loanNumber: text(80),
  insurer: text(200), policyNumber: text(80),
  status: z.enum(['Active', 'Sold', 'Archived']).default('Active'),
  notes: text(4000),
});
const propertyRules = (v: z.infer<typeof propertyBase>, ctx: z.RefinementCtx) => {
  if (v.soldDate && v.purchaseDate && v.soldDate < v.purchaseDate) ctx.addIssue({ code: 'custom', path: ['soldDate'], message: 'can’t be before the purchase date' });
  if ((v.soldDate || v.soldPriceCents !== null) && v.status === 'Active') ctx.addIssue({ code: 'custom', path: ['status'], message: 'should be Sold (or Archived) once a sold date or price is entered' });
};
const propertyInput = propertyBase.superRefine(propertyRules);

properties.get('/', async c => {
  const { results } = await c.env.DB.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM property_tenants t WHERE t.property_id = p.id AND t.status = 'Current') AS current_tenants
    FROM properties p ORDER BY p.name COLLATE NOCASE LIMIT 2000`).all();
  return c.json({ properties: rowsToApi(results) });
});

properties.post('/', async c => {
  const v = await body(c, propertyInput);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO properties (id, name, address, ownership, currency, purchase_date, purchase_price_cents, sold_date, sold_price_cents,
      pm_name, pm_address, pm_email, pm_phone, cra_business_number, mortgage_company, loan_number, insurer, policy_number, status, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.name, v.address, v.ownership, v.currency, v.purchaseDate, v.purchasePriceCents, v.soldDate, v.soldPriceCents,
      v.pmName, v.pmAddress, v.pmEmail, v.pmPhone, v.craBusinessNumber, v.mortgageCompany, v.loanNumber, v.insurer, v.policyNumber, v.status, v.notes, c.get('member').id, t, t).run();
  await note(c, 'Added property', v.name);
  return c.json({ id }, 201);
});

properties.get('/:id', async c => {
  const db = c.env.DB, id = c.req.param('id');
  const p = await db.prepare('SELECT * FROM properties WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'Property not found.');
  const { results: tenants } = await db.prepare("SELECT * FROM property_tenants WHERE property_id = ? ORDER BY status = 'Former', unit COLLATE NOCASE, name COLLATE NOCASE").bind(id).all();
  return c.json({ property: toApi(p), tenants: rowsToApi(tenants) });
});

properties.patch('/:id', async c => {
  const v = await body(c, propertyBase.extend({ rev }).superRefine(propertyRules));
  await loadProperty(c, c.req.param('id'));
  const r = await c.env.DB.prepare(`UPDATE properties SET name = ?, address = ?, ownership = ?, currency = ?, purchase_date = ?, purchase_price_cents = ?, sold_date = ?, sold_price_cents = ?,
      pm_name = ?, pm_address = ?, pm_email = ?, pm_phone = ?, cra_business_number = ?, mortgage_company = ?, loan_number = ?, insurer = ?, policy_number = ?, status = ?, notes = ?,
      updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.name, v.address, v.ownership, v.currency, v.purchaseDate, v.purchasePriceCents, v.soldDate, v.soldPriceCents,
      v.pmName, v.pmAddress, v.pmEmail, v.pmPhone, v.craBusinessNumber, v.mortgageCompany, v.loanNumber, v.insurer, v.policyNumber, v.status, v.notes,
      nowIso(), c.req.param('id'), v.rev).run();
  assertUpdated(r, 'This property');
  await note(c, 'Updated property', v.name);
  return c.json({ ok: true });
});

/* ---------------- Tenants ---------------- */
const tenantBase = z.object({
  name: z.string().trim().min(1, 'is required').max(160), unit: text(60),
  email: optEmail, phone: text(80), emergencyContact: text(300),
  leaseStart: optDate, leaseEnd: optDate,
  rentCents: cents, rentFrequency: z.enum(['Monthly', 'Weekly', 'Bi-weekly', 'Yearly']).default('Monthly'), rentDueDay: text(40),
  depositCents: cents, leaseLink: httpsUrl, leaseNotes: text(4000),
  status: z.enum(['Current', 'Former']).default('Current'),
});
const leaseOrder = (v: { leaseStart: string; leaseEnd: string }, ctx: z.RefinementCtx) => {
  if (v.leaseStart && v.leaseEnd && v.leaseEnd < v.leaseStart) ctx.addIssue({ code: 'custom', path: ['leaseEnd'], message: 'can’t be before the lease start' });
};
const tenantInput = tenantBase.superRefine(leaseOrder);

properties.post('/:id/tenants', async c => {
  const p = await loadProperty(c, c.req.param('id'));
  const v = await body(c, tenantInput);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO property_tenants (id, property_id, name, unit, email, phone, emergency_contact, lease_start, lease_end, rent_cents, rent_frequency, rent_due_day,
      deposit_cents, lease_link, lease_notes, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, p.id, v.name, v.unit, v.email, v.phone, v.emergencyContact, v.leaseStart, v.leaseEnd, v.rentCents, v.rentFrequency, v.rentDueDay,
      v.depositCents, v.leaseLink, v.leaseNotes, v.status, c.get('member').id, t, t).run();
  await note(c, 'Added tenant', `${p.name}: ${v.name}`);
  return c.json({ id }, 201);
});

properties.patch('/:id/tenants/:tid', async c => {
  const p = await loadProperty(c, c.req.param('id'));
  const v = await body(c, tenantBase.extend({ rev }).superRefine(leaseOrder));
  const r = await c.env.DB.prepare(`UPDATE property_tenants SET name = ?, unit = ?, email = ?, phone = ?, emergency_contact = ?, lease_start = ?, lease_end = ?, rent_cents = ?, rent_frequency = ?,
      rent_due_day = ?, deposit_cents = ?, lease_link = ?, lease_notes = ?, status = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND property_id = ? AND rev = ?`)
    .bind(v.name, v.unit, v.email, v.phone, v.emergencyContact, v.leaseStart, v.leaseEnd, v.rentCents, v.rentFrequency, v.rentDueDay, v.depositCents, v.leaseLink, v.leaseNotes, v.status,
      nowIso(), c.req.param('tid'), p.id, v.rev).run();
  assertUpdated(r, 'This tenant');
  await note(c, 'Updated tenant', `${p.name}: ${v.name}`);
  return c.json({ ok: true });
});
