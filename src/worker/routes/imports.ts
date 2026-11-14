import { Hono } from 'hono';
import { z } from 'zod';
import { CURRENCIES, DIVISION_IDS, IMPORT_LIMITS, IMPORT_TARGETS, MATTER_STATUSES, PAY_STATUSES, type ImportTarget } from '../../shared/constants';
import type { AppEnv, Member } from '../env';
import { hasDivision, requireAdmin } from '../policy';
import { audit, body, fail, newId, nowIso, toCents } from '../util';

export const imports = new Hono<AppEnv>();
// Imports are an administrator task; each target also needs access to its division.
imports.use('*', async (c, next) => { requireAdmin(c); await next(); });

type Row = { rowId: string; n: number; data: Record<string, string>; status: 'Ready' | 'Duplicate' | 'Error' | 'Committed' | 'Skipped'; message: string };
type Options = { division?: string; ownerId?: string };

export { parseCsv } from '../../shared/csv';
import { parseCsv } from '../../shared/csv';

const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
// Leading apostrophes are how spreadsheets protect text; strip them on the way in.
const clean = (s: string) => s.trim().replace(/^'(?=[=+\-@])/, '');

function requireTargetAccess(m: Member, target: ImportTarget, opts: Options) {
  const t = IMPORT_TARGETS[target];
  if (t.division && !hasDivision(m, t.division)) fail(403, `Importing ${t.label.toLowerCase()} needs access to that division.`);
  if (target === 'divisionContacts') {
    if (!opts.division || !DIVISION_IDS.includes(opts.division as never)) fail(400, 'Choose a division.');
    if (!hasDivision(m, opts.division!)) fail(403, 'You don’t have access to that division.');
  }
}

/** Snapshot of existing records used to validate rows (and re-validate at commit). */
async function loadContext(db: D1Database, target: ImportTarget, opts: Options): Promise<Ctx> {
  const all = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<Record<string, string>>()).results;
  switch (target) {
    case 'clients': return { clients: await all('SELECT id, last_name, first_name, dob, email FROM clients') };
    case 'matters': return { clients: await all('SELECT id, last_name, first_name, dob, email FROM clients'), counsel: await all('SELECT id, name FROM counsel'), matters: await all('SELECT file_number FROM matters') };
    case 'clientExpenses': return { matters: await all('SELECT id, file_number FROM matters'), expenses: await all("SELECT matter_id, date, provider, amount_cents, hst_cents, reference, description FROM expenses WHERE scope = 'client'") };
    case 'pncs': return { pncs: await all('SELECT email, phone FROM pncs') };
    case 'divisionContacts': return { contacts: await all('SELECT email FROM div_contacts WHERE division = ?', opts.division) };
  }
}
type Ctx = Record<string, Record<string, string>[]>;

const expenseKey = (matterId: string, d: Record<string, string>, amt: number, hst: number) => [matterId, d.date, lc(d.provider), amt, hst, lc(d.reference), lc(d.description)].join('|');

/** Returns [status, message, resolved values for commit]. */
function checkRow(target: ImportTarget, d: Record<string, string>, ctx: Ctx, seen: Set<string>): [Row['status'], string, Record<string, unknown>] {
  const bad = ['dob', 'lossDate', 'opened', 'closed', 'followUp', 'date', 'paidDate'].find(k => d[k] && !isDate(d[k]));
  if (bad) return ['Error', `${bad} must be YYYY-MM-DD`, {}];
  if (d.email && !isEmail(d.email)) return ['Error', 'email is not a valid address', {}];
  switch (target) {
    case 'clients': {
      if (!d.lastName) return ['Error', 'lastName is required', {}];
      const key = d.email ? 'e:' + lc(d.email) : 'n:' + [lc(d.lastName), lc(d.firstName), d.dob].join('|');
      const exists = ctx.clients.some(c => (d.email && lc(c.email) === lc(d.email)) || (d.dob && c.dob === d.dob && lc(c.last_name) === lc(d.lastName) && lc(c.first_name) === lc(d.firstName)));
      if (exists || seen.has(key)) return ['Duplicate', 'Matches an existing client (email, or name and date of birth)', {}];
      seen.add(key); return ['Ready', '', {}];
    }
    case 'matters': {
      if (!d.client || !d.fileNumber || !d.caseType) return ['Error', 'client, fileNumber and caseType are required', {}];
      const status = d.status || 'Open';
      if (!MATTER_STATUSES.includes(status as never)) return ['Error', 'status must be Open, Transferred or Closed', {}];
      if (status === 'Closed' && !d.closed) return ['Error', 'Closed files need a closed date', {}];
      let m = ctx.clients.filter(c => c.id === d.client || (isEmail(d.client) && lc(c.email) === lc(d.client)) || lc(`${c.last_name}, ${c.first_name}`) === lc(d.client) || (!c.first_name && lc(c.last_name) === lc(d.client)));
      if (m.length > 1 && d.dob) m = m.filter(c => c.dob === d.dob);
      if (!m.length) return ['Error', 'No matching client. Import clients first, and write the client as "Last, First", the email, or the client ID', {}];
      if (m.length > 1) return ['Error', 'More than one client matches; use the client ID', {}];
      let lawyerId: string | null = null;
      if (d.lawyer) {
        const l = ctx.counsel.filter(x => x.id === d.lawyer || lc(x.name) === lc(d.lawyer));
        if (l.length !== 1) return ['Error', `Lawyer "${d.lawyer}" is not in the lawyer directory`, {}];
        lawyerId = l[0].id;
      }
      if (ctx.matters.some(x => lc(x.file_number) === lc(d.fileNumber)) || seen.has(lc(d.fileNumber))) return ['Duplicate', 'File number already exists', {}];
      seen.add(lc(d.fileNumber));
      return ['Ready', '', { clientId: m[0].id, lawyerId, status }];
    }
    case 'clientExpenses': {
      const mt = ctx.matters.find(x => lc(x.file_number) === lc(d.fileNumber));
      if (!mt) return ['Error', 'No matter with this file number. Import matters first', {}];
      if (!d.date) return ['Error', 'date is required', {}];
      if (!d.provider) return ['Error', 'provider is required', {}];
      const amt = toCents(d.amount), hst = d.hst ? toCents(d.hst) : 0;
      if (Number.isNaN(amt)) return ['Error', 'amount must be a number like 125.00', {}];
      if (Number.isNaN(hst)) return ['Error', 'hst must be a number like 16.25', {}];
      const currency = (d.currency || 'CAD').toUpperCase();
      if (!CURRENCIES.includes(currency as never)) return ['Error', 'currency must be CAD or USD', {}];
      const payStatus = d.payStatus || 'Unknown';
      if (!PAY_STATUSES.includes(payStatus as never)) return ['Error', 'payStatus must be Unpaid, Paid, Reimbursed or Unknown', {}];
      if (d.receipt && !/^https:\/\//i.test(d.receipt)) return ['Error', 'receipt must be an HTTPS link', {}];
      const key = expenseKey(mt.id, d, amt, hst);
      if (ctx.expenses.some(e => expenseKey(e.matter_id, e, Number(e.amount_cents), Number(e.hst_cents)) === key) || seen.has(key)) return ['Duplicate', 'The same expense is already recorded', {}];
      seen.add(key);
      return ['Ready', '', { matterId: mt.id, amountCents: amt, hstCents: hst, currency, payStatus }];
    }
    case 'pncs': {
      if (!d.name) return ['Error', 'name is required', {}];
      const key = lc(d.email) || d.phone;
      if (key && (ctx.pncs.some(p => (d.email && lc(p.email) === lc(d.email)) || (d.phone && p.phone === d.phone)) || seen.has(key))) return ['Duplicate', 'Email or phone matches an existing PNC', {}];
      if (key) seen.add(key);
      return ['Ready', '', {}];
    }
    case 'divisionContacts': {
      if (!d.name) return ['Error', 'name is required', {}];
      if (d.email && (ctx.contacts.some(x => lc(x.email) === lc(d.email)) || seen.has(lc(d.email)))) return ['Duplicate', 'Email already in this division', {}];
      if (d.email) seen.add(lc(d.email));
      return ['Ready', '', {}];
    }
  }
}

imports.post('/preview', async c => {
  const v = await body(c, z.object({ target: z.enum(Object.keys(IMPORT_TARGETS) as [ImportTarget, ...ImportTarget[]]), csv: z.string(), division: z.string().optional(), ownerId: z.string().optional() }));
  const m = c.get('member'), opts: Options = { division: v.division, ownerId: v.ownerId || m.id };
  requireTargetAccess(m, v.target, opts);
  if (new TextEncoder().encode(v.csv).length > IMPORT_LIMITS.bytes) fail(413, 'This batch is larger than 300 KB. Split it into smaller files.');
  const rows = parseCsv(v.csv.replace(/^﻿/, ''));
  if (rows.length < 2) fail(400, 'Add a header row and at least one data row.');
  if (rows[0].length > IMPORT_LIMITS.columns) fail(400, 'Too many columns. The limit is 60.');
  if (rows.length - 1 > IMPORT_LIMITS.rows) fail(400, 'Too many rows. The limit is 100 per batch.');
  const cols = IMPORT_TARGETS[v.target].columns as readonly string[];
  const map = rows[0].map(h => cols.find(k => k.toLowerCase() === h.trim().toLowerCase().replace(/[\s_]/g, '')) ?? null);
  const ctx = await loadContext(c.env.DB, v.target, opts), seen = new Set<string>();
  const out: Row[] = rows.slice(1).map((r, i) => {
    const data: Record<string, string> = {};
    map.forEach((k, j) => { if (k) data[k] = clean(r[j] ?? ''); });
    const [status, message] = checkRow(v.target, data, ctx, seen);
    return { rowId: newId(), n: i + 2, data, status, message };
  });
  const id = newId();
  await c.env.DB.prepare('INSERT INTO import_batches (id, target, options, rows, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, v.target, JSON.stringify(opts), JSON.stringify(out), m.id, nowIso()).run();
  return c.json({ id, target: v.target, rows: out, ignoredColumns: rows[0].filter((_, j) => !map[j]) });
});

imports.get('/', async c => {
  const m = c.get('member');
  const { results } = await c.env.DB.prepare('SELECT id, target, created_at, committed_at, rows FROM import_batches WHERE created_by = ? ORDER BY created_at DESC LIMIT 50').bind(m.id).all<Record<string, string>>();
  return c.json({ batches: results.map(b => { const rows = JSON.parse(b.rows) as Row[]; return { id: b.id, target: b.target, createdAt: b.created_at, committedAt: b.committed_at, rows: rows.length, committed: rows.filter(r => r.status === 'Committed').length }; }) });
});

imports.get('/:id', async c => {
  const b = await c.env.DB.prepare('SELECT * FROM import_batches WHERE id = ? AND created_by = ?').bind(c.req.param('id'), c.get('member').id).first<Record<string, string>>();
  if (!b) fail(404, 'Batch not found. Batches are private to the person who created them.');
  return c.json({ id: b!.id, target: b!.target, rows: JSON.parse(b!.rows), committedAt: b!.committed_at });
});

/** Commit selected Ready rows. Each row is re-checked; committing the same batch twice adds nothing. */
imports.post('/:id/commit', async c => {
  const v = await body(c, z.object({ rowIds: z.array(z.string()).min(1, 'select at least one row') }));
  const db = c.env.DB, m = c.get('member');
  const b = await db.prepare('SELECT * FROM import_batches WHERE id = ? AND created_by = ?').bind(c.req.param('id'), m.id).first<Record<string, string>>();
  if (!b) fail(404, 'Batch not found.');
  if (b!.committed_at) fail(409, 'This batch was already committed, so nothing was added again.');
  const target = b!.target as ImportTarget, opts = JSON.parse(b!.options) as Options;
  requireTargetAccess(m, target, opts);
  if (opts.ownerId && ['divisionContacts'].includes(target)) {
    const o = await db.prepare('SELECT active FROM members WHERE id = ?').bind(opts.ownerId).first<Record<string, number>>();
    if (!o?.active) fail(400, 'The chosen owner is no longer active.');
  }
  const rows = JSON.parse(b!.rows) as Row[], selected = new Set(v.rowIds);
  const ctx = await loadContext(db, target, opts), seen = new Set<string>(), t = nowIso();
  const stmts: D1PreparedStatement[] = [];
  let added = 0;
  for (const r of rows) {
    if (r.status !== 'Ready') continue;
    if (!selected.has(r.rowId)) { r.status = 'Skipped'; continue; }
    const [st, msg, x] = checkRow(target, r.data, ctx, seen);
    if (st !== 'Ready') { r.status = st; r.message = `${msg} (rechecked at commit)`; continue; }
    const d = r.data, id = newId();
    if (target === 'clients') stmts.push(db.prepare('INSERT INTO clients (id, last_name, first_name, dob, email, phone, address, instructions, created_by, created_at, updated_at, import_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, d.lastName, d.firstName || '', d.dob || '', d.email || '', d.phone || '', d.address || '', d.instructions || '', m.id, t, t, b!.id));
    if (target === 'matters') stmts.push(db.prepare('INSERT INTO matters (id, client_id, file_number, case_type, loss_date, lawyer_id, status, opened, closed, notes, created_by, created_at, updated_at, import_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, x.clientId, d.fileNumber, d.caseType, d.lossDate || '', x.lawyerId, x.status, d.opened || '', d.closed || '', d.notes || '', m.id, t, t, b!.id));
    if (target === 'clientExpenses') stmts.push(db.prepare(`INSERT INTO expenses (id, scope, matter_id, date, provider, description, category, reference, currency, amount_cents, hst_cents, pay_status, paid_date, book_status, receipt, notes, state, created_by, created_at, updated_at, import_batch)
      VALUES (?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Not submitted', ?, ?, 'Recorded', ?, ?, ?, ?)`)
      .bind(id, x.matterId, d.date, d.provider, d.description || '', d.category || '', d.reference || '', x.currency, x.amountCents, x.hstCents, x.payStatus, d.paidDate || '', d.receipt || '', d.notes || '', m.id, t, t, b!.id));
    if (target === 'pncs') stmts.push(db.prepare("INSERT INTO pncs (id, name, email, phone, status, urgency, case_type, next_action, follow_up, data, created_by, created_at, updated_at, import_batch) VALUES (?, ?, ?, ?, 'New', 'Normal', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, d.name, d.email || '', d.phone || '', d.caseType || '', d.nextAction || '', d.followUp || '', JSON.stringify({ source: d.source || '', lossDate: d.lossDate || '' }), m.id, t, t, b!.id));
    if (target === 'divisionContacts') stmts.push(db.prepare("INSERT INTO div_contacts (id, division, name, organization, role, email, phone, owner_id, status, notes, created_by, created_at, updated_at, import_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?)")
      .bind(id, opts.division, d.name, d.organization || '', d.role || '', d.email || '', d.phone || '', opts.ownerId || m.id, d.notes || '', m.id, t, t, b!.id));
    r.status = 'Committed'; added++;
  }
  // The committed marker is written in the same transaction as the records; with the check above, retrying a batch can't duplicate them.
  stmts.push(db.prepare('UPDATE import_batches SET rows = ?, committed_at = ? WHERE id = ? AND committed_at IS NULL').bind(JSON.stringify(rows), t, b!.id));
  const res = await db.batch(stmts);
  if (!res[res.length - 1].meta.changes) fail(409, 'This batch was committed by another request.');
  await audit(c, 'Committed import', `${IMPORT_TARGETS[target].label}: ${added} records`, IMPORT_TARGETS[target].division === 'jdco' ? 'firm' : 'general');
  return c.json({ added, rows });
});
