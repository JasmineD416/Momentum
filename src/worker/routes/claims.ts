import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CARD_TYPES, CLAIM_PAY_METHODS, CLAIM_STATUSES, CURRENCIES, DIVISION_IDS } from '../../shared/constants';
import type { AppEnv, Member } from '../env';
import { hasDivision, isAdmin, isOwner } from '../policy';
import { assertUpdated, audit, body, dateStr, fail, newId, nowIso, rev, rowsToApi, text } from '../util';

/**
 * Team › Expense claims. Anyone records a charge they paid for the business (date, amount, company, how it was paid,
 * description, notes) and uploads the invoice. The submitter sees their own claims; administrators see and review claims
 * for divisions they have access to (the Owner sees all). Administrators other than the Owner can't review their own.
 */
export const claims = new Hono<AppEnv>();

export const MAX_INVOICE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5;

const input = z.object({
  division: z.string().default('').refine(d => d === '' || (DIVISION_IDS as readonly string[]).includes(d), 'must be a division'),
  chargeDate: dateStr,
  amountCents: z.number().int().positive('must be more than zero').max(100_000_000),
  currency: z.enum(CURRENCIES).default('CAD'),
  company: z.string().trim().min(1, 'is required').max(200),
  payMethod: z.enum(CLAIM_PAY_METHODS),
  cardType: z.union([z.enum(CARD_TYPES), z.literal('')]).default(''),
  cardLast4: z.string().trim().default(''),
  description: z.string().trim().min(1, 'is required').max(1000),
  notes: text(4000),
});
type Input = z.infer<typeof input>;

function check(m: Member, v: Input) {
  if (v.division && !hasDivision(m, v.division)) fail(403, 'You can only file a claim under a division you have access to.');
  if (v.payMethod === 'Credit card') {
    if (!v.cardType) fail(400, 'Choose the card type.');
    if (!/^\d{4}$/.test(v.cardLast4)) fail(400, 'Enter the last four digits of the card (never the full number).');
  } else {
    v.cardType = ''; v.cardLast4 = '';
  }
  if (v.chargeDate > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) fail(400, 'The charge date can’t be in the future.');
}

const auditScope = (division: string) => (division === 'jdco' ? 'firm' : division === 'properties' ? 'properties' : 'general') as 'firm' | 'properties' | 'general';
const canSee = (m: Member, row: Record<string, unknown>) => row.member_id === m.id || (isAdmin(m) && (!row.division || hasDivision(m, String(row.division))));
const canReview = (m: Member, row: Record<string, unknown>) => isAdmin(m) && canSee(m, row) && (row.member_id !== m.id || isOwner(m));

async function load(c: Context<AppEnv>, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM team_expenses WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row || !canSee(c.get('member'), row)) fail(404, 'Expense claim not found.');
  return row!;
}
/** The submitter changes a claim only while it waits for review. */
function ownOpen(c: Context<AppEnv>, row: Record<string, unknown>) {
  if (row.member_id !== c.get('member').id) fail(403, 'Only the person who submitted this claim can change it.');
  if (row.status !== 'Submitted') fail(400, 'This claim has been reviewed, so it can’t be changed.');
}

claims.get('/', async c => {
  const m = c.get('member'), db = c.env.DB;
  const [{ results }, { results: files }] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT e.*, s.name AS member_name, r.name AS reviewed_by_name FROM team_expenses e JOIN members s ON s.id = e.member_id LEFT JOIN members r ON r.id = e.reviewed_by
      ORDER BY e.status <> 'Submitted', e.charge_date DESC, e.created_at DESC LIMIT 5000`),
    db.prepare('SELECT id, expense_id, file_name, content_type, size, uploaded_at FROM team_expense_files ORDER BY uploaded_at'),
  ]);
  const seen = results.filter(r => canSee(m, r));
  const byClaim = new Map<string, Record<string, unknown>[]>();
  for (const f of rowsToApi<Record<string, unknown>>(files)) byClaim.set(String(f.expenseId), [...(byClaim.get(String(f.expenseId)) ?? []), f]);
  const out = rowsToApi<Record<string, unknown>>(seen).map((e, i) => ({ ...e, files: byClaim.get(String(e.id)) ?? [], canReview: canReview(m, seen[i]) }));
  return c.json({ claims: out });
});

claims.post('/', async c => {
  const m = c.get('member');
  const v = await body(c, input);
  check(m, v);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO team_expenses (id, member_id, division, charge_date, amount_cents, currency, company, pay_method, card_type, card_last4, description, notes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?)`)
    .bind(id, m.id, v.division, v.chargeDate, v.amountCents, v.currency, v.company, v.payMethod, v.cardType, v.cardLast4, v.description, v.notes, t, t).run();
  await audit(c, 'Submitted expense claim', `${v.company} ${(v.amountCents / 100).toFixed(2)} ${v.currency}`, auditScope(v.division));
  return c.json({ id }, 201);
});

claims.patch('/:id', async c => {
  const m = c.get('member');
  const v = await body(c, input.extend({ rev }));
  const row = await load(c, c.req.param('id'));
  ownOpen(c, row);
  check(m, v);
  const r = await c.env.DB.prepare(`UPDATE team_expenses SET division = ?, charge_date = ?, amount_cents = ?, currency = ?, company = ?, pay_method = ?, card_type = ?, card_last4 = ?,
    description = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ? AND status = 'Submitted'`)
    .bind(v.division, v.chargeDate, v.amountCents, v.currency, v.company, v.payMethod, v.cardType, v.cardLast4, v.description, v.notes, nowIso(), row.id, v.rev).run();
  assertUpdated(r, 'This claim');
  await audit(c, 'Updated expense claim', v.company, auditScope(v.division));
  return c.json({ ok: true });
});

/** The submitter withdraws a claim that hasn't been reviewed (its invoices go with it). */
claims.post('/:id/withdraw', async c => {
  const v = await body(c, z.object({ rev }));
  const row = await load(c, c.req.param('id'));
  ownOpen(c, row);
  const r = await c.env.DB.prepare("DELETE FROM team_expenses WHERE id = ? AND rev = ? AND status = 'Submitted'").bind(row.id, v.rev).run();
  assertUpdated(r, 'This claim');
  await audit(c, 'Withdrew expense claim', String(row.company), auditScope(String(row.division)));
  return c.json({ ok: true });
});

claims.post('/:id/review', async c => {
  const m = c.get('member');
  const v = await body(c, z.object({ status: z.enum(CLAIM_STATUSES), note: text(1000), rev }));
  const row = await load(c, c.req.param('id'));
  if (!canReview(m, row)) fail(403, isAdmin(m) ? 'Someone else needs to review your own claim.' : 'Only an administrator can review expense claims.');
  if (v.status === 'Declined' && !v.note) fail(400, 'Say why the claim is declined.');
  const back = v.status === 'Submitted';
  const r = await c.env.DB.prepare('UPDATE team_expenses SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.status, v.note, back ? null : m.id, back ? null : nowIso(), nowIso(), row.id, v.rev).run();
  assertUpdated(r, 'This claim');
  await audit(c, `Expense claim ${v.status.toLowerCase()}`, String(row.company), auditScope(String(row.division)));
  return c.json({ ok: true });
});

/* ---------------- Invoices ---------------- */
const KINDS: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { type: 'application/pdf', ext: 'pdf', test: b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { type: 'image/png', ext: 'png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', ext: 'webp', test: b => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP' },
  { type: 'image/heic', ext: 'heic', test: b => String.fromCharCode(...b.slice(4, 8)) === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)$/.test(String.fromCharCode(...b.slice(8, 12))) },
];

/** Upload one invoice as the raw request body (see sameOriginJson); the file name comes in x-file-name. */
claims.post('/:id/invoices', async c => {
  const row = await load(c, c.req.param('id'));
  ownOpen(c, row);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) fail(400, 'The file is empty.');
  if (bytes.length > MAX_INVOICE_BYTES) fail(413, 'Invoices can be up to 8 MB.');
  const kind = KINDS.find(k => k.test(bytes));
  if (!kind) fail(415, 'Upload the invoice as a PDF or a photo (JPG, PNG, WebP or HEIC).');
  const db = c.env.DB;
  const n = await db.prepare('SELECT count(*) AS n FROM team_expense_files WHERE expense_id = ?').bind(row.id).first<number>('n');
  if (Number(n) >= MAX_FILES) fail(400, `A claim can have up to ${MAX_FILES} files.`);
  let name = '';
  try { name = decodeURIComponent(c.req.header('x-file-name') || ''); } catch { /* use the default below */ }
  name = name.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || `invoice.${kind!.ext}`;
  const id = newId();
  await db.prepare('INSERT INTO team_expense_files (id, expense_id, file_name, content_type, size, data, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, row.id, name, kind!.type, bytes.length, bytes, c.get('member').id, nowIso()).run();
  await audit(c, 'Uploaded invoice', `${row.company}: ${name}`, auditScope(String(row.division)));
  return c.json({ id }, 201);
});

claims.get('/:id/invoices/:fid', async c => {
  const row = await load(c, c.req.param('id'));
  const f = await c.env.DB.prepare('SELECT file_name, content_type, data FROM team_expense_files WHERE id = ? AND expense_id = ?').bind(c.req.param('fid'), row.id)
    .first<{ file_name: string; content_type: string; data: Uint8Array }>();
  if (!f) fail(404, 'File not found.');
  // PDFs and common images open in the browser; anything else downloads. The type was checked from the file's contents on upload.
  const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(f!.content_type);
  return new Response(f!.data, {
    headers: {
      'content-type': f!.content_type,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="invoice"; filename*=UTF-8''${encodeURIComponent(f!.file_name)}`,
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'",
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    },
  });
});

claims.post('/:id/invoices/:fid/remove', async c => {
  const row = await load(c, c.req.param('id'));
  ownOpen(c, row);
  const r = await c.env.DB.prepare('DELETE FROM team_expense_files WHERE id = ? AND expense_id = ?').bind(c.req.param('fid'), row.id).run();
  if (!r.meta.changes) fail(404, 'File not found.');
  await audit(c, 'Removed invoice', String(row.company), auditScope(String(row.division)));
  return c.json({ ok: true });
});
