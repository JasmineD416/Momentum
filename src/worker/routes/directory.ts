import { Hono } from 'hono';
import { z } from 'zod';
import { DIVISION_IDS, FOLDER_KINDS, ITEM_STATUSES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { hasDivision, requireDivision, requireFolder } from '../policy';
import { assertUpdated, audit, body, fail, httpsUrl, newId, nowIso, optDate, optEmail, rev, rowsToApi, text } from '../util';

export const directory = new Hono<AppEnv>();

async function checkOwner(db: D1Database, ownerId: string | null, division: string | null) {
  if (!ownerId) return;
  const o = await db.prepare('SELECT role, divisions, active FROM members WHERE id = ?').bind(ownerId).first<Record<string, unknown>>();
  if (!o || !o.active) fail(400, 'Choose an active staff member as owner.');
  if (division && o!.role !== 'Owner' && !JSON.parse(String(o!.divisions)).includes(division)) fail(400, 'The owner must have access to this division.');
}

/* ---------------- Division contacts ---------------- */
const contactInput = z.object({
  division: z.enum(DIVISION_IDS as [string, ...string[]]),
  name: z.string().trim().min(1, 'is required').max(160), organization: text(200), role: text(160),
  email: optEmail, phone: text(80), ownerId: z.string().nullable().default(null),
  nextAction: text(300), followUp: optDate, status: z.enum(['Active', 'Archived']).default('Active'), notes: text(4000),
  confirmDuplicate: z.boolean().optional(),
});

directory.get('/contacts', async c => {
  const division = c.req.query('division') || '';
  requireDivision(c, division);
  const { results } = await c.env.DB.prepare(`SELECT d.*, m.name AS owner_name FROM div_contacts d LEFT JOIN members m ON m.id = d.owner_id
    WHERE d.division = ? ORDER BY d.name COLLATE NOCASE LIMIT 2000`).bind(division).all();
  return c.json({ contacts: rowsToApi(results) });
});

async function dupContact(db: D1Database, v: z.infer<typeof contactInput>, excludeId = '') {
  if (!v.email) return null;
  return db.prepare('SELECT name FROM div_contacts WHERE division = ? AND email = ? COLLATE NOCASE AND id <> ?').bind(v.division, v.email, excludeId).first<Record<string, string>>();
}

directory.post('/contacts', async c => {
  const v = await body(c, contactInput);
  requireDivision(c, v.division);
  await checkOwner(c.env.DB, v.ownerId, v.division);
  const dup = await dupContact(c.env.DB, v);
  if (dup && !v.confirmDuplicate) fail(409, `${dup.name} already uses ${v.email} in this division. Confirm if that’s intentional.`);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare(`INSERT INTO div_contacts (id, division, name, organization, role, email, phone, owner_id, next_action, follow_up, status, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, v.division, v.name, v.organization, v.role, v.email, v.phone, v.ownerId, v.nextAction, v.followUp, v.status, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Added contact', `${v.division}: ${v.name}`, v.division === 'jdco' ? 'firm' : 'general');
  return c.json({ id }, 201);
});

directory.patch('/contacts/:id', async c => {
  const v = await body(c, contactInput.extend({ rev }));
  const cur = await c.env.DB.prepare('SELECT division FROM div_contacts WHERE id = ?').bind(c.req.param('id')).first<Record<string, string>>();
  if (!cur) fail(404, 'Contact not found.');
  requireDivision(c, cur!.division);
  if (v.division !== cur!.division) fail(400, 'A contact can’t move between divisions.');
  await checkOwner(c.env.DB, v.ownerId, v.division);
  const dup = await dupContact(c.env.DB, v, c.req.param('id'));
  if (dup && !v.confirmDuplicate) fail(409, `${dup.name} already uses ${v.email} in this division. Confirm if that’s intentional.`);
  const r = await c.env.DB.prepare(`UPDATE div_contacts SET name = ?, organization = ?, role = ?, email = ?, phone = ?, owner_id = ?, next_action = ?, follow_up = ?, status = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(v.name, v.organization, v.role, v.email, v.phone, v.ownerId, v.nextAction, v.followUp, v.status, v.notes, nowIso(), c.req.param('id'), v.rev).run();
  assertUpdated(r, 'This contact');
  await audit(c, 'Updated contact', `${v.division}: ${v.name}`, v.division === 'jdco' ? 'firm' : 'general');
  return c.json({ ok: true });
});

/* ---------------- Folders (items link to files kept in Box) ---------------- */
const itemInput = z.object({
  folder: z.string(), title: z.string().trim().min(1, 'is required').max(200), kind: z.enum(FOLDER_KINDS), status: z.enum(ITEM_STATUSES),
  link: httpsUrl, ownerId: z.string().nullable().default(null), notes: text(4000),
});

directory.get('/folders/:folder', async c => {
  const f = requireFolder(c, c.req.param('folder'));
  const { results } = await c.env.DB.prepare(`SELECT i.*, m.name AS owner_name FROM folder_items i LEFT JOIN members m ON m.id = i.owner_id WHERE i.folder = ? ORDER BY i.updated_at DESC`).bind(f.id).all();
  return c.json({ items: rowsToApi(results) });
});

directory.post('/folders/:folder/items', async c => {
  const f = requireFolder(c, c.req.param('folder'));
  const v = await body(c, itemInput);
  if (v.folder !== f.id) fail(400, 'Folder mismatch.');
  await checkOwner(c.env.DB, v.ownerId, f.division);
  const id = newId(), t = nowIso();
  await c.env.DB.prepare('INSERT INTO folder_items (id, folder, title, kind, status, link, owner_id, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, f.id, v.title, v.kind, v.status, v.link, v.ownerId, v.notes, c.get('member').id, t, t).run();
  await audit(c, 'Added item', `${f.name}: ${v.title}`);
  return c.json({ id }, 201);
});

directory.patch('/folders/:folder/items/:id', async c => {
  const f = requireFolder(c, c.req.param('folder'));
  const v = await body(c, itemInput.extend({ rev }));
  await checkOwner(c.env.DB, v.ownerId, f.division);
  const r = await c.env.DB.prepare('UPDATE folder_items SET title = ?, kind = ?, status = ?, link = ?, owner_id = ?, notes = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND folder = ? AND rev = ?')
    .bind(v.title, v.kind, v.status, v.link, v.ownerId, v.notes, nowIso(), c.req.param('id'), f.id, v.rev).run();
  assertUpdated(r, 'This item');
  await audit(c, 'Updated item', `${f.name}: ${v.title}`);
  return c.json({ ok: true });
});

/** Counts for the overview's "Your divisions" tiles. */
directory.get('/summary', async c => {
  const m = c.get('member'), db = c.env.DB;
  const { results } = await db.prepare("SELECT division, COUNT(*) AS n FROM div_contacts WHERE status = 'Active' GROUP BY division").all<{ division: string; n: number }>();
  const contacts = Object.fromEntries(results.filter(r => hasDivision(m, r.division)).map(r => [r.division, r.n]));
  let firm = null;
  if (hasDivision(m, 'jdco')) {
    const x = await db.prepare(`SELECT (SELECT COUNT(*) FROM clients) AS clients, (SELECT COUNT(*) FROM matters WHERE status = 'Open') AS open_matters,
      (SELECT COUNT(*) FROM pncs WHERE status NOT IN ('Retained', 'Referred', 'Not retained', 'Closed')) AS active_pncs`).first<Record<string, number>>();
    firm = { clients: x?.clients ?? 0, openMatters: x?.open_matters ?? 0, activePncs: x?.active_pncs ?? 0 };
  }
  return c.json({ contacts, firm });
});
