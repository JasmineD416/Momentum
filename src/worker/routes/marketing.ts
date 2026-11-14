import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ACTIVITY_DIRECTIONS, ACTIVITY_METHODS, ACTIVITY_OUTCOMES, BRANDS, CONTACT_SOURCES, CURRENCIES, EMAIL_PERMISSIONS, PIPELINE_NAMES, PIPELINES, isClosedStage, type Pipeline } from '../../shared/constants';
import type { AppEnv } from '../env';
import { checkStaff, requireDivision } from '../policy';
import { assertUpdated, audit, body, fail, httpsUrl, newId, nowIso, optDate, optEmail, rev, rowsToApi, text, toApi } from '../util';

/** Marketing relationships: companies, contacts, opportunities, activity and the follow-up queue. All Marketing division only. */
export const marketing = new Hono<AppEnv>();
marketing.use('*', async (c, next) => { requireDivision(c, 'marketing'); await next(); });

const brands = z.array(z.enum(BRANDS)).max(BRANDS.length).default([]);
const optId = z.string().min(1).nullable().default(null);
const withBrands = <T extends Record<string, unknown>>(r: T) => ({ ...toApi(r), brands: JSON.parse(String(r.brands || '[]')) as string[] });

async function exists(db: D1Database, table: 'mk_companies' | 'mk_contacts' | 'campaigns', id: string | null, what: string) {
  if (id && !(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first())) fail(400, `Choose an existing ${what}.`);
}

/* ---------------- Companies ---------------- */
const companyInput = z.object({
  name: z.string().trim().min(1, 'is required').max(200), website: httpsUrl, industry: text(120), brands,
  ownerId: optId, status: z.enum(['Active', 'Archived']).default('Active'), notes: text(4000),
});

marketing.get('/companies', async c => {
  const { results } = await c.env.DB.prepare(`SELECT co.*, m.name AS owner_name,
      (SELECT COUNT(*) FROM mk_contacts x WHERE x.company_id = co.id AND x.status = 'Active') AS contact_count,
      (SELECT COUNT(*) FROM mk_opportunities o WHERE o.company_id = co.id AND o.stage NOT IN ('Won', 'Lost')) AS open_opportunities
    FROM mk_companies co LEFT JOIN members m ON m.id = co.owner_id ORDER BY co.name COLLATE NOCASE LIMIT 5000`).all<Record<string, unknown>>();
  return c.json({ companies: results.map(withBrands) });
});

marketing.post('/companies', async c => {
  const v = await body(c, companyInput);
  await checkStaff(c.env.DB, v.ownerId, 'marketing');
  const id = newId(), t = nowIso();
  await c.env.DB.prepare('INSERT INTO mk_companies (id, name, website, industry, brands, owner_id, status, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.name, v.website, v.industry, JSON.stringify(v.brands), v.ownerId, v.status, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Added company', v.name);
  return c.json({ id }, 201);
});

marketing.patch('/companies/:id', async c => {
  const v = await body(c, companyInput.extend({ rev }));
  await checkStaff(c.env.DB, v.ownerId, 'marketing');
  const r = await c.env.DB.prepare('UPDATE mk_companies SET name = ?, website = ?, industry = ?, brands = ?, owner_id = ?, status = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.name, v.website, v.industry, JSON.stringify(v.brands), v.ownerId, v.status, v.notes, nowIso(), c.req.param('id'), v.rev).run();
  if (!r.meta.changes && !(await c.env.DB.prepare('SELECT 1 FROM mk_companies WHERE id = ?').bind(c.req.param('id')).first())) fail(404, 'Company not found.');
  assertUpdated(r, 'This company');
  await audit(c, 'Updated company', v.name);
  return c.json({ ok: true });
});

/* ---------------- Contacts ---------------- */
const contactInput = z.object({
  name: z.string().trim().min(1, 'is required').max(160), email: optEmail, phone: text(80), companyId: optId, role: text(160),
  source: z.union([z.enum(CONTACT_SOURCES), z.literal('')]).default(''), brands, ownerId: optId,
  emailPermission: z.enum(EMAIL_PERMISSIONS).default('Unknown'), permissionDate: optDate, permissionEvidence: text(1000),
  nextAction: text(300), followUp: optDate, campaignId: optId, status: z.enum(['Active', 'Archived']).default('Active'), notes: text(4000),
  confirmDuplicate: z.boolean().optional(),
});
type ContactInput = z.infer<typeof contactInput>;

async function checkContact(c: Context<AppEnv>, v: ContactInput) {
  const db = c.env.DB;
  await checkStaff(db, v.ownerId, 'marketing');
  await exists(db, 'mk_companies', v.companyId, 'company');
  await exists(db, 'campaigns', v.campaignId, 'campaign');
  // Permission is evidence-based: a recorded preference needs the date it was given, and a grant needs its evidence.
  if (v.emailPermission !== 'Unknown' && !v.permissionDate) fail(400, 'Add the date the email preference was given.');
  if (v.emailPermission === 'Granted' && !v.permissionEvidence) fail(400, 'Add the evidence of email permission (for example the sign-up form or the email that gave it).');
  if (v.emailPermission === 'Granted' && !v.email) fail(400, 'Email permission needs an email address.');
  if (v.emailPermission === 'Unknown') { v.permissionDate = ''; v.permissionEvidence = ''; }
}

/** Creating a contact or changing its email asks for confirmation when another contact already uses that email. */
async function duplicateEmail(c: Context<AppEnv>, v: ContactInput, id = '') {
  if (!v.email || v.confirmDuplicate) return;
  const dup = await c.env.DB.prepare('SELECT name FROM mk_contacts WHERE email = ? COLLATE NOCASE AND id <> ? LIMIT 1').bind(v.email, id).first<{ name: string }>();
  if (dup) fail(409, `${dup.name} already uses ${v.email}. Confirm if a shared email is intentional.`);
}

const CONTACT_SELECT = `SELECT x.*, m.name AS owner_name, co.name AS company_name, ca.name AS campaign_name,
    (SELECT MAX(a.at) FROM mk_activities a WHERE a.contact_id = x.id AND a.kind = 'Activity') AS last_activity
  FROM mk_contacts x LEFT JOIN members m ON m.id = x.owner_id LEFT JOIN mk_companies co ON co.id = x.company_id LEFT JOIN campaigns ca ON ca.id = x.campaign_id`;

marketing.get('/contacts', async c => {
  const where: string[] = [], args: unknown[] = [];
  const brand = c.req.query('brand'); if (brand) { where.push('EXISTS (SELECT 1 FROM json_each(x.brands) WHERE value = ?)'); args.push(brand); }
  const companyId = c.req.query('companyId'); if (companyId) { where.push('x.company_id = ?'); args.push(companyId); }
  const { results } = await c.env.DB.prepare(`${CONTACT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.name COLLATE NOCASE LIMIT 5000`).bind(...args).all<Record<string, unknown>>();
  return c.json({ contacts: results.map(withBrands) });
});

marketing.get('/contacts/:id', async c => {
  const db = c.env.DB, id = c.req.param('id');
  const row = await db.prepare(`${CONTACT_SELECT} WHERE x.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) fail(404, 'Contact not found.');
  const { results: activities } = await db.prepare(`SELECT a.*, m.name AS actor_name, o.title AS opportunity_title FROM mk_activities a LEFT JOIN members m ON m.id = a.actor_id LEFT JOIN mk_opportunities o ON o.id = a.opportunity_id
    WHERE a.contact_id = ? OR a.opportunity_id IN (SELECT id FROM mk_opportunities WHERE contact_id = ?) ORDER BY a.at DESC LIMIT 500`).bind(id, id).all();
  const { results: opportunities } = await db.prepare('SELECT id, title, pipeline, stage, currency, value_cents, probability FROM mk_opportunities WHERE contact_id = ? ORDER BY created_at DESC').bind(id).all();
  return c.json({ contact: withBrands(row!), activities: rowsToApi(activities), opportunities: rowsToApi(opportunities) });
});

marketing.post('/contacts', async c => {
  const v = await body(c, contactInput);
  await checkContact(c, v);
  await duplicateEmail(c, v);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO mk_contacts (id, name, email, phone, company_id, role, source, brands, owner_id, email_permission, permission_date, permission_evidence, next_action, follow_up, campaign_id, status, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.name, v.email, v.phone, v.companyId, v.role, v.source, JSON.stringify(v.brands), v.ownerId, v.emailPermission, v.permissionDate, v.permissionEvidence, v.nextAction, v.followUp, v.campaignId, v.status, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Added marketing contact', v.name);
  return c.json({ id }, 201);
});

marketing.patch('/contacts/:id', async c => {
  const v = await body(c, contactInput.extend({ rev }));
  const id = c.req.param('id');
  const cur = await c.env.DB.prepare('SELECT email FROM mk_contacts WHERE id = ?').bind(id).first<{ email: string }>();
  if (!cur) fail(404, 'Contact not found.');
  await checkContact(c, v);
  if (v.email.toLowerCase() !== cur!.email.toLowerCase()) await duplicateEmail(c, v, id);
  const r = await c.env.DB.prepare(`UPDATE mk_contacts SET name = ?, email = ?, phone = ?, company_id = ?, role = ?, source = ?, brands = ?, owner_id = ?, email_permission = ?, permission_date = ?, permission_evidence = ?,
      next_action = ?, follow_up = ?, campaign_id = ?, status = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.name, v.email, v.phone, v.companyId, v.role, v.source, JSON.stringify(v.brands), v.ownerId, v.emailPermission, v.permissionDate, v.permissionEvidence, v.nextAction, v.followUp, v.campaignId, v.status, v.notes, nowIso(), id, v.rev).run();
  assertUpdated(r, 'This contact');
  await audit(c, 'Updated marketing contact', v.name);
  return c.json({ ok: true });
});

/* ---------------- Opportunities ---------------- */
const oppInput = z.object({
  title: z.string().trim().min(1, 'is required').max(200), pipeline: z.enum(PIPELINE_NAMES as [Pipeline, ...Pipeline[]]), stage: z.string().min(1, 'is required'),
  contactId: optId, companyId: optId, ownerId: optId, brand: z.union([z.enum(BRANDS), z.literal('')]).default(''),
  currency: z.enum(CURRENCIES).default('CAD'), valueCents: z.number().int().min(0).default(0), probability: z.number().int().min(0).max(100).default(0),
  expectedClose: optDate, nextAction: text(300), followUp: optDate, lostReason: text(1000), campaignId: optId, notes: text(4000),
});
type OppInput = z.infer<typeof oppInput>;

async function checkOpp(c: Context<AppEnv>, v: OppInput) {
  const db = c.env.DB;
  if (!(PIPELINES[v.pipeline].stages as readonly string[]).includes(v.stage)) fail(400, `${v.stage} isn’t a stage in ${v.pipeline}.`);
  await exists(db, 'mk_contacts', v.contactId, 'contact');
  await exists(db, 'mk_companies', v.companyId, 'company');
  await exists(db, 'campaigns', v.campaignId, 'campaign');
  await checkStaff(db, v.ownerId, 'marketing');
  if (v.stage === 'Won') v.probability = 100;
  if (v.stage === 'Lost') { v.probability = 0; if (!v.lostReason) fail(400, 'Add the reason this opportunity was lost.'); }
  else v.lostReason = '';
  if (!isClosedStage(v.stage)) {
    if (!v.contactId && !v.companyId) fail(400, 'Link an open opportunity to a contact or a company.');
    if (!v.ownerId) fail(400, 'An open opportunity needs an active staff owner.');
    if (!v.nextAction) fail(400, 'An open opportunity needs a next action.');
    if (!v.followUp) fail(400, 'An open opportunity needs a follow-up date.');
  }
}

/** Expected and probability-weighted values per currency. Each weighted value is rounded to cents before summing. */
export function pipelineTotals(rows: { stage: string; currency: string; value_cents: number; probability: number }[]) {
  const totals: Record<string, { count: number; expectedCents: number; weightedCents: number }> = {};
  for (const r of rows) if (!isClosedStage(r.stage)) {
    const t = (totals[r.currency] ||= { count: 0, expectedCents: 0, weightedCents: 0 });
    t.count++; t.expectedCents += Number(r.value_cents); t.weightedCents += Math.round((Number(r.value_cents) * Number(r.probability)) / 100);
  }
  return totals;
}

const OPP_SELECT = `SELECT o.*, m.name AS owner_name, x.name AS contact_name, co.name AS company_name, ca.name AS campaign_name FROM mk_opportunities o
  LEFT JOIN members m ON m.id = o.owner_id LEFT JOIN mk_contacts x ON x.id = o.contact_id LEFT JOIN mk_companies co ON co.id = o.company_id LEFT JOIN campaigns ca ON ca.id = o.campaign_id`;

marketing.get('/opportunities', async c => {
  const where: string[] = [], args: unknown[] = [];
  const pipeline = c.req.query('pipeline'); if (pipeline) { where.push('o.pipeline = ?'); args.push(pipeline); }
  const state = c.req.query('state') || 'open';
  if (state === 'open') where.push("o.stage NOT IN ('Won', 'Lost')"); else if (state === 'closed') where.push("o.stage IN ('Won', 'Lost')");
  const { results } = await c.env.DB.prepare(`${OPP_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.follow_up = '', o.follow_up, o.title COLLATE NOCASE LIMIT 5000`).bind(...args).all<Record<string, unknown>>();
  return c.json({ opportunities: rowsToApi(results), totals: pipelineTotals(results as never) });
});

marketing.get('/opportunities/:id', async c => {
  const db = c.env.DB, id = c.req.param('id');
  const row = await db.prepare(`${OPP_SELECT} WHERE o.id = ?`).bind(id).first();
  if (!row) fail(404, 'Opportunity not found.');
  const { results } = await db.prepare('SELECT a.*, m.name AS actor_name FROM mk_activities a LEFT JOIN members m ON m.id = a.actor_id WHERE a.opportunity_id = ? ORDER BY a.at DESC, a.created_at DESC').bind(id).all();
  return c.json({ opportunity: toApi(row), history: rowsToApi(results) });
});

const stageEntry = (db: D1Database, oppId: string, contactId: string | null, from: string, to: string, actor: string) => {
  const t = nowIso();
  return db.prepare("INSERT INTO mk_activities (id, kind, contact_id, opportunity_id, at, from_stage, to_stage, actor_id, created_at) VALUES (?, 'Stage change', ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId(), contactId, oppId, t, from, to, actor, t);
};

marketing.post('/opportunities', async c => {
  const v = await body(c, oppInput);
  await checkOpp(c, v);
  const db = c.env.DB, id = newId(), t = nowIso(), me = c.get('member').id;
  await db.batch([
    db.prepare(`INSERT INTO mk_opportunities (id, title, pipeline, stage, contact_id, company_id, owner_id, brand, currency, value_cents, probability, expected_close, next_action, follow_up, lost_reason, campaign_id, closed_at, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, v.title, v.pipeline, v.stage, v.contactId, v.companyId, v.ownerId, v.brand, v.currency, v.valueCents, v.probability, v.expectedClose, v.nextAction, v.followUp, v.lostReason, v.campaignId, isClosedStage(v.stage) ? t : null, v.notes, me, t, t),
    stageEntry(db, id, v.contactId, '', v.stage, me),
  ]);
  await audit(c, 'Added opportunity', `${v.pipeline}: ${v.title}`);
  return c.json({ id }, 201);
});

marketing.patch('/opportunities/:id', async c => {
  const v = await body(c, oppInput.extend({ rev }));
  const db = c.env.DB, id = c.req.param('id');
  const cur = await db.prepare('SELECT stage, pipeline, closed_at FROM mk_opportunities WHERE id = ?').bind(id).first<{ stage: string; pipeline: string; closed_at: string | null }>();
  if (!cur) fail(404, 'Opportunity not found.');
  await checkOpp(c, v);
  const closedAt = isClosedStage(v.stage) ? (isClosedStage(cur!.stage) ? cur!.closed_at : nowIso()) : null;
  const update = db.prepare(`UPDATE mk_opportunities SET title = ?, pipeline = ?, stage = ?, contact_id = ?, company_id = ?, owner_id = ?, brand = ?, currency = ?, value_cents = ?, probability = ?, expected_close = ?,
      next_action = ?, follow_up = ?, lost_reason = ?, campaign_id = ?, closed_at = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.title, v.pipeline, v.stage, v.contactId, v.companyId, v.ownerId, v.brand, v.currency, v.valueCents, v.probability, v.expectedClose, v.nextAction, v.followUp, v.lostReason, v.campaignId, closedAt, v.notes, nowIso(), id, v.rev);
  const changed = v.stage !== cur!.stage || v.pipeline !== cur!.pipeline;
  // The stage entry only lands if the revision-guarded update changed the row (same transaction).
  const stmts = [update];
  if (changed) stmts.push(db.prepare(`INSERT INTO mk_activities (id, kind, contact_id, opportunity_id, at, from_stage, to_stage, actor_id, created_at)
      SELECT ?, 'Stage change', ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(newId(), v.contactId, id, nowIso(), cur!.pipeline === v.pipeline ? cur!.stage : `${cur!.pipeline}: ${cur!.stage}`, v.stage, c.get('member').id, nowIso()));
  const [r] = await db.batch(stmts);
  assertUpdated(r, 'This opportunity');
  await audit(c, changed ? `Moved opportunity to ${v.stage}` : 'Updated opportunity', v.title);
  return c.json({ ok: true });
});

/* ---------------- Activity (append-only) ---------------- */
marketing.post('/activities', async c => {
  const v = await body(c, z.object({
    contactId: optId, opportunityId: optId, at: z.string().datetime({ offset: true, message: 'must be a date and time' }),
    method: z.enum(ACTIVITY_METHODS), direction: z.enum(ACTIVITY_DIRECTIONS), outcome: z.enum(ACTIVITY_OUTCOMES), notes: text(4000),
  }));
  const db = c.env.DB;
  if (!v.contactId && !v.opportunityId) fail(400, 'Link the activity to a contact or an opportunity.');
  if (Date.parse(v.at) > Date.now() + 5 * 60_000) fail(400, 'Record activity after it happens. The time can’t be in the future.');
  await exists(db, 'mk_contacts', v.contactId, 'contact');
  let contactId = v.contactId;
  if (v.opportunityId) {
    const o = await db.prepare('SELECT contact_id FROM mk_opportunities WHERE id = ?').bind(v.opportunityId).first<{ contact_id: string | null }>();
    if (!o) fail(400, 'Choose an existing opportunity.');
    contactId ||= o!.contact_id;
  }
  const id = newId();
  await db.prepare("INSERT INTO mk_activities (id, kind, contact_id, opportunity_id, at, method, direction, outcome, notes, actor_id, created_at) VALUES (?, 'Activity', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, contactId, v.opportunityId, new Date(v.at).toISOString(), v.method, v.direction, v.outcome, v.notes, c.get('member').id, nowIso()).run();
  await audit(c, 'Recorded marketing activity', `${v.method} · ${v.outcome}`);
  return c.json({ id }, 201);
});

/* ---------------- Follow-up queue ---------------- */
// Archived contacts and closed opportunities leave the queue.
marketing.get('/follow-ups', async c => {
  const mine = c.req.query('mine') === '1', me = c.get('member').id;
  const { results } = await c.env.DB.prepare(`
    SELECT 'contact' AS kind, x.id, x.name AS title, x.next_action, x.follow_up, x.owner_id, m.name AS owner_name, co.name AS detail, x.rev FROM mk_contacts x
      LEFT JOIN members m ON m.id = x.owner_id LEFT JOIN mk_companies co ON co.id = x.company_id
      WHERE x.status = 'Active' AND x.follow_up <> '' ${mine ? 'AND x.owner_id = ?1' : ''}
    UNION ALL
    SELECT 'opportunity', o.id, o.title, o.next_action, o.follow_up, o.owner_id, m.name, o.pipeline || ' · ' || o.stage, o.rev FROM mk_opportunities o
      LEFT JOIN members m ON m.id = o.owner_id
      WHERE o.stage NOT IN ('Won', 'Lost') AND o.follow_up <> '' ${mine ? 'AND o.owner_id = ?1' : ''}
    ORDER BY follow_up, title COLLATE NOCASE LIMIT 2000`).bind(...(mine ? [me] : [])).all();
  return c.json({ followUps: rowsToApi(results) });
});
