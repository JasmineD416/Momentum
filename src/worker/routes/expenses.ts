import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BOOK_STATUSES, CURRENCIES, PAY_STATUSES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { isAdmin, requireDivision } from '../policy';
import { assertUpdated, audit, body, csvCell, dateStr, fail, httpsUrl, newId, nowIso, optDate, rev, rowsToApi, text } from '../util';

export const expenses = new Hono<AppEnv>();

type Scope = 'client' | 'marketing';
const scopeDivision = (s: Scope) => (s === 'client' ? 'jdco' : 'marketing');
function scopeOf(c: Context<AppEnv>, s: unknown): Scope {
  if (s !== 'client' && s !== 'marketing') fail(400, 'scope must be client or marketing.');
  requireDivision(c, scopeDivision(s as Scope));
  return s as Scope;
}

const input = z.object({
  scope: z.enum(['client', 'marketing']),
  matterId: z.string().nullable().default(null),
  campaignId: z.string().min(1).nullable().default(null),
  brand: text(80),
  date: dateStr,
  provider: z.string().trim().min(1, 'is required').max(200),
  description: text(1000), category: text(80), reference: text(120),
  currency: z.enum(CURRENCIES),
  amountCents: z.number().int(),
  hstCents: z.number().int().default(0),
  payStatus: z.enum(PAY_STATUSES), paidDate: optDate, payMethod: text(80),
  bookStatus: z.enum(BOOK_STATUSES).default('Not submitted'), batchRef: text(80),
  receipt: httpsUrl, notes: text(4000),
});

async function checkExpense(c: Context<AppEnv>, v: z.infer<typeof input>) {
  if (v.scope === 'client') {
    if (!v.matterId) fail(400, 'A client expense must be linked to a matter.');
    if (!(await c.env.DB.prepare('SELECT 1 FROM matters WHERE id = ?').bind(v.matterId).first())) fail(400, 'Choose an existing matter.');
    if (v.campaignId) fail(400, 'Only marketing expenses link to a campaign.');
  } else {
    if (!v.brand) fail(400, 'A marketing expense needs a brand.');
    if (v.campaignId && !(await c.env.DB.prepare('SELECT 1 FROM campaigns WHERE id = ?').bind(v.campaignId).first())) fail(400, 'Choose an existing campaign.');
  }
  if (['Paid', 'Reimbursed'].includes(v.payStatus) && !v.paidDate) fail(400, 'Add the paid date.');
}

function filters(c: Context<AppEnv>, scope: Scope) {
  const month = c.req.query('month') ?? '';
  const where = ['e.scope = ?'], args: unknown[] = [scope];
  if (month) { if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'month must be YYYY-MM.'); where.push('substr(e.date, 1, 7) = ?'); args.push(month); }
  const matterId = c.req.query('matterId'); if (matterId) { where.push('e.matter_id = ?'); args.push(matterId); }
  const brand = c.req.query('brand'); if (brand) { where.push('e.brand = ?'); args.push(brand); }
  const campaignId = c.req.query('campaignId'); if (campaignId) { where.push('e.campaign_id = ?'); args.push(campaignId); }
  const q = (c.req.query('q') || '').trim(); if (q) { where.push("(e.provider || ' ' || e.description || ' ' || e.reference || ' ' || e.category || ' ' || e.notes) LIKE ?"); args.push(`%${q}%`); }
  return { where: where.join(' AND '), args };
}
const SELECT = `SELECT e.*, m.file_number, c.id AS client_id, c.last_name, c.first_name, cb.name AS created_by_name, ca.name AS campaign_name FROM expenses e
  LEFT JOIN matters m ON m.id = e.matter_id LEFT JOIN clients c ON c.id = m.client_id LEFT JOIN members cb ON cb.id = e.created_by LEFT JOIN campaigns ca ON ca.id = e.campaign_id`;

expenses.get('/', async c => {
  const scope = scopeOf(c, c.req.query('scope'));
  const f = filters(c, scope);
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE ${f.where} ORDER BY e.date DESC, e.created_at DESC LIMIT 10000`).bind(...f.args).all<Record<string, unknown>>();
  const totals: Record<string, { amountCents: number; hstCents: number; totalCents: number }> = {};
  for (const r of results) if (r.state === 'Recorded') {
    const t = (totals[String(r.currency)] ||= { amountCents: 0, hstCents: 0, totalCents: 0 });
    t.amountCents += Number(r.amount_cents); t.hstCents += Number(r.hst_cents); t.totalCents += Number(r.amount_cents) + Number(r.hst_cents);
  }
  return c.json({ expenses: rowsToApi(results), totals });
});

expenses.get('/export', async c => {
  const scope = scopeOf(c, c.req.query('scope'));
  const f = filters(c, scope);
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE ${f.where} ORDER BY e.date, e.created_at`).bind(...f.args).all<Record<string, unknown>>();
  const money = (n: unknown) => (Number(n) / 100).toFixed(2);
  const header = ['Date', 'Provider', 'Description', 'Category', 'Reference', scope === 'client' ? 'File number' : 'Brand', scope === 'client' ? 'Client' : 'Campaign', 'Currency', 'Amount before HST', 'HST', 'Total incl HST', 'Payment', 'Paid date', 'Payment method', 'Bookkeeping', 'Batch', 'Receipt', 'State', 'Void reason'];
  const lines = [header, ...results.map(r => [r.date, r.provider, r.description, r.category, r.reference, scope === 'client' ? r.file_number : r.brand, scope === 'client' ? `${r.last_name}, ${r.first_name}` : r.campaign_name, r.currency, money(r.amount_cents), money(r.hst_cents), money(Number(r.amount_cents) + Number(r.hst_cents)), r.pay_status, r.paid_date, r.pay_method, r.book_status, r.batch_ref, r.receipt, r.state, r.void_reason])];
  const totals: Record<string, number> = {};
  for (const r of results) if (r.state === 'Recorded') totals[String(r.currency)] = (totals[String(r.currency)] || 0) + Number(r.amount_cents) + Number(r.hst_cents);
  for (const [cur, t] of Object.entries(totals)) lines.push(['Grand total (recorded)', '', '', '', '', '', '', cur, '', '', money(t)]);
  await audit(c, 'Exported expense CSV', `${scope} ledger`, scope === 'client' ? 'firm' : 'general');
  return new Response(lines.map(l => l.map(csvCell).join(',')).join('\r\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="momentum-${scope}-expenses.csv"`, 'cache-control': 'no-store' },
  });
});

expenses.post('/', async c => {
  const v = await body(c, input);
  scopeOf(c, v.scope);
  await checkExpense(c, v);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO expenses (id, scope, matter_id, campaign_id, brand, date, provider, description, category, reference, currency, amount_cents, hst_cents, pay_status, paid_date, pay_method, book_status, batch_ref, receipt, notes, state, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recorded', ?, ?, ?)`)
    .bind(id, v.scope, v.scope === 'client' ? v.matterId : null, v.campaignId, v.brand, v.date, v.provider, v.description, v.category, v.reference, v.currency, v.amountCents, v.hstCents, v.payStatus, v.paidDate, v.payMethod, v.bookStatus, v.batchRef, v.receipt, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Recorded expense', `${v.provider} ${(v.amountCents + v.hstCents) / 100} ${v.currency}`, v.scope === 'client' ? 'firm' : 'general');
  return c.json({ id }, 201);
});

async function editable(c: Context<AppEnv>, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) fail(404, 'Expense not found.');
  scopeOf(c, row!.scope);
  const m = c.get('member');
  if (row!.created_by !== m.id && !isAdmin(m)) fail(403, 'Only the person who recorded this expense or an administrator can change it.');
  if (row!.state === 'Voided') fail(400, 'Voided expenses can’t be changed.');
  return row!;
}

expenses.patch('/:id', async c => {
  const v = await body(c, input.extend({ rev }));
  const row = await editable(c, c.req.param('id'));
  if (v.scope !== row.scope) fail(400, 'An expense can’t move between ledgers.');
  await checkExpense(c, v);
  const r = await c.env.DB.prepare(`UPDATE expenses SET matter_id = ?, campaign_id = ?, brand = ?, date = ?, provider = ?, description = ?, category = ?, reference = ?, currency = ?, amount_cents = ?, hst_cents = ?, pay_status = ?, paid_date = ?,
    pay_method = ?, book_status = ?, batch_ref = ?, receipt = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.scope === 'client' ? v.matterId : null, v.campaignId, v.brand, v.date, v.provider, v.description, v.category, v.reference, v.currency, v.amountCents, v.hstCents, v.payStatus, v.paidDate, v.payMethod, v.bookStatus, v.batchRef, v.receipt, v.notes, nowIso(), row.id, v.rev).run();
  assertUpdated(r, 'This expense');
  await audit(c, 'Updated expense', String(v.provider), v.scope === 'client' ? 'firm' : 'general');
  return c.json({ ok: true });
});

expenses.post('/:id/void', async c => {
  const v = await body(c, z.object({ reason: z.string().trim().min(1, 'is required').max(500), rev }));
  const row = await editable(c, c.req.param('id'));
  const r = await c.env.DB.prepare("UPDATE expenses SET state = 'Voided', void_reason = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?").bind(v.reason, nowIso(), row.id, v.rev).run();
  assertUpdated(r, 'This expense');
  await audit(c, 'Voided expense', String(row.provider), row.scope === 'client' ? 'firm' : 'general');
  return c.json({ ok: true });
});
