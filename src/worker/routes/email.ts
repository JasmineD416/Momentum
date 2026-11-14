import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { CONSENT_BASES, EMAIL_BRAND_IDS, EMAIL_BRANDS, IMPORT_CHUNK, checkMailing, impliedUntil, isEmailAddress, type ConsentBasis, type MailContent } from '../../shared/email';
import { nyDate } from '../../shared/time';
import { checkIdentity, providerReady, sendRaw, unsubscribeUrl } from '../email/mail';
import { renderEmail } from '../../shared/email';
import { AUDIENCE_FROM, AUDIENCE_WHERE, runScheduler, senderFromRow } from '../email/scheduler';
import { unsubscribe } from '../email/public';
import type { AppEnv, Member } from '../env';
import { hasDivision, requireAdmin, requireDivision } from '../policy';
import { assertUpdated, audit, body, dateStr, fail, httpsUrl, newId, nowIso, rev, rowsToApi, text, toApi } from '../util';

/**
 * Email lists and mass mailings. Every entity keeps its own list: using it needs the Marketing division plus that
 * entity's division. Importing, sender settings and sending are for administrators; staff can add people one at a
 * time, write drafts and send tests to themselves.
 */
export const email = new Hono<AppEnv>();
email.use('*', async (c, next) => { requireDivision(c, 'marketing'); await next(); });

const brandSchema = z.enum(EMAIL_BRAND_IDS);
const canUseBrand = (m: Member, brand: string) => hasDivision(m, 'marketing') && hasDivision(m, brand);
function requireBrand(c: Context<AppEnv>, brand: string) {
  if (!EMAIL_BRAND_IDS.includes(brand as never)) fail(404, 'No such list.');
  if (!canUseBrand(c.get('member'), brand)) fail(403, 'You don’t have access to this entity’s email list.');
  return brand;
}
const basisSchema = z.enum(CONSENT_BASES.map(b => b.id) as [ConsentBasis, ...ConsentBasis[]]);
const today = () => nyDate();

/* ---------------- Overview and senders ---------------- */
email.get('/overview', async c => {
  const m = c.get('member'), db = c.env.DB, d = today();
  const brands = EMAIL_BRANDS.filter(b => canUseBrand(m, b.id));
  const [counts, senders, sent] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT brand, SUM(status = 'Subscribed') AS subscribed, SUM(status = 'Unsubscribed') AS unsubscribed,
        SUM(status = 'Subscribed' AND consent_type = 'Implied' AND implied_until < ?1) AS expired,
        SUM(status = 'Subscribed' AND consent_type = 'Implied' AND implied_until >= ?1 AND implied_until < date(?1, '+30 days')) AS expiring
      FROM subscriptions GROUP BY brand`).bind(d),
    db.prepare('SELECT * FROM email_senders'),
    db.prepare('SELECT brand, n FROM send_counts WHERE day = ?').bind(d),
  ]);
  const suppressed = await db.prepare('SELECT COUNT(*) AS n FROM suppressions').first<{ n: number }>();
  return c.json({
    providerReady: providerReady(c.env), suppressed: suppressed?.n ?? 0,
    brands: brands.map(b => {
      const k = counts.results.find(r => r.brand === b.id), s = senders.results.find(r => r.brand === b.id);
      return {
        id: b.id, name: b.name, sender: s ? senderFromRow(s) : null, dailyLimit: Number(s?.daily_limit ?? 500), sentToday: Number(sent.results.find(r => r.brand === b.id)?.n ?? 0),
        subscribed: Number(k?.subscribed ?? 0), unsubscribed: Number(k?.unsubscribed ?? 0), expired: Number(k?.expired ?? 0), expiring: Number(k?.expiring ?? 0),
      };
    }),
  });
});

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail)\./i;
const senderInput = z.object({
  fromName: z.string().trim().min(1, 'is required').max(100), fromEmail: z.string().trim().toLowerCase().email('must be an email address'),
  replyTo: z.union([z.string().trim().email('must be an email address'), z.literal('')]).default(''),
  postalAddress: z.string().trim().min(10, 'must be a full postal address').max(400), dailyLimit: z.number().int().min(1).max(100000),
  logoUrl: httpsUrl, accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #C14B8A').default('#C14B8A'), footerNote: text(500), rev: rev.optional(),
});

email.put('/senders/:brand', async c => {
  requireAdmin(c);
  const brand = requireBrand(c, c.req.param('brand'));
  const v = await body(c, senderInput);
  if (FREE_MAIL.test(v.fromEmail)) fail(400, 'Send from your own domain (for example news@lawgirl.ca), not a free mailbox. Gmail and Yahoo reject bulk mail that claims to come from their domains.');
  const db = c.env.DB, t = nowIso(), me = c.get('member').id;
  const cur = await db.prepare('SELECT rev FROM email_senders WHERE brand = ?').bind(brand).first<{ rev: number }>();
  if (!cur) {
    await db.prepare('INSERT INTO email_senders (brand, from_name, from_email, reply_to, postal_address, daily_limit, logo_url, accent, footer_note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(brand, v.fromName, v.fromEmail, v.replyTo, v.postalAddress, v.dailyLimit, v.logoUrl, v.accent, v.footerNote, me, t).run();
  } else {
    if (!v.rev) fail(409, 'Refresh and try again; these settings already exist.');
    const r = await db.prepare('UPDATE email_senders SET from_name = ?, from_email = ?, reply_to = ?, postal_address = ?, daily_limit = ?, logo_url = ?, accent = ?, footer_note = ?, updated_by = ?, updated_at = ?, rev = rev + 1 WHERE brand = ? AND rev = ?')
      .bind(v.fromName, v.fromEmail, v.replyTo, v.postalAddress, v.dailyLimit, v.logoUrl, v.accent, v.footerNote, me, t, brand, v.rev).run();
    assertUpdated(r, 'These sender settings');
  }
  await audit(c, 'Updated email sender', `${brand}: ${v.fromEmail}`);
  return c.json({ ok: true });
});

email.post('/senders/:brand/check', async c => {
  requireAdmin(c);
  const brand = requireBrand(c, c.req.param('brand'));
  const s = await c.env.DB.prepare('SELECT from_email FROM email_senders WHERE brand = ?').bind(brand).first<{ from_email: string }>();
  if (!s) fail(400, 'Save the sender settings first.');
  const domain = s!.from_email.split('@')[1];
  return c.json({ domain, ...(await checkIdentity(c.env, domain)) });
});

/* ---------------- Subscribers ---------------- */
email.get('/lists/:brand/subscribers', async c => {
  const brand = requireBrand(c, c.req.param('brand'));
  const q = (c.req.query('q') || '').trim(), status = c.req.query('status') || '', page = Math.max(0, Number(c.req.query('page')) || 0), d = today();
  const where = ['sub.brand = ?'], args: unknown[] = [brand];
  if (q) { where.push("(s.email LIKE ? OR (s.first_name || ' ' || s.last_name || ' ' || s.company) LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
  if (status === 'Subscribed' || status === 'Unsubscribed') { where.push('sub.status = ?'); args.push(status); }
  if (status === 'Expired') { where.push("sub.status = 'Subscribed' AND sub.consent_type = 'Implied' AND sub.implied_until < ?"); args.push(d); }
  if (status === 'Suppressed') where.push('x.email IS NOT NULL');
  const sql = `FROM subscriptions sub JOIN subscribers s ON s.id = sub.subscriber_id LEFT JOIN suppressions x ON x.email = s.email WHERE ${where.join(' AND ')}`;
  const [rows, total] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT s.id, s.email, s.first_name, s.last_name, s.company, s.phone, s.rev, sub.status, sub.consent_type, sub.consent_date, sub.consent_source, sub.implied_until,
      sub.unsubscribed_at, sub.unsubscribe_source, x.reason AS suppressed ${sql} ORDER BY s.email LIMIT 100 OFFSET ?`).bind(...args, page * 100),
    c.env.DB.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...args),
  ]);
  return c.json({ subscribers: rowsToApi(rows.results), total: Number(total.results[0]?.n ?? 0), page, pageSize: 100 });
});

const personFields = { firstName: text(100), lastName: text(100), company: text(200), phone: text(60) };
email.post('/lists/:brand/subscribers', async c => {
  const brand = requireBrand(c, c.req.param('brand'));
  const v = await body(c, z.object({ email: z.string().trim().toLowerCase(), ...personFields, basis: basisSchema, consentDate: dateStr, consentSource: z.string().trim().min(3, 'is required: say how they gave consent').max(300), resubscribe: z.boolean().optional() }));
  if (!isEmailAddress(v.email)) fail(400, 'That isn’t a valid email address.');
  if (v.consentDate > today()) fail(400, 'The consent date can’t be in the future.');
  const until = impliedUntil(v.basis, v.consentDate);
  if (until && until < today()) fail(400, 'That implied consent has already expired. You need express consent to email this person.');
  const db = c.env.DB, t = nowIso();
  const sup = await db.prepare('SELECT reason FROM suppressions WHERE email = ?').bind(v.email).first<{ reason: string }>();
  if (sup) fail(409, `This address is blocked (${sup.reason.toLowerCase()}). It can’t be added to any list.`);
  let s = await db.prepare('SELECT id FROM subscribers WHERE email = ?').bind(v.email).first<{ id: string }>();
  const existing = s ? await db.prepare('SELECT status, unsubscribed_at FROM subscriptions WHERE subscriber_id = ? AND brand = ?').bind(s.id, brand).first<{ status: string; unsubscribed_at: string | null }>() : null;
  if (existing?.status === 'Subscribed') fail(409, 'This person is already on the list.');
  if (existing?.status === 'Unsubscribed') {
    // People who unsubscribed can come back only by giving express consent again, after they unsubscribed.
    if (!v.resubscribe || v.basis !== 'express' || v.consentDate < nyDate(new Date(String(existing.unsubscribed_at))))
      fail(409, 'This person unsubscribed. Add them again only with new express consent dated after they unsubscribed, and confirm the resubscription.');
  }
  const stmts: D1PreparedStatement[] = [];
  if (!s) {
    s = { id: newId() };
    stmts.push(db.prepare('INSERT INTO subscribers (id, email, first_name, last_name, company, phone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(s.id, v.email, v.firstName, v.lastName, v.company, v.phone, c.get('member').id, t, t));
  }
  const type = CONSENT_BASES.find(b => b.id === v.basis)!.type;
  stmts.push(db.prepare(`INSERT INTO subscriptions (subscriber_id, brand, status, consent_type, consent_date, consent_source, implied_until, created_at, updated_at) VALUES (?, ?, 'Subscribed', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (subscriber_id, brand) DO UPDATE SET status = 'Subscribed', consent_type = excluded.consent_type, consent_date = excluded.consent_date, consent_source = excluded.consent_source,
      implied_until = excluded.implied_until, unsubscribed_at = NULL, unsubscribe_source = '', updated_at = excluded.updated_at`).bind(s.id, brand, type, v.consentDate, v.consentSource, until, t, t));
  await db.batch(stmts);
  await audit(c, existing ? 'Resubscribed email contact' : 'Added email subscriber', `${brand}: ${v.email}`);
  return c.json({ id: s.id }, 201);
});

email.patch('/subscribers/:id', async c => {
  const v = await body(c, z.object({ ...personFields, rev }));
  const id = c.req.param('id'), m = c.get('member');
  const { results } = await c.env.DB.prepare('SELECT brand FROM subscriptions WHERE subscriber_id = ?').bind(id).all<{ brand: string }>();
  if (!results.some(r => canUseBrand(m, r.brand))) fail(404, 'Subscriber not found.');
  const r = await c.env.DB.prepare('UPDATE subscribers SET first_name = ?, last_name = ?, company = ?, phone = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?').bind(v.firstName, v.lastName, v.company, v.phone, nowIso(), id, v.rev).run();
  assertUpdated(r, 'This subscriber');
  return c.json({ ok: true });
});

email.post('/lists/:brand/subscribers/:id/unsubscribe', async c => {
  const brand = requireBrand(c, c.req.param('brand'));
  const changed = await unsubscribe(c.env, c.req.param('id'), brand, '', `Staff: ${c.get('member').name}`);
  if (!changed) fail(409, 'This person isn’t subscribed.');
  await audit(c, 'Unsubscribed email contact', brand);
  return c.json({ ok: true });
});

/** Bring in marketing contacts who gave email permission and belong to this entity. */
email.post('/lists/:brand/from-contacts', async c => {
  const brand = requireBrand(c, c.req.param('brand'));
  const brandName = EMAIL_BRANDS.find(b => b.id === brand)!.name;
  const db = c.env.DB, t = nowIso(), me = c.get('member').id;
  const { results } = await db.prepare(`SELECT x.id, lower(x.email) AS email, x.name, x.permission_date, x.permission_evidence FROM mk_contacts x
    WHERE x.status = 'Active' AND x.email <> '' AND x.email_permission = 'Granted' AND EXISTS (SELECT 1 FROM json_each(x.brands) WHERE value = ?)
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = x.email)`).bind(brandName).all<Record<string, string>>();
  let added = 0;
  for (const x of results) {
    const s = await db.prepare('SELECT id FROM subscribers WHERE email = ?').bind(x.email).first<{ id: string }>();
    const id = s?.id ?? newId();
    const [first, ...rest] = x.name.split(' ');
    const stmts = s ? [] : [db.prepare('INSERT INTO subscribers (id, email, first_name, last_name, contact_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, x.email, first, rest.join(' '), x.id, me, t, t)];
    // Never re-subscribes anyone who unsubscribed.
    stmts.push(db.prepare(`INSERT OR IGNORE INTO subscriptions (subscriber_id, brand, status, consent_type, consent_date, consent_source, created_at, updated_at) VALUES (?, ?, 'Subscribed', 'Express', ?, ?, ?, ?)`)
      .bind(id, brand, x.permission_date || t.slice(0, 10), `Marketing contact: ${x.permission_evidence}`.slice(0, 300), t, t));
    const res = await db.batch(stmts);
    added += res[res.length - 1].meta.changes;
  }
  await audit(c, 'Added marketing contacts to email list', `${brand}: ${added}`);
  return c.json({ added, eligible: results.length });
});

/* ---------------- Suppressions ---------------- */
email.get('/suppressions', async c => {
  const q = (c.req.query('q') || '').trim();
  const { results } = await c.env.DB.prepare(`SELECT * FROM suppressions ${q ? 'WHERE email LIKE ?' : ''} ORDER BY created_at DESC LIMIT 200`).bind(...(q ? [`%${q}%`] : [])).all();
  return c.json({ suppressions: rowsToApi(results) });
});
email.post('/suppressions', async c => {
  const v = await body(c, z.object({ email: z.string().trim().toLowerCase(), detail: text(300) }));
  if (!isEmailAddress(v.email)) fail(400, 'That isn’t a valid email address.');
  await c.env.DB.prepare("INSERT OR IGNORE INTO suppressions (email, reason, detail, created_by, created_at) VALUES (?, 'Manual', ?, ?, ?)").bind(v.email, v.detail, c.get('member').id, nowIso()).run();
  await audit(c, 'Blocked email address', v.email);
  return c.json({ ok: true }, 201);
});
email.post('/suppressions/remove', async c => {
  requireAdmin(c);
  const v = await body(c, z.object({ email: z.string().trim().toLowerCase() }));
  const s = await c.env.DB.prepare('SELECT reason FROM suppressions WHERE email = ?').bind(v.email).first<{ reason: string }>();
  if (!s) fail(404, 'That address isn’t blocked.');
  // A spam complaint is the recipient's own decision; it stays.
  if (s!.reason === 'Complaint') fail(403, 'This person reported your email as spam. They can’t be unblocked.');
  await c.env.DB.prepare('DELETE FROM suppressions WHERE email = ?').bind(v.email).run();
  await audit(c, 'Unblocked email address', v.email);
  return c.json({ ok: true });
});

/* ---------------- Bulk import ---------------- */
email.get('/imports', async c => {
  const m = c.get('member');
  const { results } = await c.env.DB.prepare('SELECT i.*, m.name AS created_by_name FROM subscriber_imports i JOIN members m ON m.id = i.created_by ORDER BY i.created_at DESC LIMIT 100').all<Record<string, unknown>>();
  return c.json({ imports: results.filter(r => canUseBrand(m, String(r.brand))).map(r => ({ ...toApi<Record<string, unknown>>(r), errors: JSON.parse(String(r.errors)), chunks: undefined })) });
});

email.post('/imports', async c => {
  requireAdmin(c);
  const v = await body(c, z.object({
    brand: brandSchema, filename: text(200), totalRows: z.number().int().min(1).max(500000), basis: basisSchema, consentDate: dateStr,
    consentSource: z.string().trim().min(5, 'is required: say where these people gave consent').max(300),
    attest: z.literal(true, { errorMap: () => ({ message: 'Confirm that everyone on this list gave consent and that it isn’t a bought or rented list.' }) }),
  }));
  requireBrand(c, v.brand);
  if (v.consentDate > today()) fail(400, 'The consent date can’t be in the future.');
  const id = newId();
  const b = CONSENT_BASES.find(x => x.id === v.basis)!;
  await c.env.DB.prepare("INSERT INTO subscriber_imports (id, brand, filename, consent_type, consent_basis, consent_date, consent_source, total_rows, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?)")
    .bind(id, v.brand, v.filename, b.type, v.basis, v.consentDate, v.consentSource, v.totalRows, c.get('member').id, nowIso()).run();
  return c.json({ id }, 201);
});

const rowSchema = z.object({ email: z.string().max(320).default(''), firstName: text(100), lastName: text(100), company: text(200), phone: text(60), consentDate: z.string().max(40).default(''), consentSource: text(300) });
/** Normalise common date formats from exports to YYYY-MM-DD; '' if unreadable. */
function toDate(s: string) {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString().slice(0, 10);
}

email.post('/imports/:id/chunks', async c => {
  requireAdmin(c);
  const v = await body(c, z.object({ index: z.number().int().min(0), rows: z.array(rowSchema).max(IMPORT_CHUNK) }));
  const db = c.env.DB, id = c.req.param('id'), d = today(), t = nowIso(), me = c.get('member').id;
  const imp = await db.prepare('SELECT * FROM subscriber_imports WHERE id = ?').bind(id).first<Record<string, string>>();
  if (!imp) fail(404, 'Import not found.');
  requireBrand(c, imp!.brand);
  if (imp!.created_by !== me) fail(403, 'Only the person who started this import can add to it.');
  if (imp!.status !== 'Open') fail(409, 'This import is already finished.');
  const done = JSON.parse(imp!.chunks) as number[];
  if (done.includes(v.index)) return c.json({ duplicate: true, added: 0, existing: 0, skipped: 0, errors: [] });

  type Problem = { row: number; email: string; message: string };
  const problems: Problem[] = [];
  const seen = new Map<string, { row: number; r: z.infer<typeof rowSchema>; date: string; until: string }>();
  v.rows.forEach((r, i) => {
    const row = v.index * IMPORT_CHUNK + i + 2; // spreadsheet row (after the header)
    const em = r.email.trim().toLowerCase().replace(/^mailto:/, '');
    if (!isEmailAddress(em)) return problems.push({ row, email: r.email, message: 'Not a valid email address' });
    const date = r.consentDate ? toDate(r.consentDate) : imp!.consent_date;
    if (!date || date > d) return problems.push({ row, email: em, message: 'Consent date missing or in the future' });
    const until = impliedUntil(imp!.consent_basis as ConsentBasis, date);
    if (until && until < d) return problems.push({ row, email: em, message: 'Implied consent has expired' });
    if (seen.has(em)) return problems.push({ row, email: em, message: 'Repeated in this file' });
    seen.set(em, { row, r, date, until });
  });
  const emails = [...seen.keys()];
  const subs = new Map<string, { id: string; first_name: string; last_name: string; company: string; phone: string }>(), status = new Map<string, string>(), blocked = new Set<string>();
  for (let i = 0; i < emails.length; i += 90) {
    const part = emails.slice(i, i + 90), marks = part.map(() => '?').join(',');
    const [a, b, x] = await db.batch<Record<string, string>>([
      db.prepare(`SELECT id, lower(email) AS email, first_name, last_name, company, phone FROM subscribers WHERE email IN (${marks})`).bind(...part),
      db.prepare(`SELECT lower(s.email) AS email, sub.status FROM subscriptions sub JOIN subscribers s ON s.id = sub.subscriber_id WHERE sub.brand = ? AND s.email IN (${marks})`).bind(imp!.brand, ...part),
      db.prepare(`SELECT lower(email) AS email FROM suppressions WHERE email IN (${marks})`).bind(...part),
    ]);
    for (const r of a.results) subs.set(r.email, r as never);
    for (const r of b.results) status.set(r.email, r.status);
    for (const r of x.results) blocked.add(r.email);
  }
  const stmts: D1PreparedStatement[] = [];
  let added = 0, existing = 0;
  for (const [em, { row, r, date, until }] of seen) {
    if (blocked.has(em)) { problems.push({ row, email: em, message: 'Blocked (earlier bounce, complaint or manual block)' }); continue; }
    if (status.get(em) === 'Unsubscribed') { problems.push({ row, email: em, message: 'Unsubscribed earlier; not re-added' }); continue; }
    const s = subs.get(em);
    const sid = s?.id ?? newId();
    if (!s) stmts.push(db.prepare('INSERT INTO subscribers (id, email, first_name, last_name, company, phone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING')
      .bind(sid, em, r.firstName, r.lastName, r.company, r.phone, me, t, t));
    else if ((!s.first_name && r.firstName) || (!s.last_name && r.lastName) || (!s.company && r.company) || (!s.phone && r.phone))
      stmts.push(db.prepare('UPDATE subscribers SET first_name = ?, last_name = ?, company = ?, phone = ?, updated_at = ?, rev = rev + 1 WHERE id = ?')
        .bind(s.first_name || r.firstName, s.last_name || r.lastName, s.company || r.company, s.phone || r.phone, t, sid));
    if (status.get(em) === 'Subscribed') { existing++; continue; }
    stmts.push(db.prepare(`INSERT OR IGNORE INTO subscriptions (subscriber_id, brand, status, consent_type, consent_date, consent_source, implied_until, import_id, created_at, updated_at) VALUES (?, ?, 'Subscribed', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sid, imp!.brand, imp!.consent_type, date, (r.consentSource || imp!.consent_source).slice(0, 300), until, id, t, t));
    added++;
  }
  const kept = (JSON.parse(imp!.errors) as Problem[]).concat(problems).slice(0, 500);
  // Recording the chunk number in the same transaction makes a retried chunk a no-op.
  stmts.push(db.prepare('UPDATE subscriber_imports SET added = added + ?, existing = existing + ?, skipped = skipped + ?, errors = ?, chunks = json_insert(chunks, \'$[#]\', ?) WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(chunks) WHERE value = ?)')
    .bind(added, existing, problems.length, JSON.stringify(kept), v.index, id, v.index));
  await db.batch(stmts);
  return c.json({ added, existing, skipped: problems.length, errors: problems.slice(0, 50) });
});

email.post('/imports/:id/complete', async c => {
  requireAdmin(c);
  const db = c.env.DB, id = c.req.param('id');
  const imp = await db.prepare('SELECT * FROM subscriber_imports WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!imp) fail(404, 'Import not found.');
  requireBrand(c, String(imp!.brand));
  await db.prepare("UPDATE subscriber_imports SET status = 'Complete', completed_at = ? WHERE id = ? AND status = 'Open'").bind(nowIso(), id).run();
  await audit(c, 'Imported email subscribers', `${imp!.brand}: ${imp!.added} added, ${imp!.existing} already there, ${imp!.skipped} skipped`);
  const row = await db.prepare('SELECT * FROM subscriber_imports WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ import: { ...toApi<Record<string, unknown>>(row), errors: JSON.parse(String(row!.errors)) } });
});

/* ---------------- Mailings ---------------- */
const mailingInput = z.object({
  brand: brandSchema, name: z.string().trim().min(1, 'is required').max(200), subject: text(200), preheader: text(200),
  format: z.enum(['markdown', 'html']).default('markdown'), body: z.string().max(200_000).default(''), campaignId: z.string().min(1).nullable().default(null),
});
const content = (r: Record<string, unknown>): MailContent => ({ subject: String(r.subject), preheader: String(r.preheader), format: r.format as MailContent['format'], body: String(r.body) });

async function loadMailing(c: Context<AppEnv>, id: string) {
  const r = await c.env.DB.prepare('SELECT ml.*, m.name AS created_by_name, sb.name AS sent_by_name, ca.name AS campaign_name FROM mailings ml LEFT JOIN members m ON m.id = ml.created_by LEFT JOIN members sb ON sb.id = ml.sent_by LEFT JOIN campaigns ca ON ca.id = ml.campaign_id WHERE ml.id = ?')
    .bind(id).first<Record<string, unknown>>();
  if (!r || !canUseBrand(c.get('member'), String(r.brand))) fail(404, 'Mailing not found.');
  return r!;
}
const loadSender = async (db: D1Database, brand: string) => {
  const s = await db.prepare('SELECT * FROM email_senders WHERE brand = ?').bind(brand).first<Record<string, unknown>>();
  return s ? senderFromRow(s) : null;
};
const audienceCount = async (db: D1Database, brand: string) =>
  Number((await db.prepare(`SELECT COUNT(*) AS n ${AUDIENCE_FROM} WHERE ${AUDIENCE_WHERE}`).bind(brand, today()).first<{ n: number }>())?.n ?? 0);

email.get('/mailings', async c => {
  const m = c.get('member');
  const { results } = await c.env.DB.prepare('SELECT ml.id, ml.brand, ml.name, ml.subject, ml.status, ml.scheduled_at, ml.started_at, ml.finished_at, ml.recipient_count, ml.sent_count, ml.failed_count, ml.bounce_count, ml.complaint_count, ml.unsubscribe_count, ml.pause_reason, ml.updated_at, m.name AS created_by_name FROM mailings ml LEFT JOIN members m ON m.id = ml.created_by ORDER BY ml.updated_at DESC LIMIT 500')
    .all<Record<string, unknown>>();
  return c.json({ mailings: rowsToApi(results.filter(r => canUseBrand(m, String(r.brand)))) });
});

email.get('/mailings/:id', async c => {
  const r = await loadMailing(c, c.req.param('id'));
  const db = c.env.DB, sender = await loadSender(db, String(r.brand));
  const [problems, queued] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT email, status, error, bounced, complained FROM mailing_recipients WHERE mailing_id = ? AND (status IN ('Failed', 'Skipped') OR bounced = 1 OR complained = 1) ORDER BY status LIMIT 100").bind(r.id),
    db.prepare("SELECT COUNT(*) AS n FROM mailing_recipients WHERE mailing_id = ? AND status IN ('Queued', 'Sending')").bind(r.id),
  ]);
  return c.json({
    mailing: toApi(r), sender, checks: checkMailing(content(r), sender), audience: ['Draft', 'Scheduled'].includes(String(r.status)) ? await audienceCount(db, String(r.brand)) : Number(r.recipient_count),
    remaining: Number(queued.results[0]?.n ?? 0), problems: rowsToApi(problems.results), providerReady: providerReady(c.env),
  });
});

email.post('/mailings', async c => {
  const v = await body(c, mailingInput);
  requireBrand(c, v.brand);
  if (v.campaignId && !(await c.env.DB.prepare('SELECT 1 FROM campaigns WHERE id = ?').bind(v.campaignId).first())) fail(400, 'Choose an existing campaign.');
  const id = newId(), t = nowIso();
  await c.env.DB.prepare("INSERT INTO mailings (id, brand, name, subject, preheader, format, body, campaign_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?)")
    .bind(id, v.brand, v.name, v.subject, v.preheader, v.format, v.body, v.campaignId, c.get('member').id, t, t).run();
  await audit(c, 'Created mailing draft', v.name);
  return c.json({ id }, 201);
});

email.patch('/mailings/:id', async c => {
  const v = await body(c, mailingInput.extend({ rev }));
  const r = await loadMailing(c, c.req.param('id'));
  requireBrand(c, v.brand);
  if (r.status !== 'Draft') fail(409, 'Only drafts can be edited. Cancel the scheduled send first.');
  if (v.campaignId && !(await c.env.DB.prepare('SELECT 1 FROM campaigns WHERE id = ?').bind(v.campaignId).first())) fail(400, 'Choose an existing campaign.');
  const res = await c.env.DB.prepare("UPDATE mailings SET brand = ?, name = ?, subject = ?, preheader = ?, format = ?, body = ?, campaign_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ? AND status = 'Draft'")
    .bind(v.brand, v.name, v.subject, v.preheader, v.format, v.body, v.campaignId, nowIso(), r.id, v.rev).run();
  assertUpdated(res, 'This mailing');
  return c.json({ ok: true });
});

email.post('/mailings/:id/duplicate', async c => {
  const r = await loadMailing(c, c.req.param('id'));
  const id = newId(), t = nowIso();
  await c.env.DB.prepare("INSERT INTO mailings (id, brand, name, subject, preheader, format, body, campaign_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?)")
    .bind(id, r.brand, `${r.name} (copy)`, r.subject, r.preheader, r.format, r.body, r.campaign_id, c.get('member').id, t, t).run();
  return c.json({ id }, 201);
});

/** Send the current draft to yourself only. */
email.post('/mailings/:id/test', async c => {
  const r = await loadMailing(c, c.req.param('id'));
  const m = c.get('member'), sender = await loadSender(c.env.DB, String(r.brand));
  const blocks = checkMailing(content(r), sender).filter(x => x.level === 'block');
  if (blocks.length) fail(400, blocks[0].text);
  if (!providerReady(c.env)) fail(400, 'Email sending isn’t configured yet (see GO-LIVE.md, “Email sending”).');
  const [firstName, ...rest] = m.name.split(' ');
  const url = await unsubscribeUrl(c.env, { subscriberId: 'test', brand: String(r.brand), mailingId: String(r.id) });
  const msg = renderEmail(sender!, content(r), { email: m.email, firstName, lastName: rest.join(' '), company: '' }, url);
  const res = await sendRaw(c.env, { fromName: sender!.fromName, fromEmail: sender!.fromEmail, replyTo: sender!.replyTo, to: m.email, subject: `[Test] ${msg.subject}`, html: msg.html, text: msg.text, unsubscribeUrl: url, feedbackId: `test:${r.brand}:momentum` });
  if (!res.ok) fail(400, `The test didn’t send: ${res.error}`);
  return c.json({ ok: true, to: m.email });
});

email.post('/mailings/:id/send', async c => {
  requireAdmin(c);
  const v = await body(c, z.object({ rev, scheduledAt: z.string().datetime({ offset: true }).optional() }));
  const r = await loadMailing(c, c.req.param('id'));
  if (r.status !== 'Draft') fail(409, 'Only a draft can be sent.');
  const db = c.env.DB, sender = await loadSender(db, String(r.brand));
  const blocks = checkMailing(content(r), sender).filter(x => x.level === 'block');
  if (blocks.length) fail(400, blocks[0].text);
  if (!providerReady(c.env)) fail(400, 'Email sending isn’t configured yet (see GO-LIVE.md, “Email sending”).');
  if (!(await audienceCount(db, String(r.brand)))) fail(400, 'Nobody on this list can be emailed right now.');
  const at = v.scheduledAt ? new Date(v.scheduledAt) : new Date();
  if (at.getTime() < Date.now() - 60_000) fail(400, 'Choose a time in the future.');
  const res = await db.prepare("UPDATE mailings SET status = 'Scheduled', scheduled_at = ?, sent_by = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ? AND status = 'Draft'")
    .bind(at.toISOString(), c.get('member').id, nowIso(), r.id, v.rev).run();
  assertUpdated(res, 'This mailing');
  await audit(c, v.scheduledAt ? 'Scheduled mailing' : 'Started mailing', `${r.brand}: ${r.name}`);
  return c.json({ ok: true, scheduledAt: at.toISOString() });
});

email.post('/mailings/:id/:action{pause|resume|cancel}', async c => {
  requireAdmin(c);
  const v = await body(c, z.object({ rev }));
  const r = await loadMailing(c, c.req.param('id'));
  const action = c.req.param('action'), db = c.env.DB, t = nowIso();
  const allowed: Record<string, string[]> = { pause: ['Sending'], resume: ['Paused'], cancel: ['Scheduled', 'Sending', 'Paused'] };
  if (!allowed[action].includes(String(r.status))) fail(409, `A ${String(r.status).toLowerCase()} mailing can’t be ${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled'}.`);
  // Cancelling before sending starts returns it to Draft; after it starts, the rest of the queue is dropped.
  const next = action === 'pause' ? 'Paused' : action === 'resume' ? 'Sending' : r.status === 'Scheduled' ? 'Draft' : 'Cancelled';
  const stmts = [db.prepare(`UPDATE mailings SET status = ?1, pause_reason = ?2, ${next === 'Draft' ? 'scheduled_at = NULL, sent_by = NULL,' : ''} ${next === 'Cancelled' ? 'finished_at = ?6,' : ''} updated_at = ?6, rev = rev + 1 WHERE id = ?3 AND rev = ?4 AND status = ?5`)
    .bind(next, action === 'pause' ? `Paused by ${c.get('member').name}` : '', r.id, v.rev, r.status, t)];
  if (next === 'Cancelled') stmts.push(db.prepare("UPDATE mailing_recipients SET status = 'Skipped', error = 'Mailing cancelled' WHERE mailing_id = ?1 AND status = 'Queued' AND (SELECT status FROM mailings WHERE id = ?1) = 'Cancelled'").bind(r.id));
  const [res] = await db.batch(stmts);
  assertUpdated(res, 'This mailing');
  await audit(c, { pause: 'Paused mailing', resume: 'Resumed mailing', cancel: 'Cancelled mailing' }[action] ?? action, String(r.name));
  return c.json({ ok: true, status: next });
});

/** Development only: run the once-a-minute sender now. */
email.post('/run-queue', async c => {
  requireAdmin(c);
  if (c.env.ENVIRONMENT !== 'development') fail(404, 'Not found.');
  return c.json(await runScheduler(c.env));
});

