import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { isAdmin, requireAdmin } from '../policy';
import { assertUpdated, audit, body, fail, newId, nowIso, rev, rowsToApi, text } from '../util';

/**
 * Team › Announcements. Every active member reads them; administrators post, edit and archive.
 * Each person's reads are recorded, so unread announcements show in the menu and the attention centre.
 */
export const announcements = new Hono<AppEnv>();

const input = z.object({
  title: z.string().trim().min(1, 'is required').max(200),
  body: text(10000),
  pinned: z.boolean().default(false),
});

announcements.get('/', async c => {
  const m = c.get('member'), db = c.env.DB;
  const archived = c.req.query('archived') === '1' && isAdmin(m);
  const [{ results }, { results: count }] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT a.*, p.name AS posted_by_name, r.read_at,
        (SELECT count(*) FROM announcement_reads x JOIN members xm ON xm.id = x.member_id WHERE x.announcement_id = a.id AND xm.active = 1) AS read_count
      FROM announcements a LEFT JOIN members p ON p.id = a.posted_by
      LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.member_id = ?
      WHERE a.status = ? ORDER BY a.pinned DESC, a.posted_at DESC LIMIT 500`).bind(m.id, archived ? 'Archived' : 'Published'),
    db.prepare('SELECT count(*) AS n FROM members WHERE active = 1'),
  ]);
  // Who has read what is for administrators; everyone else sees only their own read state.
  const rows = rowsToApi<Record<string, unknown>>(results).map(a => (isAdmin(m) ? a : { ...a, readCount: undefined }));
  return c.json({ announcements: rows, activeMembers: isAdmin(m) ? Number(count[0]?.n ?? 0) : undefined });
});

announcements.get('/unread', async c => {
  const n = await c.env.DB.prepare(`SELECT count(*) AS n FROM announcements a WHERE a.status = 'Published'
    AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.member_id = ?)`).bind(c.get('member').id).first<number>('n');
  return c.json({ unread: Number(n ?? 0) });
});

/** Administrators: who has and hasn't read an announcement. */
announcements.get('/:id/reads', async c => {
  requireAdmin(c);
  const db = c.env.DB, id = c.req.param('id');
  if (!(await db.prepare('SELECT 1 FROM announcements WHERE id = ?').bind(id).first())) fail(404, 'Announcement not found.');
  const { results } = await db.prepare(`SELECT m.id, m.name, r.read_at FROM members m LEFT JOIN announcement_reads r ON r.member_id = m.id AND r.announcement_id = ?
    WHERE m.active = 1 ORDER BY r.read_at IS NULL DESC, m.name`).bind(id).all<Record<string, unknown>>();
  return c.json({ people: rowsToApi(results) });
});

announcements.post('/', async c => {
  const m = requireAdmin(c);
  const v = await body(c, input);
  const id = newId(), t = nowIso();
  // The person posting has read it.
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO announcements (id, title, body, pinned, status, posted_by, posted_at, updated_at) VALUES (?, ?, ?, ?, 'Published', ?, ?, ?)").bind(id, v.title, v.body, v.pinned, m.id, t, t),
    c.env.DB.prepare('INSERT INTO announcement_reads (announcement_id, member_id, read_at) VALUES (?, ?, ?)').bind(id, m.id, t),
  ]);
  await audit(c, 'Posted announcement', v.title);
  return c.json({ id }, 201);
});

announcements.patch('/:id', async c => {
  requireAdmin(c);
  const v = await body(c, input.extend({ status: z.enum(['Published', 'Archived']).default('Published'), rev }));
  const r = await c.env.DB.prepare('UPDATE announcements SET title = ?, body = ?, pinned = ?, status = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.title, v.body, v.pinned, v.status, nowIso(), c.req.param('id'), v.rev).run();
  assertUpdated(r, 'This announcement');
  await audit(c, v.status === 'Archived' ? 'Archived announcement' : 'Updated announcement', v.title);
  return c.json({ ok: true });
});

announcements.post('/:id/read', async c => {
  const db = c.env.DB, id = c.req.param('id');
  if (!(await db.prepare("SELECT 1 FROM announcements WHERE id = ? AND status = 'Published'").bind(id).first())) fail(404, 'Announcement not found.');
  await db.prepare('INSERT INTO announcement_reads (announcement_id, member_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(id, c.get('member').id, nowIso()).run();
  return c.json({ ok: true });
});

announcements.post('/read-all', async c => {
  await c.env.DB.prepare(`INSERT INTO announcement_reads (announcement_id, member_id, read_at) SELECT a.id, ?1, ?2 FROM announcements a WHERE a.status = 'Published'
    ON CONFLICT DO NOTHING`).bind(c.get('member').id, nowIso()).run();
  return c.json({ ok: true });
});
