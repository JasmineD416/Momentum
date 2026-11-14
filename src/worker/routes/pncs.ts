import { Hono } from 'hono';
import { z } from 'zod';
import { ATTEMPT_METHODS, ATTEMPT_OUTCOMES, PNC_EDITABLE_STATUSES, URGENCIES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { requireFirm } from '../policy';
import { assertUpdated, audit, body, dateStr, fail, httpsUrl, newId, nowIso, optDate, optEmail, rev, rowsToApi, text, toApi } from '../util';

export const pncs = new Hono<AppEnv>();
pncs.use('*', async (c, next) => { requireFirm(c); await next(); });

const DONE = ['Retained', 'Referred', 'Not retained', 'Closed'];
const parseData = (s: unknown): Record<string, unknown> => { try { return JSON.parse(String(s || '{}')); } catch { return {}; } };
const pncOut = (r: Record<string, unknown>) => ({ ...toApi<Record<string, unknown>>(r), data: parseData(r.data) });

const dataShape = z.object({
  dob: optDate, address: text(500), preferredContact: text(40), source: text(80), referrer: text(200),
  lossDate: optDate, firstContact: optDate, intakeStaffId: z.string().nullable().default(null), summary: text(4000), opposingParty: text(300),
  jurisdiction: text(120), propertyAddress: text(500), lendingCompany: text(200), loanAmountCents: z.number().int().nonnegative().nullable().default(null),
  lenderOrBorrower: z.union([z.enum(['Lender', 'Borrower']), z.literal('')]).default(''), closingDate: optDate, licenceType: text(120),
  limitationDate: optDate, noticeDate: optDate, verifiedBy: text(120), verifiedBasis: text(500),
  nonRetainerSent: optDate, letterLink: httpsUrl, closingReason: text(300),
}).strict();

const pncInput = z.object({
  name: z.string().trim().min(1, 'is required').max(160), email: optEmail, phone: text(80),
  status: z.enum(PNC_EDITABLE_STATUSES), urgency: z.enum(URGENCIES).default('Normal'), caseType: text(80),
  assignedStaffId: z.string().nullable().default(null), nextAction: text(300), followUp: optDate,
  data: dataShape.default({}),
});

function checkPncRules(v: z.infer<typeof pncInput>) {
  if ((v.data.limitationDate || v.data.noticeDate) && (!v.data.verifiedBy || !v.data.verifiedBasis))
    fail(400, 'Legal dates must be manually verified. Add who verified them and the basis.');
  if (v.status === 'Not retained' && !v.data.closingReason) fail(400, 'Add a reason for the non-retainer.');
}

pncs.get('/', async c => {
  const filter = c.req.query('status') || 'Active';
  const { results } = await c.env.DB.prepare(`SELECT p.*, s.name AS assigned_name, (SELECT COUNT(*) FROM attempts a WHERE a.pnc_id = p.id) AS attempt_count
    FROM pncs p LEFT JOIN members s ON s.id = p.assigned_staff_id ORDER BY CASE WHEN p.follow_up = '' THEN 1 ELSE 0 END, p.follow_up, p.name LIMIT 500`).all<Record<string, unknown>>();
  const rows = results.filter(r => filter === 'All' || (filter === 'Active' ? !DONE.includes(String(r.status)) : r.status === filter));
  return c.json({ pncs: rows.map(pncOut) });
});

pncs.get('/:id', async c => {
  const db = c.env.DB, id = c.req.param('id');
  const p = await db.prepare('SELECT p.*, s.name AS assigned_name FROM pncs p LEFT JOIN members s ON s.id = p.assigned_staff_id WHERE p.id = ?').bind(id).first<Record<string, unknown>>();
  if (!p) fail(404, 'PNC not found.');
  const { results } = await db.prepare('SELECT a.*, m.name AS actor_name FROM attempts a LEFT JOIN members m ON m.id = a.actor_id WHERE a.pnc_id = ? ORDER BY a.at DESC').bind(id).all();
  return c.json({ pnc: pncOut(p!), attempts: rowsToApi(results) });
});

pncs.post('/', async c => {
  const v = await body(c, pncInput);
  checkPncRules(v);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO pncs (id, name, email, phone, status, urgency, case_type, assigned_staff_id, next_action, follow_up, data, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.name, v.email, v.phone, v.status, v.urgency, v.caseType, v.assignedStaffId, v.nextAction, v.followUp, JSON.stringify(v.data), c.get('member').id, t, t).run();
  await audit(c, 'Added PNC', v.name, 'firm');
  return c.json({ id }, 201);
});

pncs.patch('/:id', async c => {
  const v = await body(c, pncInput.extend({ rev }));
  checkPncRules(v);
  const db = c.env.DB, id = c.req.param('id');
  const cur = await db.prepare('SELECT status, data FROM pncs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!cur) fail(404, 'PNC not found.');
  // Retained and Referred are set only through their own workflows; referral and retainer fields are kept.
  const status = ['Retained', 'Referred'].includes(String(cur!.status)) ? String(cur!.status) : v.status;
  const data = { ...parseData(cur!.data), ...v.data };
  const r = await db.prepare(`UPDATE pncs SET name = ?, email = ?, phone = ?, status = ?, urgency = ?, case_type = ?, assigned_staff_id = ?, next_action = ?, follow_up = ?, data = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.name, v.email, v.phone, status, v.urgency, v.caseType, v.assignedStaffId, v.nextAction, v.followUp, JSON.stringify(data), nowIso(), id, v.rev).run();
  assertUpdated(r, 'This PNC');
  await audit(c, 'Updated PNC', v.name, 'firm');
  return c.json({ ok: true });
});

pncs.post('/:id/attempts', async c => {
  const v = await body(c, z.object({ at: z.string().datetime({ offset: true, message: 'must be a date and time' }), method: z.enum(ATTEMPT_METHODS), outcome: z.enum(ATTEMPT_OUTCOMES), notes: text(2000) }));
  if (Date.parse(v.at) > Date.now() + 5 * 60_000) fail(400, 'Log attempts after they happen. The time can’t be in the future.');
  const db = c.env.DB, id = c.req.param('id');
  const p = await db.prepare('SELECT name, status FROM pncs WHERE id = ?').bind(id).first<Record<string, string>>();
  if (!p) fail(404, 'PNC not found.');
  await db.batch([
    db.prepare('INSERT INTO attempts (id, pnc_id, at, method, outcome, notes, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(newId(), id, new Date(v.at).toISOString(), v.method, v.outcome, v.notes, c.get('member').id, nowIso()),
    db.prepare("UPDATE pncs SET status = 'Contacting', updated_at = ?, rev = rev + 1 WHERE id = ? AND status = 'New'").bind(nowIso(), id),
  ]);
  await audit(c, 'Logged contact attempt', `PNC: ${p!.name}`, 'firm');
  return c.json({ ok: true }, 201);
});

/* -------- Referral: identified summaries need dated consent tied to the chosen lawyer -------- */
pncs.patch('/:id/referral', async c => {
  const v = await body(c, z.object({
    receivingLawyerId: z.string().nullable().default(null), consentDate: optDate, consentEvidence: text(500),
    referralOutcome: z.union([z.enum(['Pending', 'Accepted', 'Declined']), z.literal('')]).default(''), referralReason: text(500), feeNotes: text(2000),
    markReferred: z.boolean().default(false), rev,
  }));
  const db = c.env.DB, id = c.req.param('id');
  const cur = await db.prepare('SELECT name, status, data FROM pncs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!cur) fail(404, 'PNC not found.');
  if (cur!.status === 'Retained') fail(400, 'This PNC is already a client file.');
  if (v.receivingLawyerId && !(await db.prepare('SELECT 1 FROM counsel WHERE id = ?').bind(v.receivingLawyerId).first())) fail(400, 'Choose a lawyer from the lawyer directory.');
  const data = parseData(cur!.data);
  let { consentDate, consentEvidence } = v;
  const lawyerChanged = (v.receivingLawyerId || '') !== String(data.receivingLawyerId || '');
  let consentCleared = false;
  if (lawyerChanged && data.consentDate && consentDate === data.consentDate) { consentDate = ''; consentEvidence = ''; consentCleared = true; }
  if (v.markReferred && (!consentDate || !v.receivingLawyerId)) fail(400, consentCleared ? 'You changed the lawyer, so enter a fresh consent date for the new lawyer.' : 'An identified referral needs dated consent for the selected lawyer.');
  Object.assign(data, { receivingLawyerId: v.receivingLawyerId, consentDate, consentEvidence, consentLawyerId: consentDate ? v.receivingLawyerId : null, referralOutcome: v.referralOutcome, referralReason: v.referralReason, feeNotes: v.feeNotes });
  const status = v.markReferred ? 'Referred' : (cur!.status === 'Referred' ? 'Consult booked' : String(cur!.status));
  const r = await db.prepare('UPDATE pncs SET data = ?, status = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?').bind(JSON.stringify(data), status, nowIso(), id, v.rev).run();
  assertUpdated(r, 'This PNC');
  await audit(c, 'Updated referral', `PNC: ${cur!.name}`, 'firm');
  return c.json({ ok: true, consentCleared });
});

pncs.get('/:id/referral-summary', async c => {
  const db = c.env.DB;
  const p = await db.prepare('SELECT * FROM pncs WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!p) fail(404, 'PNC not found.');
  const d = parseData(p!.data);
  if (!d.receivingLawyerId || !d.consentDate || d.consentLawyerId !== d.receivingLawyerId) fail(400, 'An identified referral summary needs dated consent tied to the selected receiving lawyer.');
  const l = await db.prepare('SELECT name, firm FROM counsel WHERE id = ?').bind(d.receivingLawyerId).first<Record<string, string>>();
  const lines = [
    `Referral summary for ${l?.name ?? ''}${l?.firm ? ', ' + l.firm : ''}`, '',
    `Name: ${p!.name}`, `Phone: ${p!.phone || '—'}`, `Email: ${p!.email || '—'}`, `Case type: ${p!.case_type || '—'}`,
    `Date of loss: ${d.lossDate || '—'}`, `Jurisdiction: ${d.jurisdiction || '—'}`, `Urgency: ${p!.urgency}`, '', String(d.summary || ''), '',
    `Consent to share with ${l?.name ?? ''} given ${d.consentDate}${d.consentEvidence ? ' (' + d.consentEvidence + ')' : ''}.`,
  ];
  await audit(c, 'Prepared referral summary', `PNC: ${p!.name}`, 'firm');
  return c.json({ text: lines.join('\n') });
});

/* -------- Open a client file from a PNC -------- */
pncs.post('/:id/convert', async c => {
  const v = await body(c, z.object({
    retainerSigned: z.literal(true, { errorMap: () => ({ message: 'confirm the retainer is signed' }) }),
    retainerDate: dateStr, lawyerId: z.string().min(1, 'is required'), fileNumber: z.string().trim().min(1, 'is required').max(40),
    caseType: z.string().trim().min(1, 'is required').max(80), linkClientId: z.string().nullable().default(null), createNewClient: z.boolean().default(false),
    conflictReviewed: z.boolean().default(false), rev,
  }));
  const db = c.env.DB, id = c.req.param('id'), me = c.get('member');
  const p = await db.prepare('SELECT * FROM pncs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!p) fail(404, 'PNC not found.');
  if (p!.converted_matter_id) fail(409, 'This PNC has already been converted.');
  if (Number(p!.rev) !== v.rev) fail(409, 'This PNC was changed by someone else since you opened it. Refresh and try again.');
  const d = parseData(p!.data);
  if ((['Not retained', 'Closed'].includes(String(p!.status)) || d.nonRetainerSent) && !v.conflictReviewed) fail(400, 'Review the non-retainer or closed-intake status first, and confirm you have.');
  if (!(await db.prepare('SELECT 1 FROM counsel WHERE id = ?').bind(v.lawyerId).first())) fail(400, 'Choose a lawyer from the lawyer directory.');
  if (await db.prepare('SELECT 1 FROM matters WHERE file_number = ?').bind(v.fileNumber).first()) fail(409, `File number ${v.fileNumber} is already in use.`);
  const [last, ...firstParts] = String(p!.name).includes(',') ? String(p!.name).split(',').map(s => s.trim()) : [String(p!.name).split(' ').slice(-1)[0], String(p!.name).split(' ').slice(0, -1).join(' ')];
  const first = firstParts.join(' ').trim();
  const { results: candidates } = await db.prepare(`SELECT id, last_name, first_name, dob, email FROM clients WHERE (? <> '' AND email = ? COLLATE NOCASE) OR (last_name = ? COLLATE NOCASE AND first_name = ? COLLATE NOCASE)`)
    .bind(p!.email, p!.email, last, first).all();
  let clientId = v.linkClientId;
  if (clientId) { if (!candidates.some(x => x.id === clientId) && !(await db.prepare('SELECT 1 FROM clients WHERE id = ?').bind(clientId).first())) fail(400, 'Choose an existing client.'); }
  else if (candidates.length && !v.createNewClient) return c.json({ error: 'Possible existing client. Choose one to link, or confirm a new client.', candidates: rowsToApi(candidates) }, 409);
  const t = nowIso(), stmts: D1PreparedStatement[] = [];
  if (!clientId) {
    clientId = newId();
    stmts.push(db.prepare('INSERT INTO clients (id, last_name, first_name, dob, email, phone, address, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(clientId, last, first, String(d.dob || ''), p!.email, p!.phone, String(d.address || ''), me.id, t, t));
  }
  const matterId = newId();
  stmts.push(db.prepare(`INSERT INTO matters (id, client_id, file_number, case_type, loss_date, lawyer_id, staff_id, status, opened, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)`)
    .bind(matterId, clientId, v.fileNumber, v.caseType, String(d.lossDate || ''), v.lawyerId, p!.assigned_staff_id, t.slice(0, 10), `Opened from PNC ${p!.name}`, me.id, t, t));
  Object.assign(d, { retainerDate: v.retainerDate, responsibleLawyerId: v.lawyerId });
  stmts.push(db.prepare("UPDATE pncs SET status = 'Retained', data = ?, converted_client_id = ?, converted_matter_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?")
    .bind(JSON.stringify(d), clientId, matterId, t, id, v.rev));
  const res = await db.batch(stmts);
  assertUpdated(res[res.length - 1], 'This PNC');
  await audit(c, 'Converted PNC to file', `${p!.name} → ${v.fileNumber}`, 'firm');
  return c.json({ clientId, matterId }, 201);
});
