import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ADMIN_TASK_STATUSES, BRANDS, DONE_TASK_STATUSES, PRIORITIES, TASK_STATUSES, WORK_TYPES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { checkStaff, hasDivision, hasFirm, isAdmin } from '../policy';
import { assertUpdated, audit, body, fail, httpsUrl, newId, nowIso, optDate, rev, rowsToApi, text } from '../util';

/** Team workspace (general team work and content, open to every active staff member) and the shared team calendar. */
export const team = new Hono<AppEnv>();

/* ---------------- Team work ---------------- */
const taskInput = z.object({
  title: z.string().trim().min(1, 'is required').max(200), brand: z.union([z.enum(BRANDS), z.literal('')]).default(''),
  workType: z.union([z.enum(WORK_TYPES), z.literal('')]).default(''),
  // Everyone the work is assigned to. A single assigneeId (the older form) is still accepted.
  assigneeIds: z.array(z.string().min(1)).max(25, 'can list up to 25 people').optional(), assigneeId: z.string().min(1).nullable().optional(),
  dueDate: optDate, priority: z.enum(PRIORITIES).default('Normal'), brief: text(4000), creativeLink: httpsUrl, publishedLink: httpsUrl,
  status: z.enum(TASK_STATUSES), campaignId: z.string().min(1).nullable().default(null),
});
type TaskInput = z.infer<typeof taskInput>;

/** The people a save assigns, in the order chosen, without repeats. */
const assigneesOf = (v: TaskInput) => [...new Set(v.assigneeIds ?? (v.assigneeId ? [v.assigneeId] : []))];

/**
 * `people` is who the save assigns; `already` is who was on the item before. Newly added people must be active staff;
 * someone already assigned whose access was later switched off can stay (or be removed) without blocking the save.
 */
async function checkTask(c: Context<AppEnv>, v: TaskInput, people: string[], from: string | null, fromCampaign: string | null = null, already: string[] = []) {
  const m = c.get('member');
  // Approval and publishing are administrator decisions, and only administrators can take a task back out of them.
  if (!isAdmin(m) && v.status !== from && (ADMIN_TASK_STATUSES.includes(v.status) || (from && ADMIN_TASK_STATUSES.includes(from))))
    fail(403, 'Only an administrator can approve or publish work, or change work that’s already approved or published.');
  if (v.status === 'Published' && !v.publishedLink) fail(400, 'Add the published link.');
  for (const id of people) if (!already.includes(id)) await checkStaff(c.env.DB, id, null, 'assignee');
  if (v.campaignId && v.campaignId !== fromCampaign) {
    if (!hasDivision(m, 'marketing')) fail(403, 'Linking work to a campaign needs Marketing access.');
    if (!(await c.env.DB.prepare('SELECT 1 FROM campaigns WHERE id = ?').bind(v.campaignId).first())) fail(400, 'Choose an existing campaign.');
  }
}

team.get('/tasks', async c => {
  const m = c.get('member');
  const db = c.env.DB;
  const [{ results }, { results: people }] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT t.*, ap.name AS approved_by_name, ca.name AS campaign_name FROM tasks t
      LEFT JOIN members ap ON ap.id = t.approved_by LEFT JOIN campaigns ca ON ca.id = t.campaign_id
      ORDER BY t.status IN ('Published', 'Completed'), t.due_date = '', t.due_date, t.created_at LIMIT 5000`),
    db.prepare('SELECT ta.task_id, m.id, m.name FROM task_assignees ta JOIN members m ON m.id = ta.member_id ORDER BY ta.task_id, ta.position, m.name'),
  ]);
  const byTask = new Map<string, { id: string; name: string }[]>();
  for (const p of people) {
    const list = byTask.get(String(p.task_id)) ?? [];
    list.push({ id: String(p.id), name: String(p.name) });
    byTask.set(String(p.task_id), list);
  }
  // Campaign names are Marketing information.
  const marketing = hasDivision(m, 'marketing');
  const tasks = rowsToApi<Record<string, unknown>>(results.map(r => (marketing ? r : { ...r, campaign_id: null, campaign_name: null }))).map(t => {
    const assignees = byTask.get(String(t.id)) ?? [];
    const { assigneeId: _first, ...rest } = t;
    return { ...rest, assignees, assigneeIds: assignees.map(a => a.id) };
  });
  return c.json({ tasks });
});

team.post('/tasks', async c => {
  const v = await body(c, taskInput);
  const people = assigneesOf(v);
  await checkTask(c, v, people, null);
  const id = newId(), t = nowIso(), me = c.get('member').id, db = c.env.DB;
  const approved = ADMIN_TASK_STATUSES.includes(v.status);
  // tasks.assignee_id keeps the first person for older readers; task_assignees is the full list.
  await db.batch([
    db.prepare(`INSERT INTO tasks (id, title, brand, work_type, assignee_id, due_date, priority, brief, creative_link, published_link, status, campaign_id, approved_by, approved_at, completed_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, v.title, v.brand, v.workType, people[0] ?? null, v.dueDate, v.priority, v.brief, v.creativeLink, v.publishedLink, v.status, v.campaignId,
        approved ? me : null, approved ? t : null, DONE_TASK_STATUSES.includes(v.status) ? t : null, me, t, t),
    ...people.map((mid, i) => db.prepare('INSERT INTO task_assignees (task_id, member_id, position) VALUES (?, ?, ?)').bind(id, mid, i)),
  ]);
  await audit(c, 'Added team work', v.title);
  return c.json({ id }, 201);
});

team.patch('/tasks/:id', async c => {
  const v = await body(c, taskInput.extend({ rev }));
  const m = c.get('member'), id = c.req.param('id'), db = c.env.DB;
  const cur = await db.prepare('SELECT status, campaign_id, approved_by, approved_at, completed_at FROM tasks WHERE id = ?').bind(id).first<Record<string, string | null>>();
  if (!cur) fail(404, 'Work item not found.');
  // Staff without Marketing access can't see the campaign link, so keep it as it was.
  if (!hasDivision(m, 'marketing')) v.campaignId = cur!.campaign_id;
  const already = (await db.prepare('SELECT member_id FROM task_assignees WHERE task_id = ? ORDER BY position').bind(id).all<{ member_id: string }>()).results.map(x => x.member_id);
  // A save that leaves the assignees out altogether keeps the ones already there.
  const people = v.assigneeIds === undefined && v.assigneeId === undefined ? already : assigneesOf(v);
  await checkTask(c, v, people, cur!.status, cur!.campaign_id, already);
  const t = nowIso();
  const approving = v.status === 'Approved' && cur!.status !== 'Approved';
  const approvedBy = approving ? m.id : ADMIN_TASK_STATUSES.includes(v.status) ? cur!.approved_by : null;
  const approvedAt = approving ? t : ADMIN_TASK_STATUSES.includes(v.status) ? cur!.approved_at : null;
  const completedAt = DONE_TASK_STATUSES.includes(v.status) ? (cur!.completed_at ?? t) : null;
  // One transaction. The assignee list is only replaced when this save's update went through
  // (the row now carries this save's rev and timestamp), so a refused stale save changes nobody's assignment.
  const mine = '(SELECT 1 FROM tasks WHERE id = ? AND rev = ? AND updated_at = ?)';
  const [r] = await db.batch([
    db.prepare(`UPDATE tasks SET title = ?, brand = ?, work_type = ?, assignee_id = ?, due_date = ?, priority = ?, brief = ?, creative_link = ?, published_link = ?, status = ?, campaign_id = ?,
      approved_by = ?, approved_at = ?, completed_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND rev = ?`)
      .bind(v.title, v.brand, v.workType, people[0] ?? null, v.dueDate, v.priority, v.brief, v.creativeLink, v.publishedLink, v.status, v.campaignId, approvedBy ?? null, approvedAt ?? null, completedAt, t, id, v.rev),
    db.prepare(`DELETE FROM task_assignees WHERE task_id = ? AND EXISTS ${mine}`).bind(id, id, v.rev + 1, t),
    ...people.map((mid, i) => db.prepare(`INSERT INTO task_assignees (task_id, member_id, position) SELECT ?, ?, ? WHERE EXISTS ${mine}`).bind(id, mid, i, id, v.rev + 1, t)),
  ]);
  assertUpdated(r, 'This work item');
  await audit(c, v.status !== cur!.status ? `Moved work to ${v.status}` : 'Updated team work', v.title);
  return c.json({ ok: true });
});

/* ---------------- Team calendar ---------------- */
// Combines campaign dates, work deadlines and marketing follow-ups. Firm PNC dates are opt-in and need JD&Co access.
team.get('/calendar', async c => {
  const m = c.get('member'), db = c.env.DB;
  const month = c.req.query('month') || '';
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'month must be YYYY-MM.');
  const includeFirm = c.req.query('includeFirm') === '1';
  if (includeFirm && !hasFirm(m)) fail(403, 'Firm dates need JD&Co Law Firm access.');
  const from = `${month}-01`, to = `${month}-31`;
  type Item = { date: string; kind: string; title: string; detail: string; link: string };
  const items: Item[] = [];
  const { results: tasks } = await db.prepare(`SELECT t.id, t.title, t.due_date, t.status,
      (SELECT group_concat(name, ', ') FROM (SELECT m.name FROM task_assignees ta JOIN members m ON m.id = ta.member_id WHERE ta.task_id = t.id ORDER BY ta.position, m.name)) AS assignees
    FROM tasks t WHERE t.due_date BETWEEN ? AND ?`).bind(from, to).all<Record<string, string>>();
  for (const t of tasks) items.push({ date: t.due_date, kind: 'Work', title: t.title, detail: [t.status, t.assignees].filter(Boolean).join(' · '), link: 'team' });
  if (hasDivision(m, 'marketing')) {
    const [camps, contacts, opps] = await db.batch<Record<string, string>>([
      db.prepare('SELECT id, name, start_date, end_date, status FROM campaigns WHERE (start_date BETWEEN ?1 AND ?2) OR (end_date BETWEEN ?1 AND ?2)').bind(from, to),
      db.prepare("SELECT id, name, next_action, follow_up FROM mk_contacts WHERE status = 'Active' AND follow_up BETWEEN ? AND ?").bind(from, to),
      db.prepare("SELECT id, title, next_action, follow_up FROM mk_opportunities WHERE stage NOT IN ('Won', 'Lost') AND follow_up BETWEEN ? AND ?").bind(from, to),
    ]);
    for (const x of camps.results) {
      if (x.start_date >= from && x.start_date <= to) items.push({ date: x.start_date, kind: 'Campaign starts', title: x.name, detail: x.status, link: `campaign/${x.id}` });
      if (x.end_date >= from && x.end_date <= to) items.push({ date: x.end_date, kind: 'Campaign ends', title: x.name, detail: x.status, link: `campaign/${x.id}` });
    }
    for (const x of contacts.results) items.push({ date: x.follow_up, kind: 'Follow-up', title: x.name, detail: x.next_action, link: 'follow-ups' });
    for (const x of opps.results) items.push({ date: x.follow_up, kind: 'Follow-up', title: x.title, detail: x.next_action, link: 'follow-ups' });
  }
  if (includeFirm) {
    const { results: pncs } = await db.prepare("SELECT id, name, follow_up, next_action, data FROM pncs WHERE status NOT IN ('Retained', 'Referred', 'Not retained', 'Closed')").all<Record<string, string>>();
    for (const p of pncs) {
      if (p.follow_up >= from && p.follow_up <= to) items.push({ date: p.follow_up, kind: 'PNC follow-up', title: p.name, detail: p.next_action, link: `pnc/${p.id}` });
      const d = JSON.parse(p.data || '{}') as Record<string, string>;
      for (const [k, label] of [['limitationDate', 'Limitation date'], ['noticeDate', 'Notice date']] as const)
        if (d[k] && d[k] >= from && d[k] <= to) items.push({ date: d[k], kind: label, title: p.name, detail: 'Entered by staff; verify before relying on it', link: `pnc/${p.id}` });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return c.json({ month, items });
});
