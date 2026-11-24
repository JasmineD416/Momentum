import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/worker/db';
import { applyMigrations } from '../src/worker/migrate';
import { app } from '../src/worker/index';
import { env } from './env';

// Team work with several assignees. Made-up people only.
const OWNER = 'owner@example.test';
type Json = Record<string, any>;

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { 'x-dev-user': user, 'content-type': 'application/json', origin: 'http://localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  const data = (res.headers.get('content-type') || '').includes('json') ? ((await res.json()) as Json) : ({} as Json);
  return { status: res.status, data };
}
const get = (u: string, p: string) => call(u, 'GET', p);
const post = (u: string, p: string, b: unknown) => call(u, 'POST', p, b);
const patch = (u: string, p: string, b: unknown) => call(u, 'PATCH', p, b);
const put = (u: string, p: string, b: unknown) => call(u, 'PUT', p, b);

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

let seq = 0;
async function addMember(prefix: string) {
  const email = `as-${prefix}-${++seq}@example.test`;
  const r = await post(OWNER, '/api/members', { name: `${prefix} ${seq}`, email, role: 'Member', divisions: [] });
  expect(r.status).toBe(201);
  return { id: r.data.id as string, email, name: `${prefix} ${seq}` };
}
const task = async (user: string, id: string) => ((await get(user, '/api/tasks')).data.tasks as Json[]).find(t => t.id === id)!;
const work = (over: Json = {}) => ({ title: 'Shared newsletter', status: 'In progress', ...over });

let a: Awaited<ReturnType<typeof addMember>>, b: typeof a, c: typeof a;
beforeAll(async () => {
  await get(OWNER, '/api/me');
  a = await addMember('Ana'); b = await addMember('Ben'); c = await addMember('Cal');
});

describe('several assignees', () => {
  it('saves everyone chosen, in order, and shows their names', async () => {
    const r = await post(a.email, '/api/tasks', work({ assigneeIds: [b.id, a.id, b.id] }));
    expect(r.status).toBe(201);
    const t = await task(c.email, r.data.id);
    expect(t.assigneeIds).toEqual([b.id, a.id]); // repeats dropped
    expect(t.assignees.map((x: Json) => x.name)).toEqual([b.name, a.name]);
    expect(t).not.toHaveProperty('assigneeId');
  });

  it('only accepts active members as assignees', async () => {
    expect((await post(a.email, '/api/tasks', work({ assigneeIds: [a.id, 'no-such-person'] }))).status).toBe(400);
    const gone = await addMember('Gone');
    const row = (await get(OWNER, '/api/members')).data.members.find((m: Json) => m.id === gone.id);
    expect((await patch(OWNER, `/api/members/${gone.id}`, { name: gone.name, email: gone.email, role: 'Member', divisions: [], active: false, rev: row.rev })).status).toBe(200);
    expect((await post(a.email, '/api/tasks', work({ assigneeIds: [a.id, gone.id] }))).status).toBe(400);
  });

  it('lets an item keep someone whose access was later switched off, but not add them again', async () => {
    const d = await addMember('Dee');
    const r = await post(a.email, '/api/tasks', work({ title: 'Keeps Dee', assigneeIds: [a.id, d.id] }));
    const row = (await get(OWNER, '/api/members')).data.members.find((m: Json) => m.id === d.id);
    await patch(OWNER, `/api/members/${d.id}`, { name: d.name, email: d.email, role: 'Member', divisions: [], active: false, rev: row.rev });
    // Editing other details with Dee still on it works.
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Keeps Dee, renamed', assigneeIds: [a.id, d.id], rev: 1 }))).status).toBe(200);
    // Removing Dee works; putting Dee back does not.
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Keeps Dee, renamed', assigneeIds: [a.id], rev: 2 }))).status).toBe(200);
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Keeps Dee, renamed', assigneeIds: [a.id, d.id], rev: 3 }))).status).toBe(400);
  });

  it('replaces the list on edit, keeps it when a save leaves it out, and leaves it alone on a stale save', async () => {
    const r = await post(a.email, '/api/tasks', work({ title: 'Edit list', assigneeIds: [a.id] }));
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Edit list', assigneeIds: [b.id, c.id], rev: 1 }))).status).toBe(200);
    expect((await task(a.email, r.data.id)).assigneeIds).toEqual([b.id, c.id]);
    // Leaving the assignees out keeps them.
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Edit list (renamed)', rev: 2 }))).status).toBe(200);
    expect((await task(a.email, r.data.id)).assigneeIds).toEqual([b.id, c.id]);
    // A stale save is refused and changes nobody's assignment.
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Edit list', assigneeIds: [a.id], rev: 1 }))).status).toBe(409);
    expect((await task(a.email, r.data.id)).assigneeIds).toEqual([b.id, c.id]);
    // An empty list unassigns everyone.
    expect((await patch(a.email, `/api/tasks/${r.data.id}`, work({ title: 'Edit list', assigneeIds: [], rev: 3 }))).status).toBe(200);
    expect((await task(a.email, r.data.id)).assignees).toEqual([]);
  });

  it('still accepts a single assigneeId from older screens', async () => {
    const r = await post(a.email, '/api/tasks', work({ title: 'Old style', assigneeId: c.id }));
    expect((await task(a.email, r.data.id)).assigneeIds).toEqual([c.id]);
  });

  it('sends due-date alerts to every assignee and no one else', async () => {
    const e = await addMember('Eve'), f = await addMember('Fay'), g = await addMember('Gil');
    await post(e.email, '/api/tasks', work({ title: 'Alert for two', assigneeIds: [e.id, f.id], dueDate: addDays(today(), -1) }));
    const has = async (u: string) => ((await get(u, '/api/attention')).data.alerts as Json[]).some(x => x.title === 'Alert for two' && x.kind === 'Overdue work');
    expect(await has(e.email)).toBe(true);
    expect(await has(f.email)).toBe(true);
    expect(await has(g.email)).toBe(false);
  });

  it('counts the work for every assignee in their staff updates', async () => {
    const h = await addMember('Hal'), i = await addMember('Ivy');
    const r = await post(h.email, '/api/tasks', work({ title: 'Counted for both', assigneeIds: [h.id, i.id], dueDate: today() }));
    await patch(h.email, `/api/tasks/${r.data.id}`, work({ title: 'Counted for both', status: 'Completed', assigneeIds: [h.id, i.id], dueDate: today(), rev: 1 }));
    for (const u of [h, i]) {
      const s = await put(u.email, '/api/reports/mine', { kind: 'daily', scope: 'general', date: today(), completed: 'Example', inProgress: '', blockers: '', decisions: '', nextPriorities: '' });
      expect(s.status).toBe(201);
      const rep = (await get(u.email, `/api/reports/mine?kind=daily&scope=general&date=${today()}`)).data.report;
      expect(rep.counters.workCompleted).toBe(1);
    }
  });

  it('lists every assignee on the team calendar', async () => {
    const month = '2031-03';
    await post(a.email, '/api/tasks', work({ title: 'Calendar pair', assigneeIds: [a.id, b.id], dueDate: `${month}-10` }));
    const item = ((await get(a.email, `/api/calendar?month=${month}`)).data.items as Json[]).find(x => x.title === 'Calendar pair');
    expect(item?.detail).toBe(`In progress · ${a.name}, ${b.name}`);
  });
});

describe('moving existing work to the new assignee list', () => {
  it('keeps each existing item’s assignee', () => {
    const files = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();
    const load = (names: string[]) => names.map(name => ({ name, sql: readFileSync(join('migrations', name), 'utf8') }));
    const db = new Database(':memory:');
    applyMigrations(db, load(files.filter(f => f < '0006')));
    const t = '2026-01-01T00:00:00Z';
    db.raw.exec(`INSERT INTO members (id, email, name, role, divisions, active, created_at, updated_at) VALUES ('m1', 'one@example.test', 'One', 'Member', '[]', 1, '${t}', '${t}')`);
    db.raw.exec(`INSERT INTO tasks (id, title, assignee_id, status, created_at, updated_at) VALUES ('t1', 'Had one', 'm1', 'Planned', '${t}', '${t}'), ('t2', 'Had none', NULL, 'Planned', '${t}', '${t}')`);
    expect(applyMigrations(db, load(files))).toContain('0006_task_assignees.sql');
    expect(db.raw.prepare('SELECT task_id, member_id FROM task_assignees ORDER BY task_id').all().map(r => ({ ...r }))).toEqual([{ task_id: 't1', member_id: 'm1' }]);
  });
});
