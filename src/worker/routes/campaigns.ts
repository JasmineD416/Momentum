import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BILLING_CYCLES, BRANDS, CAMPAIGN_STATUSES, CURRENCIES, PROGRAM_STATUSES, utmUrl } from '../../shared/constants';
import type { AppEnv, Member } from '../env';
import { checkStaff, hasFirm, isAdmin, requireDivision } from '../policy';
import { assertUpdated, audit, body, fail, httpsUrl, newId, nowIso, optDate, rev, rowsToApi, text, toApi } from '../util';
import { pipelineTotals } from './marketing';

/** Campaigns (with results derived from linked records) and the marketing program inventory. Marketing division only. */
export const campaigns = new Hono<AppEnv>();
campaigns.use('*', async (c, next) => { requireDivision(c, 'marketing'); await next(); });

/* ---------------- Campaigns ---------------- */
const utmPart = z.string().trim().max(120).regex(/^[^&#?=]*$/, 'can’t contain & # ? or =').default('');
const campaignInput = z.object({
  name: z.string().trim().min(1, 'is required').max(200), brand: z.enum(BRANDS), ownerId: z.string().min(1, 'is required'),
  objective: text(2000), startDate: optDate, endDate: optDate, status: z.enum(CAMPAIGN_STATUSES),
  currency: z.enum(CURRENCIES), budgetCents: z.number().int().min(0).default(0),
  landingUrl: httpsUrl, utmSource: utmPart, utmMedium: utmPart, utmCampaign: utmPart, utmContent: utmPart, utmTerm: utmPart, notes: text(4000),
});
type CampaignInput = z.infer<typeof campaignInput>;

async function checkCampaign(c: Context<AppEnv>, v: CampaignInput) {
  await checkStaff(c.env.DB, v.ownerId, 'marketing');
  if (v.startDate && v.endDate && v.endDate < v.startDate) fail(400, 'The end date can’t be before the start date.');
}

const trackedUrl = (r: Record<string, unknown>) =>
  utmUrl(String(r.landing_url || ''), { source: String(r.utm_source || ''), medium: String(r.utm_medium || ''), campaign: String(r.utm_campaign || ''), content: String(r.utm_content || ''), term: String(r.utm_term || '') });

type Results = {
  contacts: number; opportunities: { open: number; won: number; lost: number }; winRate: number | null;
  wonValue: Record<string, number>; pipeline: ReturnType<typeof pipelineTotals>; tasks: { total: number; done: number };
  spend: Record<string, number>; remainingCents: number; costPerContactCents: number | null;
};

/**
 * Results come only from records staff linked to the campaign by hand. Spend includes HST, excludes voided expenses and is
 * grouped by currency; remaining budget and cost per contact use the budget currency only. Win rate is won ÷ (won + lost).
 */
async function results(db: D1Database, ids: string[]) {
  const out = new Map<string, Results>();
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  const [contacts, opps, tasks, spend] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT campaign_id, COUNT(*) AS n FROM mk_contacts WHERE campaign_id IN (${marks}) GROUP BY campaign_id`).bind(...ids),
    db.prepare(`SELECT campaign_id, stage, currency, value_cents, probability FROM mk_opportunities WHERE campaign_id IN (${marks})`).bind(...ids),
    db.prepare(`SELECT campaign_id, COUNT(*) AS n, SUM(status IN ('Published', 'Completed')) AS done FROM tasks WHERE campaign_id IN (${marks}) GROUP BY campaign_id`).bind(...ids),
    db.prepare(`SELECT campaign_id, currency, SUM(amount_cents + hst_cents) AS total FROM expenses WHERE scope = 'marketing' AND state = 'Recorded' AND campaign_id IN (${marks}) GROUP BY campaign_id, currency`).bind(...ids),
  ]);
  for (const id of ids) {
    const o = opps.results.filter(r => r.campaign_id === id) as { stage: string; currency: string; value_cents: number; probability: number }[];
    const won = o.filter(r => r.stage === 'Won'), lost = o.filter(r => r.stage === 'Lost').length;
    const wonValue: Record<string, number> = {};
    for (const r of won) wonValue[r.currency] = (wonValue[r.currency] || 0) + Number(r.value_cents);
    const t = tasks.results.find(r => r.campaign_id === id);
    out.set(id, {
      contacts: Number(contacts.results.find(r => r.campaign_id === id)?.n ?? 0),
      opportunities: { open: o.length - won.length - lost, won: won.length, lost },
      winRate: won.length + lost ? won.length / (won.length + lost) : null,
      wonValue, pipeline: pipelineTotals(o), tasks: { total: Number(t?.n ?? 0), done: Number(t?.done ?? 0) },
      spend: Object.fromEntries(spend.results.filter(r => r.campaign_id === id).map(r => [String(r.currency), Number(r.total)])),
      remainingCents: 0, costPerContactCents: null,
    });
  }
  return out;
}
function finish(row: Record<string, unknown>, r: Results) {
  const cur = String(row.currency), spent = r.spend[cur] ?? 0;
  r.remainingCents = Number(row.budget_cents) - spent;
  r.costPerContactCents = r.contacts ? Math.round(spent / r.contacts) : null;
  return { ...toApi(row), trackedUrl: trackedUrl(row), results: r };
}

const CAMPAIGN_SELECT = 'SELECT ca.*, m.name AS owner_name FROM campaigns ca LEFT JOIN members m ON m.id = ca.owner_id';

campaigns.get('/campaigns', async c => {
  const { results: rows } = await c.env.DB.prepare(`${CAMPAIGN_SELECT} ORDER BY ca.status IN ('Completed', 'Cancelled'), ca.start_date DESC, ca.name COLLATE NOCASE LIMIT 1000`).all<Record<string, unknown>>();
  const res = await results(c.env.DB, rows.map(r => String(r.id)));
  return c.json({ campaigns: rows.map(r => finish(r, res.get(String(r.id))!)) });
});

campaigns.get('/campaigns/:id', async c => {
  const db = c.env.DB, id = c.req.param('id');
  const row = await db.prepare(`${CAMPAIGN_SELECT} WHERE ca.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) fail(404, 'Campaign not found.');
  const res = await results(db, [id]);
  const [contacts, opportunities, tasks, expenses] = await db.batch([
    db.prepare("SELECT id, name, email, status FROM mk_contacts WHERE campaign_id = ? ORDER BY name COLLATE NOCASE").bind(id),
    db.prepare('SELECT id, title, pipeline, stage, currency, value_cents, probability FROM mk_opportunities WHERE campaign_id = ? ORDER BY title COLLATE NOCASE').bind(id),
    db.prepare('SELECT id, title, status, due_date FROM tasks WHERE campaign_id = ? ORDER BY due_date').bind(id),
    db.prepare("SELECT id, date, provider, currency, amount_cents, hst_cents, state FROM expenses WHERE scope = 'marketing' AND campaign_id = ? ORDER BY date DESC").bind(id),
  ]);
  return c.json({
    campaign: finish(row!, res.get(id)!),
    linked: { contacts: rowsToApi(contacts.results as never), opportunities: rowsToApi(opportunities.results as never), tasks: rowsToApi(tasks.results as never), expenses: rowsToApi(expenses.results as never) },
  });
});

campaigns.post('/campaigns', async c => {
  const v = await body(c, campaignInput);
  await checkCampaign(c, v);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO campaigns (id, name, brand, owner_id, objective, start_date, end_date, status, currency, budget_cents, landing_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.name, v.brand, v.ownerId, v.objective, v.startDate, v.endDate, v.status, v.currency, v.budgetCents, v.landingUrl, v.utmSource, v.utmMedium, v.utmCampaign, v.utmContent, v.utmTerm, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Added campaign', v.name);
  return c.json({ id }, 201);
});

campaigns.patch('/campaigns/:id', async c => {
  const v = await body(c, campaignInput.extend({ rev }));
  if (!(await c.env.DB.prepare('SELECT 1 FROM campaigns WHERE id = ?').bind(c.req.param('id')).first())) fail(404, 'Campaign not found.');
  await checkCampaign(c, v);
  const r = await c.env.DB.prepare(`UPDATE campaigns SET name = ?, brand = ?, owner_id = ?, objective = ?, start_date = ?, end_date = ?, status = ?, currency = ?, budget_cents = ?, landing_url = ?,
      utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, utm_term = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.name, v.brand, v.ownerId, v.objective, v.startDate, v.endDate, v.status, v.currency, v.budgetCents, v.landingUrl, v.utmSource, v.utmMedium, v.utmCampaign, v.utmContent, v.utmTerm, v.notes, nowIso(), c.req.param('id'), v.rev).run();
  assertUpdated(r, 'This campaign');
  await audit(c, 'Updated campaign', v.name);
  return c.json({ ok: true });
});

/* ---------------- Marketing programs ---------------- */
// Visibility: general (all Marketing staff), firm (also needs JD&Co access) or admin (administrators only).
const canSee = (m: Member, visibility: string) => visibility === 'general' || (visibility === 'firm' && hasFirm(m)) || (visibility === 'admin' && isAdmin(m));
const programInput = z.object({
  provider: z.string().trim().min(1, 'is required').max(200), purpose: text(1000), website: httpsUrl, signInUrl: httpsUrl,
  brand: z.union([z.enum(BRANDS), z.literal('')]).default(''), accountOwnerId: z.string().min(1).nullable().default(null),
  accountLogin: text(200), usersRoles: text(2000), vaultLink: httpsUrl, accessNotes: text(2000), support: text(1000),
  billingCycle: z.union([z.enum(BILLING_CYCLES), z.literal('')]).default(''), currency: z.enum(CURRENCIES).default('CAD'), amountCents: z.number().int().min(0).default(0),
  renewalDate: optDate, status: z.enum(PROGRAM_STATUSES).default('Active'), visibility: z.enum(['general', 'firm', 'admin']).default('general'), notes: text(4000),
});
type ProgramInput = z.infer<typeof programInput>;

// Secrets belong in the password manager. Refuse the obvious cases rather than store them.
const SECRET = /\b(password|passcode|pwd|mfa code|recovery code|backup code|api[ _-]?key|secret key|token)\s*[:=]/i;
function checkProgram(c: Context<AppEnv>, v: ProgramInput) {
  const m = c.get('member');
  if (!canSee(m, v.visibility)) fail(403, v.visibility === 'firm' ? 'Only JD&Co Law Firm staff can use firm visibility.' : 'Only administrators can use administrator visibility.');
  if ([v.accountLogin, v.usersRoles, v.accessNotes, v.support, v.notes].some(s => SECRET.test(s)))
    fail(400, 'This looks like a password or secret. Keep those in the password manager and add its link instead.');
  return checkStaff(c.env.DB, v.accountOwnerId, null, 'account owner');
}

campaigns.get('/programs', async c => {
  const m = c.get('member');
  const { results } = await c.env.DB.prepare(`SELECT p.*, o.name AS account_owner_name, cb.name AS created_by_name FROM programs p
    LEFT JOIN members o ON o.id = p.account_owner_id LEFT JOIN members cb ON cb.id = p.created_by WHERE p.area = 'marketing' ORDER BY p.provider COLLATE NOCASE`).all<Record<string, unknown>>();
  return c.json({ programs: rowsToApi(results.filter(r => canSee(m, String(r.visibility)))) });
});

campaigns.post('/programs', async c => {
  const v = await body(c, programInput);
  await checkProgram(c, v);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO programs (id, area, provider, purpose, website, sign_in_url, brand, account_owner_id, account_login, users_roles, vault_link, access_notes, support, billing_cycle, currency, amount_cents, renewal_date, status, visibility, notes, created_by, created_at, updated_at)
    VALUES (?, 'marketing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.provider, v.purpose, v.website, v.signInUrl, v.brand, v.accountOwnerId, v.accountLogin, v.usersRoles, v.vaultLink, v.accessNotes, v.support, v.billingCycle, v.currency, v.amountCents, v.renewalDate, v.status, v.visibility, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Added marketing program', v.provider);
  return c.json({ id }, 201);
});

campaigns.patch('/programs/:id', async c => {
  const v = await body(c, programInput.extend({ rev }));
  const m = c.get('member'), id = c.req.param('id');
  const cur = await c.env.DB.prepare("SELECT created_by, visibility FROM programs WHERE id = ? AND area = 'marketing'").bind(id).first<{ created_by: string; visibility: string }>();
  if (!cur || !canSee(m, cur.visibility)) fail(404, 'Program not found.');
  if (cur!.created_by !== m.id && !isAdmin(m)) fail(403, 'Only the person who added this program or an administrator can change it.');
  await checkProgram(c, v);
  const r = await c.env.DB.prepare(`UPDATE programs SET provider = ?, purpose = ?, website = ?, sign_in_url = ?, brand = ?, account_owner_id = ?, account_login = ?, users_roles = ?, vault_link = ?, access_notes = ?, support = ?,
      billing_cycle = ?, currency = ?, amount_cents = ?, renewal_date = ?, status = ?, visibility = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.provider, v.purpose, v.website, v.signInUrl, v.brand, v.accountOwnerId, v.accountLogin, v.usersRoles, v.vaultLink, v.accessNotes, v.support, v.billingCycle, v.currency, v.amountCents, v.renewalDate, v.status, v.visibility, v.notes, nowIso(), id, v.rev).run();
  assertUpdated(r, 'This program');
  await audit(c, 'Updated marketing program', v.provider);
  return c.json({ ok: true });
});

export { canSee as canSeeProgram };
