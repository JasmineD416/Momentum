import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { REPORT_FIELDS, REPORT_KINDS, REPORT_SCOPES } from '../../shared/constants';
import { periodBounds, reportPeriod } from '../../shared/time';
import type { AppEnv, Member } from '../env';
import { hasDivision, hasFirm, isAdmin, isOwner } from '../policy';
import { assertUpdated, audit, body, businessDate, dateStr, fail, memberFromRow, newId, nowIso, rev, text, toApi } from '../util';

/**
 * Daily and weekly staff updates. Each person writes only their own. Draft text is private to its author; administrators
 * review submitted reports within their permissions and see only the status of other people's drafts.
 */
export const reports = new Hono<AppEnv>();

type Kind = (typeof REPORT_KINDS)[number];
type Scope = (typeof REPORT_SCOPES)[number];

function periodQuery(c: Context<AppEnv>) {
  const kind = c.req.query('kind') as Kind, scope = (c.req.query('scope') || 'general') as Scope;
  if (!REPORT_KINDS.includes(kind)) fail(400, 'kind must be daily or weekly.');
  if (!REPORT_SCOPES.includes(scope)) fail(400, 'scope must be general or firm.');
  const date = c.req.query('date') || businessDate();
  if (!dateStr.safeParse(date).success) fail(400, 'date must be YYYY-MM-DD.');
  return { kind, scope, date, period: reportPeriod(kind, date) };
}
/** Firm reports are separate and need JD&Co access. */
function requireScope(m: Member, scope: Scope) {
  if (scope === 'firm' && !hasFirm(m)) fail(403, 'Firm reports need JD&Co Law Firm access.');
}

/** Owner reviews everyone; an administrator reviews ordinary Members, and firm reports only with JD&Co access. Nobody reviews their own. */
export const canReview = (actor: Member, author: { id: string; role: string }, scope: string) =>
  isAdmin(actor) && actor.id !== author.id && (scope !== 'firm' || hasFirm(actor)) && (isOwner(actor) || author.role === 'Member');

const out = (r: Record<string, unknown>) => ({ ...toApi(r), counters: JSON.parse(String(r.counters || '{}')) });

/** Activity counters are a snapshot taken when the report is saved; staff write the report itself. */
async function counters(db: D1Database, m: Member, scope: Scope, start: string, end: string) {
  const { from, to } = periodBounds(start, end);
  const n = async (sql: string, ...args: unknown[]) => Number((await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0);
  const res: Record<string, number> = {
    workCompleted: await n('SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND completed_at >= ? AND completed_at < ?', m.id, from, to),
    workDue: await n("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND due_date BETWEEN ? AND ? AND status NOT IN ('Published', 'Completed')", m.id, start, end),
  };
  if (scope === 'general' && hasDivision(m, 'marketing'))
    res.marketingActivities = await n("SELECT COUNT(*) AS n FROM mk_activities WHERE actor_id = ? AND kind = 'Activity' AND created_at >= ? AND created_at < ?", m.id, from, to);
  if (scope === 'firm') {
    res.pncAttempts = await n('SELECT COUNT(*) AS n FROM attempts WHERE actor_id = ? AND created_at >= ? AND created_at < ?', m.id, from, to);
    res.checklistCompleted = await n('SELECT COUNT(*) AS n FROM checklist WHERE completed_by = ? AND completed_at >= ? AND completed_at < ?', m.id, from, to);
  }
  return res;
}

/* ---------------- My report ---------------- */
reports.get('/mine', async c => {
  const m = c.get('member');
  const q = periodQuery(c);
  requireScope(m, q.scope);
  const row = await c.env.DB.prepare('SELECT r.*, rv.name AS reviewed_by_name FROM staff_reports r LEFT JOIN members rv ON rv.id = r.reviewed_by WHERE r.member_id = ? AND r.kind = ? AND r.scope = ? AND r.period_start = ?')
    .bind(m.id, q.kind, q.scope, q.period.start).first<Record<string, unknown>>();
  return c.json({ period: q.period, report: row ? out(row) : null });
});

const reportInput = z.object({
  kind: z.enum(REPORT_KINDS), scope: z.enum(REPORT_SCOPES), date: dateStr,
  completed: text(8000), inProgress: text(8000), blockers: text(8000), decisions: text(8000), nextPriorities: text(8000),
  submit: z.boolean().default(false), rev: rev.optional(),
});

reports.put('/mine', async c => {
  const m = c.get('member'), db = c.env.DB;
  const v = await body(c, reportInput);
  requireScope(m, v.scope);
  if (v.date > businessDate()) fail(400, 'Reports can’t be written for a future period.');
  if (v.submit && !REPORT_FIELDS.some(([k]) => v[k])) fail(400, 'Write something before submitting.');
  const p = reportPeriod(v.kind, v.date);
  const snap = JSON.stringify(await counters(db, m, v.scope, p.start, p.end));
  const t = nowIso(), status = v.submit ? 'Submitted' : 'Draft';
  const cur = await db.prepare('SELECT id, status, submitted_at FROM staff_reports WHERE member_id = ? AND kind = ? AND scope = ? AND period_start = ?').bind(m.id, v.kind, v.scope, p.start).first<Record<string, string | null>>();
  const submittedAt = v.submit ? t : null;
  if (!cur) {
    if (v.rev) fail(409, 'This report was removed or changed since you opened it. Refresh and try again.');
    const id = newId();
    try {
      await db.prepare(`INSERT INTO staff_reports (id, member_id, kind, scope, period_start, period_end, status, completed, in_progress, blockers, decisions, next_priorities, counters, submitted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, m.id, v.kind, v.scope, p.start, p.end, status, v.completed, v.inProgress, v.blockers, v.decisions, v.nextPriorities, snap, submittedAt, t, t).run();
    } catch (e) {
      if (/UNIQUE/.test(String(e))) fail(409, 'You already started this report in another window. Refresh and try again.');
      throw e;
    }
    await audit(c, v.submit ? 'Submitted staff report' : 'Saved staff report draft', `${m.name}: ${v.kind} ${p.start}`, v.scope === 'firm' ? 'firm' : 'general');
    return c.json({ id }, 201);
  }
  if (!v.rev) fail(409, 'This report already exists. Refresh to edit the saved version.');
  // Any edit clears the previous review, so a reviewer always sees what was actually reviewed.
  const r = await db.prepare(`UPDATE staff_reports SET status = ?, completed = ?, in_progress = ?, blockers = ?, decisions = ?, next_priorities = ?, counters = ?, submitted_at = ?,
      reviewed_by = NULL, reviewed_at = NULL, review_note = '', updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
    .bind(status, v.completed, v.inProgress, v.blockers, v.decisions, v.nextPriorities, snap, submittedAt, t, cur.id, v.rev).run();
  assertUpdated(r, 'This report');
  await audit(c, v.submit ? 'Submitted staff report' : 'Saved staff report draft', `${m.name}: ${v.kind} ${p.start}`, v.scope === 'firm' ? 'firm' : 'general');
  return c.json({ id: cur.id });
});

/* ---------------- Review (administrators) ---------------- */
reports.get('/team', async c => {
  const m = c.get('member'), db = c.env.DB;
  if (!isAdmin(m)) fail(403, 'Reviewing staff updates is for administrators.');
  const q = periodQuery(c);
  requireScope(m, q.scope);
  const { results: people } = await db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY name').all<Record<string, unknown>>();
  const { results: rows } = await db.prepare('SELECT r.*, rv.name AS reviewed_by_name FROM staff_reports r LEFT JOIN members rv ON rv.id = r.reviewed_by WHERE r.kind = ? AND r.scope = ? AND r.period_start = ?')
    .bind(q.kind, q.scope, q.period.start).all<Record<string, unknown>>();
  const team = people.map(memberFromRow).filter(p => (q.scope !== 'firm' || hasFirm(p)) && canReview(m, p, q.scope)).map(p => {
    const r = rows.find(x => x.member_id === p.id);
    // Drafts: status only, never the text.
    const report = r && r.status === 'Submitted' ? out(r) : null;
    return { memberId: p.id, name: p.name, title: p.title, status: r ? String(r.status) : 'Not started', report };
  });
  return c.json({ period: q.period, team });
});

async function visibleReport(c: Context<AppEnv>, id: string) {
  const m = c.get('member');
  const r = await c.env.DB.prepare('SELECT r.*, a.name AS author_name, a.role AS author_role, rv.name AS reviewed_by_name FROM staff_reports r JOIN members a ON a.id = r.member_id LEFT JOIN members rv ON rv.id = r.reviewed_by WHERE r.id = ?')
    .bind(id).first<Record<string, unknown>>();
  if (!r) fail(404, 'Report not found.');
  const own = r!.member_id === m.id;
  if (!own && !(r!.status === 'Submitted' && canReview(m, { id: String(r!.member_id), role: String(r!.author_role) }, String(r!.scope)))) fail(404, 'Report not found.');
  return r!;
}

reports.get('/:id', async c => c.json({ report: out(await visibleReport(c, c.req.param('id'))) }));

reports.post('/:id/review', async c => {
  const v = await body(c, z.object({ note: text(4000), rev }));
  const r = await visibleReport(c, c.req.param('id'));
  if (r.member_id === c.get('member').id) fail(403, 'Someone else reviews your report.');
  const res = await c.env.DB.prepare("UPDATE staff_reports SET reviewed_by = ?, reviewed_at = ?, review_note = ?, rev = rev + 1 WHERE id = ? AND rev = ? AND status = 'Submitted'")
    .bind(c.get('member').id, nowIso(), v.note, r.id, v.rev).run();
  assertUpdated(res, 'This report');
  await audit(c, 'Reviewed staff report', `${r.author_name}: ${r.kind} ${r.period_start}`, r.scope === 'firm' ? 'firm' : 'general');
  return c.json({ ok: true });
});

/** Plain-text recap to download. It isn't sent anywhere. */
reports.get('/:id/recap', async c => {
  const r = await visibleReport(c, c.req.param('id'));
  const counts = Object.entries(JSON.parse(String(r.counters || '{}')) as Record<string, number>).map(([k, n]) => `  ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${n}`);
  const period = r.kind === 'daily' ? String(r.period_start) : `${r.period_start} to ${r.period_end}`;
  const lines = [
    `Momentum ${r.kind} update (${r.scope === 'firm' ? 'JD&Co Law Firm' : 'general'})`, `${r.author_name} · ${period} · ${r.status}`, '',
    ...REPORT_FIELDS.flatMap(([k, label]) => [label.toUpperCase(), String(r[k.replace(/[A-Z]/g, x => '_' + x.toLowerCase())] || '—'), '']),
    'ACTIVITY SNAPSHOT (when saved)', ...(counts.length ? counts : ['  —']),
  ];
  if (r.reviewed_at) lines.push('', `Reviewed by ${r.reviewed_by_name} on ${String(r.reviewed_at).slice(0, 10)}${r.review_note ? `: ${r.review_note}` : ''}`);
  return new Response(lines.join('\r\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="momentum-${r.kind}-update-${r.period_start}.txt"`, 'cache-control': 'no-store' },
  });
});
