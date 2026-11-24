import { env } from './env';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIVISION_IDS } from '../src/shared/constants';
import { app } from '../src/worker/index';

const OWNER = 'owner@example.test';
type Json = Record<string, any>;

async function call(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { 'x-dev-user': user, 'content-type': 'application/json', origin: 'http://localhost', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? ((await res.json()) as Json) : ((await res.text()) as unknown as Json);
  return { status: res.status, data, res };
}
const get = (u: string, p: string) => call(u, 'GET', p);
const post = (u: string, p: string, b: unknown) => call(u, 'POST', p, b);
const patch = (u: string, p: string, b: unknown) => call(u, 'PATCH', p, b);

async function addMember(email: string, role: 'Member' | 'Administrator', divisions: string[], name = email.split('@')[0]) {
  const r = await post(OWNER, '/api/members', { name, email, role, divisions });
  expect(r.status).toBe(201);
  return r.data.id as string;
}
async function makeClientAndMatter(fileNumber = 'J2001', lastName = 'Testerson') {
  const cl = await post(OWNER, '/api/clients', { lastName, firstName: 'Pat', email: `${lastName.toLowerCase()}.${fileNumber.toLowerCase()}@example.test` });
  expect(cl.status).toBe(201);
  const mt = await post(OWNER, '/api/matters', { clientId: cl.data.id, fileNumber, caseType: 'Personal injury', lawyerId: 'counsel-jasmine-daya', status: 'Open' });
  expect(mt.status).toBe(201);
  return { clientId: cl.data.id as string, matterId: mt.data.id as string };
}

beforeEach(async () => {
  // First request by the configured owner email creates the Owner.
  await get(OWNER, '/api/me');
});

describe('sign-in and membership', () => {
  it('creates the Owner on first sign-in with every division', async () => {
    const r = await get(OWNER, '/api/me');
    expect(r.status).toBe(200);
    expect(r.data.member.role).toBe('Owner');
    expect(r.data.member.divisions).toContain('jdco');
  });
  it('denies people who are not members, and members whose access is off', async () => {
    expect((await get('stranger@example.test', '/api/me')).status).toBe(403);
    const id = await addMember('gone@example.test', 'Member', ['marketing']);
    const list = await get(OWNER, '/api/members');
    const rev = list.data.members.find((m: Json) => m.id === id).rev;
    expect((await patch(OWNER, `/api/members/${id}`, { name: 'Gone', email: 'gone@example.test', role: 'Member', divisions: ['marketing'], active: false, rev })).status).toBe(200);
    expect((await get('gone@example.test', '/api/me')).status).toBe(403);
  });
  it('only lets the configured email become Owner', async () => {
    expect((await get('someone@example.test', '/api/me')).status).toBe(403);
  });
  it('rejects cross-site and non-JSON writes', async () => {
    expect((await call(OWNER, 'PATCH', '/api/me', { title: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(OWNER, 'PATCH', '/api/me', { title: 'x' }, { 'content-type': 'text/plain' })).status).toBe(415);
  });
  it('never accepts the development sign-in stand-in on a real hostname', async () => {
    const res = await app.request('https://momentum.example.com/api/me', { headers: { 'x-dev-user': OWNER } }, env);
    expect(res.status).not.toBe(200);
  });
  it('marks private responses as not cacheable', async () => {
    const r = await get(OWNER, '/api/me');
    expect(r.res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('division access', () => {
  it('keeps JD&Co records from staff without JD&Co access, on every route', async () => {
    await addMember('mkt@example.test', 'Member', ['marketing']);
    const { matterId } = await makeClientAndMatter();
    for (const p of ['/api/clients', '/api/matters', `/api/matters/${matterId}/checklist`, '/api/pncs', '/api/counsel', '/api/expenses?scope=client', '/api/contacts?division=jdco'])
      expect((await get('mkt@example.test', p)).status, p).toBe(403);
    expect((await post('mkt@example.test', '/api/clients', { lastName: 'X' })).status).toBe(403);
  });
  it('lets JD&Co members in', async () => {
    await addMember('firm@example.test', 'Member', ['jdco']);
    expect((await get('firm@example.test', '/api/clients')).status).toBe(200);
  });
  it('does not apply JD&Co-only checks to other modules', async () => {
    await addMember('mkt5@example.test', 'Member', ['marketing']);
    expect((await get('mkt5@example.test', '/api/expenses?scope=marketing')).status).toBe(200);
    expect((await get('mkt5@example.test', '/api/contacts?division=marketing')).status).toBe(200);
    expect((await get('mkt5@example.test', '/api/summary')).status).toBe(200);
  });
  it('restricts JD Publishing and Office folders to their divisions', async () => {
    await addMember('mkt2@example.test', 'Member', ['marketing']);
    expect((await get('mkt2@example.test', '/api/folders/pl-series')).status).toBe(403);
    expect((await get('mkt2@example.test', '/api/folders/hr')).status).toBe(403);
    expect((await get('mkt2@example.test', '/api/contacts?division=accounting')).status).toBe(403);
  });
  it('hides firm activity from the audit log for non-firm staff', async () => {
    await makeClientAndMatter('J2002', 'Audited');
    await addMember('mkt3@example.test', 'Member', ['marketing']);
    const firmView = await get(OWNER, '/api/audit');
    const staffView = await get('mkt3@example.test', '/api/audit');
    expect(firmView.data.audit.some((a: Json) => a.scope === 'firm')).toBe(true);
    expect(staffView.data.audit.some((a: Json) => a.scope === 'firm')).toBe(false);
  });
});

describe('people and access rules', () => {
  it('stops administrators granting any division (Office included) or adding administrators', async () => {
    await addMember('admin@example.test', 'Administrator', ['marketing']);
    for (const d of DIVISION_IDS) {
      expect((await post('admin@example.test', '/api/members', { name: 'A', email: `a-${d}@example.test`, role: 'Member', divisions: [d] })).status, d).toBe(403);
    }
    expect((await post('admin@example.test', '/api/members', { name: 'C', email: 'c@example.test', role: 'Administrator', divisions: [] })).status).toBe(403);
    expect((await post('admin@example.test', '/api/members', { name: 'D', email: 'd@example.test', role: 'Member', divisions: [] })).status).toBe(201);
  });
  it('keeps the Office folders to people Jasmine gives Office access', async () => {
    await addMember('no-office@example.test', 'Member', ['marketing']);
    await addMember('office@example.test', 'Member', ['office']);
    expect((await get('no-office@example.test', '/api/folders/hr')).status).toBe(403);
    expect((await get('no-office@example.test', '/api/folders/sops')).status).toBe(403);
    expect((await get('office@example.test', '/api/folders/hr')).status).toBe(200);
  });
  it('ignores division changes from administrators and keeps what Jasmine granted', async () => {
    await addMember('admin2@example.test', 'Administrator', ['marketing']);
    const id = await addMember('nerissa@example.test', 'Member', ['marketing', 'jdco']);
    const rev = (await get(OWNER, '/api/members')).data.members.find((m: Json) => m.id === id).rev;
    const r = await patch('admin2@example.test', `/api/members/${id}`, { name: 'Nerissa', email: 'nerissa@example.test', role: 'Member', divisions: ['lawgirl'], active: true, rev });
    expect(r.status).toBe(200);
    const after = (await get(OWNER, '/api/members')).data.members.find((m: Json) => m.id === id);
    expect(after.divisions.sort()).toEqual(['jdco', 'marketing']);
  });
  it('only shows emails to administrators', async () => {
    await addMember('plain@example.test', 'Member', ['marketing']);
    const r = await get('plain@example.test', '/api/members');
    expect(r.data.members[0].email).toBeUndefined();
  });
});

describe('clients and matters', () => {
  it('enforces unique file numbers regardless of case', async () => {
    const { clientId } = await makeClientAndMatter('J3001');
    const r = await post(OWNER, '/api/matters', { clientId, fileNumber: 'j3001', caseType: 'Other', status: 'Open' });
    expect(r.status).toBe(409);
  });
  it('requires a closed date to close, and no closed date to stay open', async () => {
    const { clientId } = await makeClientAndMatter('J3002', 'Closer');
    expect((await post(OWNER, '/api/matters', { clientId, fileNumber: 'J3003', caseType: 'Other', status: 'Closed' })).status).toBe(400);
    expect((await post(OWNER, '/api/matters', { clientId, fileNumber: 'J3004', caseType: 'Other', status: 'Open', closed: '2026-01-01' })).status).toBe(400);
    expect((await post(OWNER, '/api/matters', { clientId, fileNumber: 'J3005', caseType: 'Other', status: 'Transferred', notes: 'Fees owed on settlement' })).status).toBe(201);
  });
  it('flags likely duplicate clients unless confirmed', async () => {
    await post(OWNER, '/api/clients', { lastName: 'Dupe', firstName: 'Ann', email: 'dupe@example.test' });
    expect((await post(OWNER, '/api/clients', { lastName: 'Other', email: 'dupe@example.test' })).status).toBe(409);
    expect((await post(OWNER, '/api/clients', { lastName: 'Other', email: 'dupe@example.test', confirmDuplicate: true })).status).toBe(201);
  });
  it('rejects stale edits', async () => {
    const { clientId } = await makeClientAndMatter('J3006', 'Stale');
    const ok = await patch(OWNER, `/api/clients/${clientId}`, { lastName: 'Stale', firstName: 'Pat', rev: 1 });
    expect(ok.status).toBe(200);
    expect((await patch(OWNER, `/api/clients/${clientId}`, { lastName: 'Stale2', rev: 1 })).status).toBe(409);
  });
});

describe('opening checklist', () => {
  it('starts once, needs notes to resolve, keeps attribution, and clears it on reopen', async () => {
    const { matterId } = await makeClientAndMatter('J4001', 'Check');
    expect((await post(OWNER, `/api/matters/${matterId}/checklist/start`, {})).data.added).toBe(8);
    expect((await post(OWNER, `/api/matters/${matterId}/checklist/start`, {})).data.added).toBe(0);
    let items = (await get(OWNER, `/api/matters/${matterId}/checklist`)).data.items;
    const conflicts = items.find((i: Json) => i.item === 'Conflicts');
    expect((await patch(OWNER, `/api/checklist/${conflicts.id}`, { status: 'Complete', rev: conflicts.rev })).status).toBe(400);
    expect((await patch(OWNER, `/api/checklist/${conflicts.id}`, { status: 'Complete', notes: 'Search clear', rev: conflicts.rev })).status).toBe(200);
    expect((await patch(OWNER, `/api/checklist/${conflicts.id}`, { status: 'Complete', notes: 'stale', rev: conflicts.rev })).status).toBe(409);
    items = (await get(OWNER, `/api/matters/${matterId}/checklist`)).data.items;
    const done = items.find((i: Json) => i.item === 'Conflicts');
    expect(done.completedByName).toBeTruthy();
    await patch(OWNER, `/api/checklist/${done.id}`, { status: 'In progress', notes: 'Reopened', rev: done.rev });
    const reopened = (await get(OWNER, `/api/matters/${matterId}/checklist`)).data.items.find((i: Json) => i.item === 'Conflicts');
    expect(reopened.completedBy).toBeNull();
  });
  it('only accepts active firm staff as assignees', async () => {
    const { matterId } = await makeClientAndMatter('J4002', 'Assign');
    await post(OWNER, `/api/matters/${matterId}/checklist/start`, {});
    const mkt = await addMember('mkt4@example.test', 'Member', ['marketing']);
    const item = (await get(OWNER, `/api/matters/${matterId}/checklist`)).data.items[0];
    expect((await patch(OWNER, `/api/checklist/${item.id}`, { status: 'In progress', assigneeId: mkt, rev: item.rev })).status).toBe(400);
  });
});

describe('PNC tracker', () => {
  it('requires verified legal dates and dated consent for referrals; changing lawyer clears consent', async () => {
    expect((await post(OWNER, '/api/pncs', { name: 'Sam Lee', status: 'New', data: { limitationDate: '2027-01-01' } })).status).toBe(400);
    const p = await post(OWNER, '/api/pncs', { name: 'Sam Lee', status: 'New', email: 'sam@example.test' });
    const id = p.data.id;
    const other = (await post(OWNER, '/api/counsel', { name: 'Avery Chen' })).data.id;
    expect((await patch(OWNER, `/api/pncs/${id}/referral`, { receivingLawyerId: other, markReferred: true, rev: 1 })).status).toBe(400);
    expect((await patch(OWNER, `/api/pncs/${id}/referral`, { receivingLawyerId: other, consentDate: '2026-10-20', rev: 1 })).status).toBe(200);
    expect((await get(OWNER, `/api/pncs/${id}/referral-summary`)).status).toBe(200);
    const r = await patch(OWNER, `/api/pncs/${id}/referral`, { receivingLawyerId: 'counsel-jasmine-daya', consentDate: '2026-10-20', rev: 2 });
    expect(r.data.consentCleared).toBe(true);
    expect((await get(OWNER, `/api/pncs/${id}/referral-summary`)).status).toBe(400);
  });
  it('logs attempts with the verified staff member and rejects future times', async () => {
    const id = (await post(OWNER, '/api/pncs', { name: 'Tia Fox', status: 'New' })).data.id;
    expect((await post(OWNER, `/api/pncs/${id}/attempts`, { at: new Date(Date.now() + 3600_000).toISOString(), method: 'Call', outcome: 'Reached' })).status).toBe(400);
    expect((await post(OWNER, `/api/pncs/${id}/attempts`, { at: new Date().toISOString(), method: 'Call', outcome: 'Reached' })).status).toBe(201);
    const d = (await get(OWNER, `/api/pncs/${id}`)).data;
    expect(d.pnc.status).toBe('Contacting');
    expect(d.attempts[0].actorName).toBe('Jasmine Daya');
  });
  it('converts to a client file only with a signed retainer, and asks about likely existing clients', async () => {
    await post(OWNER, '/api/clients', { lastName: 'Ray', firstName: 'Kim', email: 'kim@example.test' });
    const id = (await post(OWNER, '/api/pncs', { name: 'Kim Ray', status: 'Consult booked', email: 'kim@example.test' })).data.id;
    const base = { retainerDate: '2026-10-21', lawyerId: 'counsel-jasmine-daya', fileNumber: 'J5001', caseType: 'Personal injury', rev: 1 };
    expect((await post(OWNER, `/api/pncs/${id}/convert`, { ...base, retainerSigned: false })).status).toBe(400);
    const ask = await post(OWNER, `/api/pncs/${id}/convert`, { ...base, retainerSigned: true });
    expect(ask.status).toBe(409);
    expect(ask.data.candidates.length).toBe(1);
    const done = await post(OWNER, `/api/pncs/${id}/convert`, { ...base, retainerSigned: true, linkClientId: ask.data.candidates[0].id });
    expect(done.status).toBe(201);
    expect((await get(OWNER, `/api/pncs/${id}`)).data.pnc.status).toBe('Retained');
  });
});

describe('client expenses', () => {
  it('totals by currency, excludes voided entries, and exports formula-safe CSV', async () => {
    const { matterId } = await makeClientAndMatter('J6001', 'Ledger');
    const a = await post(OWNER, '/api/expenses', { scope: 'client', matterId, date: '2026-10-01', provider: '=HYPERLINK("x")', currency: 'CAD', amountCents: 10000, hstCents: 1300, payStatus: 'Unknown' });
    const b = await post(OWNER, '/api/expenses', { scope: 'client', matterId, date: '2026-10-02', provider: 'Court', currency: 'CAD', amountCents: 5000, payStatus: 'Unpaid' });
    await post(OWNER, '/api/expenses', { scope: 'client', matterId, date: '2026-10-03', provider: 'Postage', currency: 'USD', amountCents: 692, payStatus: 'Paid', paidDate: '2026-10-03' });
    expect((await post(OWNER, `/api/expenses/${b.data.id}/void`, { reason: '', rev: 1 })).status).toBe(400);
    expect((await post(OWNER, `/api/expenses/${b.data.id}/void`, { reason: 'Entered twice', rev: 1 })).status).toBe(200);
    const list = await get(OWNER, '/api/expenses?scope=client&month=2026-10');
    expect(list.data.totals.CAD.totalCents).toBe(11300);
    expect(list.data.totals.USD.totalCents).toBe(692);
    const csv = await get(OWNER, '/api/expenses/export?scope=client&month=2026-10');
    expect(String(csv.data)).toContain(`"'=HYPERLINK(""x"")"`);
    expect(a.status).toBe(201);
  });
  it('requires a paid date for paid expenses, and limits edits to the creator or an administrator', async () => {
    const { matterId } = await makeClientAndMatter('J6002', 'Edits');
    expect((await post(OWNER, '/api/expenses', { scope: 'client', matterId, date: '2026-10-01', provider: 'X', currency: 'CAD', amountCents: 100, payStatus: 'Paid' })).status).toBe(400);
    const e = await post(OWNER, '/api/expenses', { scope: 'client', matterId, date: '2026-10-01', provider: 'X', currency: 'CAD', amountCents: 100, payStatus: 'Unpaid' });
    await addMember('clerk@example.test', 'Member', ['jdco']);
    expect((await patch('clerk@example.test', `/api/expenses/${e.data.id}`, { scope: 'client', matterId, date: '2026-10-01', provider: 'Y', currency: 'CAD', amountCents: 100, payStatus: 'Unpaid', rev: 1 })).status).toBe(403);
  });
});

describe('imports', () => {
  const clientsCsv = 'lastName,firstName,dob,email,phone\nNewton,Ada,1980-01-02,ada@example.test,416-555-0100\nNewton,Ada,1980-01-02,ada@example.test,dup\n,Nobody,,,\n';
  it('previews, commits only selected Ready rows, and never commits a batch twice', async () => {
    const pv = await post(OWNER, '/api/imports/preview', { target: 'clients', csv: clientsCsv });
    expect(pv.status).toBe(200);
    expect(pv.data.rows.map((r: Json) => r.status)).toEqual(['Ready', 'Duplicate', 'Error']);
    const ready = pv.data.rows.filter((r: Json) => r.status === 'Ready').map((r: Json) => r.rowId);
    expect((await post(OWNER, `/api/imports/${pv.data.id}/commit`, { rowIds: ready })).data.added).toBe(1);
    expect((await post(OWNER, `/api/imports/${pv.data.id}/commit`, { rowIds: ready })).status).toBe(409);
    expect((await get(OWNER, '/api/clients?q=newton')).data.clients.length).toBe(1);
  });
  it('links matters to clients by "Last, First" and expenses to matters by file number', async () => {
    const c = await post(OWNER, '/api/imports/preview', { target: 'clients', csv: 'lastName,firstName\nHale,Rae\n' });
    await post(OWNER, `/api/imports/${c.data.id}/commit`, { rowIds: [c.data.rows[0].rowId] });
    const m = await post(OWNER, '/api/imports/preview', { target: 'matters', csv: 'client,fileNumber,caseType,lawyer,status,notes\n"Hale, Rae",J7001,Personal injury,Jasmine Daya,Transferred,Fees owed on settlement\n"Nobody, X",J7002,Other,,Open,\n' });
    expect(m.data.rows.map((r: Json) => r.status)).toEqual(['Ready', 'Error']);
    await post(OWNER, `/api/imports/${m.data.id}/commit`, { rowIds: [m.data.rows[0].rowId] });
    const e = await post(OWNER, '/api/imports/preview', { target: 'clientExpenses', csv: "fileNumber,date,provider,currency,amount,hst,payStatus\nJ7001,2026-09-01,'=Records Office,CAD,65.00,8.45,Unknown\nJ9999,2026-09-01,X,CAD,1,,\n" });
    expect(e.data.rows.map((r: Json) => r.status)).toEqual(['Ready', 'Error']);
    await post(OWNER, `/api/imports/${e.data.id}/commit`, { rowIds: [e.data.rows[0].rowId] });
    const matterId = (await get(OWNER, '/api/matters')).data.matters.find((x: Json) => x.fileNumber === 'J7001').id;
    const list = await get(OWNER, `/api/expenses?scope=client&month=&matterId=${matterId}`);
    expect(list.data.expenses.length).toBe(1);
    expect(list.data.expenses[0].provider).toBe('=Records Office');
    expect(list.data.totals.CAD.totalCents).toBe(7345);
  });
  it('is for administrators only', async () => {
    await addMember('firm2@example.test', 'Member', ['jdco']);
    expect((await post('firm2@example.test', '/api/imports/preview', { target: 'clients', csv: clientsCsv })).status).toBe(403);
  });
});
