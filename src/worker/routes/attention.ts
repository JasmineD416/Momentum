import { Hono } from 'hono';
import { z } from 'zod';
import { addDays, reportAlertsDue } from '../../shared/time';
import type { AppEnv } from '../env';
import { checkStaff, hasDivision, hasFirm, isAdmin } from '../policy';
import { audit, body, dateStr, fail, newId, nowIso, rev, rowsToApi, text } from '../util';
import { canSeeProgram } from './campaigns';

/**
 * The attention centre: alerts derived from work the person is allowed to see, plus personal reminders.
 * Read, dismissed and snoozed states are per person. Dismissing hides an alert; it never completes the source.
 */
export const attention = new Hono<AppEnv>();

type Alert = { key: string; kind: string; title: string; detail: string; date: string; link: string; read?: boolean };

attention.get('/attention', async c => {
  const m = c.get('member'), db = c.env.DB;
  const due = reportAlertsDue();
  const today = due.today, soon = addDays(today, 1);
  const alerts: Alert[] = [];

  const { results: work } = await db.prepare("SELECT id, title, due_date, status FROM tasks WHERE assignee_id = ? AND due_date <> '' AND due_date <= ? AND status NOT IN ('Published', 'Completed')").bind(m.id, soon).all<Record<string, string>>();
  for (const t of work) alerts.push({ key: `task:${t.id}:${t.due_date}`, kind: t.due_date < today ? 'Overdue work' : 'Work due', title: t.title, detail: t.status, date: t.due_date, link: 'team' });
  if (isAdmin(m)) {
    const { results } = await db.prepare("SELECT id, title, due_date, updated_at FROM tasks WHERE status = 'Ready for review'").all<Record<string, string>>();
    for (const t of results) alerts.push({ key: `review:${t.id}:${t.updated_at}`, kind: 'Ready for review', title: t.title, detail: 'Waiting for approval', date: t.due_date || t.updated_at.slice(0, 10), link: 'team' });
  }
  if (hasDivision(m, 'marketing')) {
    const [contacts, opps, programs] = await db.batch<Record<string, string>>([
      db.prepare("SELECT id, name, next_action, follow_up FROM mk_contacts WHERE owner_id = ? AND status = 'Active' AND follow_up <> '' AND follow_up <= ?").bind(m.id, today),
      db.prepare("SELECT id, title, next_action, follow_up FROM mk_opportunities WHERE owner_id = ? AND stage NOT IN ('Won', 'Lost') AND follow_up <> '' AND follow_up <= ?").bind(m.id, today),
      db.prepare("SELECT id, provider, renewal_date, visibility, account_owner_id, created_by FROM programs WHERE status IN ('Active', 'Trial') AND renewal_date BETWEEN ? AND ?").bind(addDays(today, -7), addDays(today, 30)),
    ]);
    for (const x of contacts.results) alerts.push({ key: `contact:${x.id}:${x.follow_up}`, kind: 'Follow-up', title: x.name, detail: x.next_action, date: x.follow_up, link: 'follow-ups' });
    for (const x of opps.results) alerts.push({ key: `opportunity:${x.id}:${x.follow_up}`, kind: 'Follow-up', title: x.title, detail: x.next_action, date: x.follow_up, link: 'follow-ups' });
    for (const x of programs.results) if (canSeeProgram(m, x.visibility) && (isAdmin(m) || x.account_owner_id === m.id || x.created_by === m.id))
      alerts.push({ key: `renewal:${x.id}:${x.renewal_date}`, kind: 'Program renewal', title: x.provider, detail: x.renewal_date < today ? 'Renewal date has passed' : 'Renews soon', date: x.renewal_date, link: 'programs' });
  }
  if (hasFirm(m)) {
    const { results } = await db.prepare("SELECT id, name, follow_up, next_action, data FROM pncs WHERE assigned_staff_id = ? AND status NOT IN ('Retained', 'Referred', 'Not retained', 'Closed')").bind(m.id).all<Record<string, string>>();
    for (const p of results) {
      if (p.follow_up && p.follow_up <= today) alerts.push({ key: `pnc:${p.id}:${p.follow_up}`, kind: 'PNC follow-up', title: p.name, detail: p.next_action, date: p.follow_up, link: `pnc/${p.id}` });
      const d = JSON.parse(p.data || '{}') as Record<string, string>;
      for (const [k, label] of [['limitationDate', 'Limitation date'], ['noticeDate', 'Notice date']] as const)
        if (d[k] && d[k] >= today && d[k] <= addDays(today, 30)) alerts.push({ key: `pnc-${k}:${p.id}:${d[k]}`, kind: label, title: p.name, detail: 'Within 30 days', date: d[k], link: `pnc/${p.id}` });
    }
  }
  // Missing staff updates: daily from 5 p.m. New York on weekdays; weekly from Friday 5 p.m.
  if (due.daily || due.weekly) {
    const { results } = await db.prepare("SELECT kind, period_start FROM staff_reports WHERE member_id = ? AND scope = 'general' AND status = 'Submitted' AND period_start IN (?, ?)").bind(m.id, today, due.weekStart).all<{ kind: string; period_start: string }>();
    if (due.daily && !results.some(r => r.kind === 'daily' && r.period_start === today))
      alerts.push({ key: `report:daily:${today}`, kind: 'Staff update', title: 'Submit today’s daily update', detail: 'Due by end of day', date: today, link: 'updates' });
    if (due.weekly && !results.some(r => r.kind === 'weekly' && r.period_start === due.weekStart))
      alerts.push({ key: `report:weekly:${due.weekStart}`, kind: 'Staff update', title: 'Submit this week’s update', detail: `Week of ${due.weekStart}`, date: today, link: 'updates' });
  }
  const { results: rem } = await db.prepare("SELECT id, title, notes, due_date, scope FROM reminders WHERE assignee_id = ? AND status = 'Open' AND due_date <= ?").bind(m.id, today).all<Record<string, string>>();
  for (const r of rem) if (r.scope !== 'firm' || hasFirm(m)) alerts.push({ key: `reminder:${r.id}`, kind: 'Reminder', title: r.title, detail: r.notes, date: r.due_date, link: 'attention' });

  const { results: states } = await db.prepare('SELECT alert_key, state, snooze_until FROM alert_states WHERE member_id = ?').bind(m.id).all<{ alert_key: string; state: string; snooze_until: string }>();
  const byKey = new Map(states.map(s => [s.alert_key, s]));
  // Snoozes expire by business date: on the snooze date the alert comes back.
  const shown = alerts.filter(a => {
    const s = byKey.get(a.key);
    if (s?.state === 'dismissed') return false;
    if (s?.state === 'snoozed' && s.snooze_until > today) return false;
    a.read = s?.state === 'read';
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
  return c.json({ today, alerts: shown, hidden: alerts.length - shown.length });
});

attention.post('/attention/state', async c => {
  const m = c.get('member');
  const v = await body(c, z.object({ key: z.string().min(3).max(300), state: z.enum(['read', 'dismissed', 'snoozed', 'clear']), snoozeUntil: dateStr.optional() }));
  const today = reportAlertsDue().today;
  if (v.state === 'snoozed' && (!v.snoozeUntil || v.snoozeUntil <= today)) fail(400, 'Snooze until a later date.');
  if (v.state === 'clear') await c.env.DB.prepare('DELETE FROM alert_states WHERE member_id = ? AND alert_key = ?').bind(m.id, v.key).run();
  else await c.env.DB.prepare(`INSERT INTO alert_states (member_id, alert_key, state, snooze_until, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (member_id, alert_key) DO UPDATE SET state = excluded.state, snooze_until = excluded.snooze_until, updated_at = excluded.updated_at`)
    .bind(m.id, v.key, v.state, v.state === 'snoozed' ? v.snoozeUntil : '', nowIso()).run();
  return c.json({ ok: true });
});

/* ---------------- Reminders ---------------- */
attention.get('/reminders', async c => {
  const m = c.get('member');
  const { results } = await c.env.DB.prepare(`SELECT r.*, a.name AS assignee_name, cr.name AS creator_name FROM reminders r JOIN members a ON a.id = r.assignee_id JOIN members cr ON cr.id = r.creator_id
    WHERE (r.assignee_id = ?1 OR r.creator_id = ?1) AND (r.status = 'Open' OR r.completed_at >= ?2) ORDER BY r.status = 'Done', r.due_date LIMIT 500`)
    .bind(m.id, new Date(Date.now() - 14 * 86400000).toISOString()).all<Record<string, unknown>>();
  return c.json({ reminders: rowsToApi(results.filter(r => r.scope !== 'firm' || hasFirm(m))) });
});

attention.post('/reminders', async c => {
  const m = c.get('member'), db = c.env.DB;
  const v = await body(c, z.object({ title: z.string().trim().min(1, 'is required').max(200), notes: text(2000), dueDate: dateStr, assigneeId: z.string().min(1).nullable().default(null), scope: z.enum(['general', 'firm']).default('general') }));
  const assigneeId = v.assigneeId || m.id;
  // Non-administrators create reminders for themselves only.
  if (assigneeId !== m.id && !isAdmin(m)) fail(403, 'You can create reminders for yourself only.');
  if (v.scope === 'firm' && !hasFirm(m)) fail(403, 'Firm reminders need JD&Co Law Firm access.');
  // Firm reminders need firm access for both the creator and the assignee.
  await checkStaff(db, assigneeId, v.scope === 'firm' ? 'jdco' : null, 'assignee');
  const id = newId(), t = nowIso();
  await db.prepare("INSERT INTO reminders (id, title, notes, due_date, assignee_id, creator_id, scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?)")
    .bind(id, v.title, v.notes, v.dueDate, assigneeId, m.id, v.scope, t, t).run();
  await audit(c, 'Created reminder', v.title, v.scope === 'firm' ? 'firm' : 'general');
  return c.json({ id }, 201);
});

attention.post('/reminders/:id/complete', async c => {
  const m = c.get('member'), db = c.env.DB;
  const v = await body(c, z.object({ rev }));
  const r = await db.prepare('SELECT * FROM reminders WHERE id = ?').bind(c.req.param('id')).first<Record<string, string>>();
  if (!r || (r.assignee_id !== m.id && r.creator_id !== m.id) || (r.scope === 'firm' && !hasFirm(m))) fail(404, 'Reminder not found.');
  if (r!.status === 'Done') fail(409, 'This reminder is already complete.');
  const res = await db.prepare("UPDATE reminders SET status = 'Done', completed_by = ?, completed_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ? AND status = 'Open'")
    .bind(m.id, nowIso(), nowIso(), r!.id, v.rev).run();
  if (!res.meta.changes) fail(409, 'This reminder was changed or completed since you opened it. Refresh and try again.');
  await audit(c, 'Completed reminder', r!.title, r!.scope === 'firm' ? 'firm' : 'general');
  return c.json({ ok: true });
});
