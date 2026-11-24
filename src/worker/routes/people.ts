import { Hono } from 'hono';
import { z } from 'zod';
import { DIVISION_IDS } from '../../shared/constants';
import type { AppEnv } from '../env';
import { canGrant, canManageMember, hasDivision, hasFirm, isAdmin, isOwner, requireAdmin } from '../policy';
import { assertUpdated, audit, body, fail, memberFromRow, newId, nowIso, optEmail, rev, text } from '../util';

export const people = new Hono<AppEnv>();

people.get('/me', c => c.json({ member: c.get('member') }));

people.patch('/me', async c => {
  const m = c.get('member');
  const v = await body(c, z.object({ title: text(120) }));
  await c.env.DB.prepare('UPDATE members SET title = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').bind(v.title, nowIso(), m.id).run();
  await audit(c, 'Updated title', `${m.name}: ${v.title}`);
  return c.json({ ok: true });
});

/** Everyone gets names for assignment lists; only administrators see emails and sign-in state. */
people.get('/members', async c => {
  const m = c.get('member');
  const { results } = await c.env.DB.prepare('SELECT * FROM members ORDER BY role = \'Owner\' DESC, name').all<Record<string, unknown>>();
  const admin = isAdmin(m);
  return c.json({
    members: results.map(r => {
      const x = memberFromRow(r);
      return admin ? { ...x, firstSignIn: r.first_sign_in, rev: r.rev } : { id: x.id, name: x.name, title: x.title, role: x.role, divisions: x.divisions, active: x.active };
    }),
  });
});

const memberInput = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  title: text(120),
  email: z.string().trim().toLowerCase().email('must be the person’s Google sign-in email'),
  role: z.enum(['Member', 'Administrator']),
  divisions: z.array(z.enum(DIVISION_IDS as [string, ...string[]])).default([]),
  active: z.boolean().default(true),
});

people.post('/members', async c => {
  const actor = requireAdmin(c);
  const v = await body(c, memberInput);
  if (!canManageMember(actor, { role: v.role })) fail(403, 'Only Jasmine can add administrators.');
  const blocked = v.divisions.filter(d => !canGrant(actor, d));
  if (blocked.length) fail(403, 'Only Jasmine can grant JD&Co Law Firm, Accounting or JD Publishing.');
  const exists = await c.env.DB.prepare('SELECT id FROM members WHERE email = ?').bind(v.email).first();
  if (exists) fail(409, 'That email already belongs to a member.');
  const t = nowIso(), id = newId();
  await c.env.DB.prepare('INSERT INTO members (id, email, name, title, role, divisions, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.email, v.name, v.title, v.role, JSON.stringify(v.divisions), v.active ? 1 : 0, t, t).run();
  await audit(c, 'Added member', v.name);
  return c.json({ id }, 201);
});

people.patch('/members/:id', async c => {
  const actor = requireAdmin(c);
  const v = await body(c, memberInput.extend({ rev }));
  const row = await c.env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!row) fail(404, 'Member not found.');
  const target = memberFromRow(row!);
  if (!canManageMember(actor, target) || !canManageMember(actor, { role: v.role })) fail(403, 'You can’t change this person’s access.');
  if (target.id === actor.id && !v.active) fail(400, 'You can’t turn off your own access.');
  if (row!.first_sign_in && target.email !== v.email) fail(400, 'This person has already signed in, so their email can’t be changed. Add a new member instead.');
  // Restricted divisions an administrator can't grant are kept exactly as they were.
  let divisions = v.divisions;
  if (!isOwner(actor)) {
    const kept = target.divisions.filter(d => !canGrant(actor, d));
    divisions = [...new Set([...kept, ...v.divisions.filter(d => canGrant(actor, d))])];
  }
  const dup = await c.env.DB.prepare('SELECT id FROM members WHERE email = ? AND id <> ?').bind(v.email, target.id).first();
  if (dup) fail(409, 'That email already belongs to another member.');
  const r = await c.env.DB.prepare('UPDATE members SET name = ?, title = ?, email = ?, role = ?, divisions = ?, active = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?')
    .bind(v.name, v.title, v.email, v.role, JSON.stringify(divisions), v.active ? 1 : 0, nowIso(), target.id, v.rev).run();
  assertUpdated(r, 'This person’s record');
  await audit(c, 'Updated member access', v.name);
  return c.json({ ok: true });
});

people.get('/audit', async c => {
  const m = c.get('member');
  const limit = Math.min(Number(c.req.query('limit')) || 25, 200);
  // Firm and property activity is shown only to people with that division.
  const hidden = [!hasFirm(m) && "'firm'", !hasDivision(m, 'properties') && "'properties'"].filter(Boolean);
  const { results } = await c.env.DB.prepare(`SELECT a.*, m.name AS actor_name FROM audit a LEFT JOIN members m ON m.id = a.actor_id ${hidden.length ? `WHERE a.scope NOT IN (${hidden.join(', ')})` : ''} ORDER BY a.at DESC LIMIT ?`)
    .bind(limit).all();
  return c.json({ audit: results.map(r => ({ id: r.id, at: r.at, actor: r.actor_name, action: r.action, entity: r.entity, scope: r.scope })) });
});
