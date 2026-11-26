import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/worker/index';
import { env } from './env';

// Made-up people only.
const OWNER = 'owner@example.test';
const ADMIN = 'ann-admin@example.test';
const MK = 'ann-marketing@example.test';
const STAFF = 'ann-staff@example.test';
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
const post = (u: string, p: string, b: unknown = {}) => call(u, 'POST', p, b);
const patch = (u: string, p: string, b: unknown) => call(u, 'PATCH', p, b);
async function upload(user: string, claimId: string, bytes: Uint8Array, name = 'invoice.pdf', headers: Record<string, string> = {}) {
  const res = await app.request(`/api/claims/${claimId}/invoices`, {
    method: 'POST', body: bytes,
    headers: { 'x-dev-user': user, 'content-type': 'application/octet-stream', origin: 'http://localhost', 'x-file-name': encodeURIComponent(name), ...headers },
  }, env);
  return { status: res.status, data: (await res.json()) as Json };
}
const PDF = new TextEncoder().encode('%PDF-1.4\n% test invoice\n');
const alerts = async (u: string) => (await get(u, '/api/attention')).data.alerts as Json[];

beforeAll(async () => {
  await get(OWNER, '/api/me');
  expect((await post(OWNER, '/api/members', { name: 'Ann Admin', email: ADMIN, role: 'Administrator', divisions: [] })).status).toBe(201);
  expect((await post(OWNER, '/api/members', { name: 'Mia Marketing', email: MK, role: 'Member', divisions: ['marketing'] })).status).toBe(201);
  expect((await post(OWNER, '/api/members', { name: 'Sam Staff', email: STAFF, role: 'Member', divisions: [] })).status).toBe(201);
});

describe('Announcements', () => {
  it('lets only administrators post, and alerts everyone else until they read it', async () => {
    expect((await post(STAFF, '/api/announcements', { title: 'Nope' })).status).toBe(403);
    const r = await post(ADMIN, '/api/announcements', { title: 'Office closed Friday', body: 'Enjoy the long weekend.' });
    expect(r.status).toBe(201);
    expect((await get(STAFF, '/api/announcements/unread')).data.unread).toBe(1);
    expect((await get(ADMIN, '/api/announcements/unread')).data.unread).toBe(0);
    expect((await alerts(STAFF)).some(a => a.key === `announcement:${r.data.id}` && a.kind === 'New announcement')).toBe(true);

    const list = (await get(STAFF, '/api/announcements')).data;
    expect(list.announcements[0]).toMatchObject({ title: 'Office closed Friday', readAt: null, postedByName: 'Ann Admin' });
    expect(list.announcements[0].readCount).toBeUndefined();

    expect((await post(STAFF, `/api/announcements/${r.data.id}/read`)).status).toBe(200);
    expect((await get(STAFF, '/api/announcements/unread')).data.unread).toBe(0);
    expect((await alerts(STAFF)).some(a => a.key === `announcement:${r.data.id}`)).toBe(false);
    const reads = (await get(ADMIN, `/api/announcements/${r.data.id}/reads`)).data.people as Json[];
    expect(reads.find(p => p.name === 'Sam Staff')!.readAt).toBeTruthy();
    expect(reads.find(p => p.name === 'Mia Marketing')!.readAt).toBeNull();
    expect((await get(STAFF, `/api/announcements/${r.data.id}/reads`)).status).toBe(403);
  });

  it('counts marking the alert read in the attention centre as reading it', async () => {
    const r = await post(OWNER, '/api/announcements', { title: 'New printer' });
    expect((await post(MK, '/api/attention/state', { key: `announcement:${r.data.id}`, state: 'read' })).status).toBe(200);
    const mine = (await get(MK, '/api/announcements')).data.announcements as Json[];
    expect(mine.find(a => a.id === r.data.id)!.readAt).toBeTruthy();
  });

  it('hides archived announcements and refuses stale edits', async () => {
    const r = await post(ADMIN, '/api/announcements', { title: 'Old news' });
    expect((await patch(ADMIN, `/api/announcements/${r.data.id}`, { title: 'Old news', status: 'Archived', rev: 1 })).status).toBe(200);
    expect((await patch(ADMIN, `/api/announcements/${r.data.id}`, { title: 'Old news', rev: 1 })).status).toBe(409);
    expect(((await get(STAFF, '/api/announcements')).data.announcements as Json[]).some(a => a.id === r.data.id)).toBe(false);
    expect((await alerts(STAFF)).some(a => a.key === `announcement:${r.data.id}`)).toBe(false);
    await post(STAFF, '/api/announcements/read-all');
    expect((await get(STAFF, '/api/announcements/unread')).data.unread).toBe(0);
  });
});

describe('Expense claims', () => {
  const claim = (over: Json = {}) => ({ division: 'marketing', chargeDate: '2026-11-02', amountCents: 4599, currency: 'CAD', company: 'Example Design Co', payMethod: 'Credit card', cardType: 'Visa', cardLast4: '4242', description: 'Design subscription', notes: 'Monthly', ...over });

  it('records a card charge with only the type and last four digits', async () => {
    expect((await post(MK, '/api/claims', claim({ cardLast4: '4242424242424242' }))).status).toBe(400);
    expect((await post(MK, '/api/claims', claim({ cardType: '' }))).status).toBe(400);
    expect((await post(MK, '/api/claims', claim({ amountCents: 0 }))).status).toBe(400);
    expect((await post(MK, '/api/claims', claim({ company: '' }))).status).toBe(400);
    expect((await post(STAFF, '/api/claims', claim())).status).toBe(403); // no Marketing access
    const r = await post(MK, '/api/claims', claim());
    expect(r.status).toBe(201);
    const e = await post(MK, '/api/claims', claim({ payMethod: 'E-transfer', cardType: 'Visa', cardLast4: '9999', company: 'Example Printer' }));
    const mine = (await get(MK, '/api/claims')).data.claims as Json[];
    expect(mine.find(c => c.id === r.data.id)).toMatchObject({ cardType: 'Visa', cardLast4: '4242', status: 'Submitted', canReview: false });
    expect(mine.find(c => c.id === e.data.id)).toMatchObject({ payMethod: 'E-transfer', cardType: '', cardLast4: '' });
  });

  it('accepts PDF and photo invoices only, and only from the submitter', async () => {
    const id = (await post(MK, '/api/claims', claim({ company: 'Upload Test' }))).data.id;
    const up = await upload(MK, id, PDF, 'Nov invoice.pdf');
    expect(up.status).toBe(201);
    expect((await upload(MK, id, new TextEncoder().encode('<html><script>alert(1)</script>'), 'x.pdf')).status).toBe(415);
    expect((await upload(STAFF, id, PDF)).status).toBe(404);
    expect((await upload(MK, id, PDF, 'x.pdf', { origin: '' })).status).toBe(403);
    // Raw bodies are accepted on the upload route only.
    const other = await app.request('/api/claims', { method: 'POST', body: PDF, headers: { 'x-dev-user': MK, 'content-type': 'application/octet-stream', origin: 'http://localhost' } }, env);
    expect(other.status).toBe(415);

    const row = ((await get(MK, '/api/claims')).data.claims as Json[]).find(c => c.id === id)!;
    expect(row.files).toHaveLength(1);
    expect(row.files[0]).toMatchObject({ fileName: 'Nov invoice.pdf', contentType: 'application/pdf' });
    const file = await app.request(`/api/claims/${id}/invoices/${up.data.id}`, { headers: { 'x-dev-user': OWNER } }, env);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
    expect((await app.request(`/api/claims/${id}/invoices/${up.data.id}`, { headers: { 'x-dev-user': STAFF } }, env)).status).toBe(404);
  });

  it('shows claims only to the submitter and administrators who have the division', async () => {
    const id = (await post(MK, '/api/claims', claim({ company: 'Visibility Test' }))).data.id;
    const sees = async (u: string) => ((await get(u, '/api/claims')).data.claims as Json[]).some(c => c.id === id);
    expect(await sees(MK)).toBe(true);
    expect(await sees(OWNER)).toBe(true);
    expect(await sees(STAFF)).toBe(false);
    expect(await sees(ADMIN)).toBe(false); // administrator without Marketing
    const general = (await post(STAFF, '/api/claims', claim({ division: '', company: 'General Test' }))).data.id;
    expect(((await get(ADMIN, '/api/claims')).data.claims as Json[]).find(c => c.id === general)!.canReview).toBe(true);
    expect((await alerts(ADMIN)).some(a => a.key === `claim-review:${general}`)).toBe(true);
    expect((await alerts(ADMIN)).some(a => a.key === `claim-review:${id}`)).toBe(false);
  });

  it('lets administrators review, needs a reason to decline, and locks reviewed claims', async () => {
    const id = (await post(STAFF, '/api/claims', claim({ division: '', company: 'Review Test' }))).data.id;
    expect((await post(STAFF, `/api/claims/${id}/review`, { status: 'Approved', rev: 1 })).status).toBe(403);
    expect((await post(ADMIN, `/api/claims/${id}/review`, { status: 'Declined', rev: 1 })).status).toBe(400);
    expect((await post(ADMIN, `/api/claims/${id}/review`, { status: 'Approved', note: 'OK', rev: 1 })).status).toBe(200);
    expect((await patch(STAFF, `/api/claims/${id}`, { ...claim({ division: '' }), rev: 2 })).status).toBe(400);
    expect((await upload(STAFF, id, PDF)).status).toBe(400);
    expect((await post(STAFF, `/api/claims/${id}/withdraw`, { rev: 2 })).status).toBe(400);
    expect((await alerts(STAFF)).some(a => a.key === `claim-reviewed:${id}:Approved`)).toBe(true);
    expect((await post(ADMIN, `/api/claims/${id}/review`, { status: 'Reimbursed', rev: 2 })).status).toBe(200);
  });

  it('stops administrators other than the Owner reviewing their own claims', async () => {
    const id = (await post(ADMIN, '/api/claims', claim({ division: '', company: 'Own Claim' }))).data.id;
    expect((await post(ADMIN, `/api/claims/${id}/review`, { status: 'Approved', rev: 1 })).status).toBe(403);
    expect((await post(OWNER, `/api/claims/${id}/review`, { status: 'Approved', rev: 1 })).status).toBe(200);
  });

  it('lets the submitter edit and withdraw a claim before review', async () => {
    const id = (await post(MK, '/api/claims', claim({ company: 'Withdraw Test' }))).data.id;
    await upload(MK, id, PDF);
    expect((await patch(MK, `/api/claims/${id}`, { ...claim({ company: 'Withdraw Test', amountCents: 5000 }), rev: 1 })).status).toBe(200);
    expect((await patch(OWNER, `/api/claims/${id}`, { ...claim(), rev: 2 })).status).toBe(403);
    expect((await post(MK, `/api/claims/${id}/withdraw`, { rev: 2 })).status).toBe(200);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM team_expense_files WHERE expense_id = ?').bind(id).first('n')).toBe(0);
  });
});
