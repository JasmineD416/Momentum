import { Hono } from 'hono';
import { z } from 'zod';
import { CHECKLIST_ITEMS, CHECKLIST_STATUSES, MATTER_STATUSES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { requireFirm } from '../policy';
import { assertUpdated, audit, body, fail, httpsUrl, newId, nowIso, optDate, optEmail, rev, rowsToApi, text, toApi } from '../util';

export const firm = new Hono<AppEnv>();
// Every route in this module is JD&Co Law Firm only. The guard is scoped to these paths so it never
// touches other modules mounted under /api.
for (const path of ['/clients', '/clients/*', '/matters', '/matters/*', '/counsel', '/counsel/*', '/checklist/*'])
  firm.use(path, async (c, next) => { requireFirm(c); await next(); });

/* ---------------- Clients ---------------- */
const clientInput = z.object({
  lastName: z.string().trim().min(1, 'is required').max(120),
  firstName: text(120),
  dob: optDate,
  email: optEmail,
  phone: text(120),
  address: text(500),
  instructions: text(2000),
  confirmDuplicate: z.boolean().optional(),
});

firm.get('/clients', async c => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const { results } = await c.env.DB.prepare(`
    SELECT c.*, (SELECT json_group_array(json_object('id', m.id, 'fileNumber', m.file_number, 'status', m.status)) FROM matters m WHERE m.client_id = c.id) AS files
    FROM clients c ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE LIMIT 500`).all<Record<string, unknown>>();
  let clients = results.map(r => Object.assign(toApi<Record<string, unknown>>(r), { files: JSON.parse(String(r.files || '[]')) as { fileNumber: string }[] }));
  if (q) clients = clients.filter(x => JSON.stringify([x.lastName, x.firstName, x.email, x.phone, x.dob, x.address, x.files.map(f => f.fileNumber)]).toLowerCase().includes(q));
  return c.json({ clients });
});

firm.get('/clients/:id', async c => {
  const db = c.env.DB, id = c.req.param('id');
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) fail(404, 'Client not found.');
  const { results: matters } = await db.prepare(`
    SELECT m.*, l.name AS lawyer_name, s.name AS staff_name,
      (SELECT COUNT(*) FROM checklist k WHERE k.matter_id = m.id) AS checklist_total,
      (SELECT COUNT(*) FROM checklist k WHERE k.matter_id = m.id AND k.status IN ('Complete', 'Not applicable')) AS checklist_done
    FROM matters m LEFT JOIN counsel l ON l.id = m.lawyer_id LEFT JOIN members s ON s.id = m.staff_id
    WHERE m.client_id = ? ORDER BY m.status = 'Open' DESC, m.file_number`).bind(id).all();
  const { results: totals } = await db.prepare(`
    SELECT e.currency, SUM(e.amount_cents + e.hst_cents) AS total FROM expenses e JOIN matters m ON m.id = e.matter_id
    WHERE m.client_id = ? AND e.scope = 'client' AND e.state = 'Recorded' GROUP BY e.currency`).bind(id).all();
  return c.json({ client: toApi(client), matters: rowsToApi(matters), expenseTotals: rowsToApi(totals) });
});

async function duplicateClient(db: D1Database, v: z.infer<typeof clientInput>, excludeId = '') {
  return db.prepare(`SELECT id, last_name, first_name FROM clients WHERE id <> ? AND ((? <> '' AND email = ? COLLATE NOCASE) OR (? <> '' AND dob = ? AND last_name = ? COLLATE NOCASE AND first_name = ? COLLATE NOCASE)) LIMIT 1`)
    .bind(excludeId, v.email, v.email, v.dob, v.dob, v.lastName, v.firstName).first<Record<string, string>>();
}

firm.post('/clients', async c => {
  const v = await body(c, clientInput);
  const dup = await duplicateClient(c.env.DB, v);
  if (dup && !v.confirmDuplicate) fail(409, `Possible duplicate of ${dup.last_name}, ${dup.first_name} (same email, or same name and date of birth). Open that client instead, or confirm to add anyway.`);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare('INSERT INTO clients (id, last_name, first_name, dob, email, phone, address, instructions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.lastName, v.firstName, v.dob, v.email, v.phone, v.address, v.instructions, c.get('member').id, t, t).run();
  await audit(c, 'Added client', `${v.lastName}, ${v.firstName}`, 'firm');
  return c.json({ id }, 201);
});

firm.patch('/clients/:id', async c => {
  const v = await body(c, clientInput.extend({ rev }));
  const id = c.req.param('id');
  const dup = await duplicateClient(c.env.DB, v, id);
  if (dup && !v.confirmDuplicate) fail(409, `Possible duplicate of ${dup.last_name}, ${dup.first_name}. Confirm to save anyway.`);
  const r = await c.env.DB.prepare('UPDATE clients SET last_name = ?, first_name = ?, dob = ?, email = ?, phone = ?, address = ?, instructions = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.lastName, v.firstName, v.dob, v.email, v.phone, v.address, v.instructions, nowIso(), id, v.rev).run();
  assertUpdated(r, 'This client');
  await audit(c, 'Updated client', `${v.lastName}, ${v.firstName}`, 'firm');
  return c.json({ ok: true });
});

/* ---------------- Matters ---------------- */
const matterInput = z.object({
  clientId: z.string().min(1, 'is required'),
  fileNumber: z.string().trim().min(1, 'is required').max(40),
  caseType: z.string().trim().min(1, 'is required').max(80),
  lossDate: optDate,
  lawyerId: z.string().nullable().default(null),
  staffId: z.string().nullable().default(null),
  status: z.enum(MATTER_STATUSES),
  opened: optDate,
  closed: optDate,
  closingReason: text(300),
  boxLink: httpsUrl,
  notes: text(4000),
});

function checkMatterRules(v: z.infer<typeof matterInput>) {
  if (v.status === 'Closed' && !v.closed) fail(400, 'Closing a file needs a closed date.');
  if (v.status !== 'Closed' && v.closed) fail(400, 'Clear the closed date to reopen this file.');
  if (v.closed && v.opened && v.closed < v.opened) fail(400, 'The closed date can’t be before the opened date.');
}
async function checkMatterLinks(db: D1Database, v: z.infer<typeof matterInput>) {
  if (!(await db.prepare('SELECT 1 FROM clients WHERE id = ?').bind(v.clientId).first())) fail(400, 'Choose an existing client.');
  if (v.lawyerId && !(await db.prepare('SELECT 1 FROM counsel WHERE id = ?').bind(v.lawyerId).first())) fail(400, 'Choose a lawyer from the lawyer directory.');
  if (v.staffId) {
    const s = await db.prepare('SELECT role, divisions, active FROM members WHERE id = ?').bind(v.staffId).first<Record<string, unknown>>();
    if (!s || !s.active || (s.role !== 'Owner' && !JSON.parse(String(s.divisions)).includes('jdco'))) fail(400, 'Assigned staff must be active and have JD&Co Law Firm access.');
  }
}
async function fileNumberTaken(db: D1Database, fileNumber: string, excludeId = '') {
  return !!(await db.prepare('SELECT 1 FROM matters WHERE file_number = ? AND id <> ?').bind(fileNumber, excludeId).first());
}

firm.get('/matters', async c => {
  const { results } = await c.env.DB.prepare(`SELECT m.id, m.file_number, m.status, m.case_type, c.last_name, c.first_name, c.id AS client_id
    FROM matters m JOIN clients c ON c.id = m.client_id ORDER BY m.file_number`).all();
  return c.json({ matters: rowsToApi(results) });
});

firm.get('/matters/:id', async c => {
  const m = await c.env.DB.prepare(`SELECT m.*, c.last_name, c.first_name FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = ?`).bind(c.req.param('id')).first();
  if (!m) fail(404, 'Matter not found.');
  return c.json({ matter: toApi(m) });
});

firm.post('/matters', async c => {
  const v = await body(c, matterInput);
  checkMatterRules(v);
  await checkMatterLinks(c.env.DB, v);
  if (await fileNumberTaken(c.env.DB, v.fileNumber)) fail(409, `File number ${v.fileNumber} is already in use.`);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO matters (id, client_id, file_number, case_type, loss_date, lawyer_id, staff_id, status, opened, closed, closing_reason, box_link, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.clientId, v.fileNumber, v.caseType, v.lossDate, v.lawyerId, v.staffId, v.status, v.opened, v.closed, v.closingReason, v.boxLink, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Opened matter', v.fileNumber, 'firm');
  return c.json({ id }, 201);
});

firm.patch('/matters/:id', async c => {
  const v = await body(c, matterInput.extend({ rev }));
  const id = c.req.param('id');
  checkMatterRules(v);
  await checkMatterLinks(c.env.DB, v);
  if (await fileNumberTaken(c.env.DB, v.fileNumber, id)) fail(409, `File number ${v.fileNumber} is already in use.`);
  const r = await c.env.DB.prepare(`UPDATE matters SET client_id = ?, file_number = ?, case_type = ?, loss_date = ?, lawyer_id = ?, staff_id = ?, status = ?, opened = ?, closed = ?,
    closing_reason = ?, box_link = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.clientId, v.fileNumber, v.caseType, v.lossDate, v.lawyerId, v.staffId, v.status, v.opened, v.closed, v.closingReason, v.boxLink, v.notes, nowIso(), id, v.rev).run();
  assertUpdated(r, 'This matter');
  await audit(c, 'Updated matter', v.fileNumber, 'firm');
  return c.json({ ok: true });
});

/* ---------------- Lawyer directory ---------------- */
const counselInput = z.object({
  name: z.string().trim().min(1, 'is required').max(120), firm: text(160), email: optEmail, phone: text(80),
  practice: text(300), jurisdictions: text(300), notes: text(2000),
});
firm.get('/counsel', async c => {
  const { results } = await c.env.DB.prepare(`SELECT l.*, (SELECT COUNT(*) FROM matters m WHERE m.lawyer_id = l.id AND m.status = 'Open') AS open_files FROM counsel l ORDER BY l.name`).all();
  return c.json({ counsel: rowsToApi(results) });
});
firm.post('/counsel', async c => {
  const v = await body(c, counselInput);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare('INSERT INTO counsel (id, name, firm, email, phone, practice, jurisdictions, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.name, v.firm, v.email, v.phone, v.practice, v.jurisdictions, v.notes, t, t).run();
  await audit(c, 'Added lawyer', v.name, 'firm');
  return c.json({ id }, 201);
});
firm.patch('/counsel/:id', async c => {
  const v = await body(c, counselInput.extend({ rev }));
  const r = await c.env.DB.prepare('UPDATE counsel SET name = ?, firm = ?, email = ?, phone = ?, practice = ?, jurisdictions = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.name, v.firm, v.email, v.phone, v.practice, v.jurisdictions, v.notes, nowIso(), c.req.param('id'), v.rev).run();
  assertUpdated(r, 'This lawyer');
  await audit(c, 'Updated lawyer', v.name, 'firm');
  return c.json({ ok: true });
});

/* ---------------- Opening checklist ---------------- */
firm.get('/matters/:id/checklist', async c => {
  const id = c.req.param('id');
  const matter = await c.env.DB.prepare('SELECT m.id, m.file_number, m.case_type, c.id AS client_id, c.last_name, c.first_name FROM matters m JOIN clients c ON c.id = m.client_id WHERE m.id = ?').bind(id).first();
  if (!matter) fail(404, 'Matter not found.');
  const { results } = await c.env.DB.prepare(`SELECT k.*, a.name AS assignee_name, cb.name AS completed_by_name, ub.name AS updated_by_name FROM checklist k
    LEFT JOIN members a ON a.id = k.assignee_id LEFT JOIN members cb ON cb.id = k.completed_by LEFT JOIN members ub ON ub.id = k.updated_by WHERE k.matter_id = ?`).bind(id).all<Record<string, unknown>>();
  const order = CHECKLIST_ITEMS.map(x => x[0] as string);
  results.sort((a, b) => order.indexOf(String(a.item)) - order.indexOf(String(b.item)));
  return c.json({ matter: toApi(matter), items: rowsToApi(results) });
});

/** Starting again keeps existing progress: only missing items are added. */
firm.post('/matters/:id/checklist/start', async c => {
  const id = c.req.param('id');
  if (!(await c.env.DB.prepare('SELECT 1 FROM matters WHERE id = ?').bind(id).first())) fail(404, 'Matter not found.');
  const t = nowIso(), me = c.get('member').id;
  const stmts = CHECKLIST_ITEMS.map(([item]) => c.env.DB.prepare("INSERT OR IGNORE INTO checklist (id, matter_id, item, status, updated_by, updated_at) VALUES (?, ?, ?, 'Not started', ?, ?)").bind(newId(), id, item, me, t));
  const res = await c.env.DB.batch(stmts);
  const added = res.reduce((n, r) => n + (r.meta.changes || 0), 0);
  await audit(c, 'Started opening checklist', id, 'firm');
  return c.json({ added });
});

firm.patch('/checklist/:id', async c => {
  const v = await body(c, z.object({ status: z.enum(CHECKLIST_STATUSES), assigneeId: z.string().nullable().default(null), notes: text(4000), evidence: httpsUrl, rev }));
  const db = c.env.DB, me = c.get('member');
  const cur = await db.prepare('SELECT * FROM checklist WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!cur) fail(404, 'Checklist item not found.');
  const resolved = (s: unknown) => s === 'Complete' || s === 'Not applicable';
  if (resolved(v.status) && !v.notes) fail(400, 'Add a note explaining the review or the reason.');
  if (v.assigneeId) {
    const a = await db.prepare('SELECT role, divisions, active FROM members WHERE id = ?').bind(v.assigneeId).first<Record<string, unknown>>();
    if (!a || !a.active || (a.role !== 'Owner' && !JSON.parse(String(a.divisions)).includes('jdco'))) fail(400, 'Assignees must be active staff with JD&Co Law Firm access.');
  }
  // Completion attribution: set when first resolved, kept while it stays resolved, cleared when reopened.
  let completedBy = cur!.completed_by as string | null, completedAt = cur!.completed_at as string | null;
  if (resolved(v.status) && !resolved(cur!.status)) { completedBy = me.id; completedAt = nowIso(); }
  if (!resolved(v.status)) { completedBy = null; completedAt = null; }
  const r = await db.prepare('UPDATE checklist SET status = ?, assignee_id = ?, notes = ?, evidence = ?, completed_by = ?, completed_at = ?, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.status, v.assigneeId, v.notes, v.evidence, completedBy, completedAt, me.id, nowIso(), cur!.id, v.rev).run();
  assertUpdated(r, 'This checklist item');
  await audit(c, `Updated checklist: ${cur!.item}`, String(cur!.matter_id), 'firm');
  return c.json({ ok: true });
});
