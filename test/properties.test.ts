import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { app } from '../src/worker/index';
import { env } from './env';

// Made-up people and places only.
const OWNER = 'owner@example.test';
const ADMIN = 'props-admin@example.test';
const STAFF = 'props-staff@example.test';
const OTHER = 'no-props@example.test';
type Json = Record<string, any>;

async function call(user: string, method: string, path: string, body?: unknown, e: Env = env) {
  const res = await app.request(path, {
    method,
    headers: { 'x-dev-user': user, 'content-type': 'application/json', origin: 'http://localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, e);
  const data = (res.headers.get('content-type') || '').includes('json') ? ((await res.json()) as Json) : ({} as Json);
  return { status: res.status, data };
}
const get = (u: string, p: string) => call(u, 'GET', p);
const post = (u: string, p: string, b: unknown = {}) => call(u, 'POST', p, b);
const patch = (u: string, p: string, b: unknown) => call(u, 'PATCH', p, b);

const property = (over: Json = {}) => ({
  name: 'Maple St duplex', address: '12 Maple St, Toronto ON', ownership: 'Example Holdings Inc. (100%)', currency: 'CAD',
  purchaseDate: '2020-05-01', purchasePriceCents: 85000000, pmName: 'Pat Manager', pmEmail: 'pm@example.test', pmPhone: '416-555-0100',
  craBusinessNumber: '123456789 RT0001', mortgageCompany: 'Example Bank', loanNumber: 'LN-0001', insurer: 'Example Insurance', policyNumber: 'POL-1', ...over,
});

beforeAll(async () => {
  await get(OWNER, '/api/me');
  expect((await post(OWNER, '/api/members', { name: 'Props Admin', email: ADMIN, role: 'Administrator', divisions: ['properties'] })).status).toBe(201);
  expect((await post(OWNER, '/api/members', { name: 'Props Staff', email: STAFF, role: 'Member', divisions: ['properties'] })).status).toBe(201);
  expect((await post(OWNER, '/api/members', { name: 'No Props', email: OTHER, role: 'Administrator', divisions: ['marketing'] })).status).toBe(201);
});

describe('Properties access', () => {
  it('is closed to everyone without the Properties division, administrators included', async () => {
    const { data } = await post(OWNER, '/api/properties', property());
    for (const [m, p] of [['GET', '/api/properties'], ['GET', `/api/properties/${data.id}`], ['POST', '/api/properties'], ['PATCH', `/api/properties/${data.id}`],
      ['POST', `/api/properties/${data.id}/tenants`], ['GET', '/api/contacts?division=properties']] as const) {
      expect((await call(OTHER, m, p, m === 'GET' ? undefined : property())).status, `${m} ${p}`).toBe(403);
    }
  });

  it('lets only the Owner grant Properties access', async () => {
    expect((await post(OTHER, '/api/members', { name: 'Try', email: 'try1@example.test', role: 'Member', divisions: ['properties'] })).status).toBe(403);
    expect((await post(ADMIN, '/api/members', { name: 'Try', email: 'try2@example.test', role: 'Member', divisions: ['properties'] })).status).toBe(403);
  });

  it('lets staff with the division add and edit properties, with stale saves refused', async () => {
    const { status, data } = await post(STAFF, '/api/properties', property({ name: 'Birch Ave' }));
    expect(status).toBe(201);
    const d = (await get(STAFF, `/api/properties/${data.id}`)).data.property;
    expect(d.purchasePriceCents).toBe(85000000);
    expect(d.soldPriceCents).toBeNull();
    expect((await patch(STAFF, `/api/properties/${data.id}`, property({ name: 'Birch Ave', status: 'Sold', soldDate: '2026-01-15', soldPriceCents: 99000000, rev: d.rev }))).status).toBe(200);
    expect((await patch(STAFF, `/api/properties/${data.id}`, property({ name: 'Birch Ave', rev: d.rev }))).status).toBe(409);
  });

  it('checks dates and sale status', async () => {
    expect((await post(OWNER, '/api/properties', property({ soldDate: '2019-01-01', status: 'Sold' }))).status).toBe(400);
    expect((await post(OWNER, '/api/properties', property({ soldDate: '2024-01-01' }))).status).toBe(400);
    expect((await post(OWNER, '/api/properties', property({ address: '' }))).status).toBe(400);
    expect((await post(OWNER, '/api/properties', property({ craBusinessNumber: '12-34#' }))).status).toBe(400);
  });

  it('hides property activity from staff without the division', async () => {
    await post(OWNER, '/api/properties', property({ name: 'Secret Lane' }));
    const theirs = (await get(OTHER, '/api/audit?limit=200')).data.audit as Json[];
    expect(theirs.some(a => /Secret Lane/.test(a.entity))).toBe(false);
    const mine = (await get(STAFF, '/api/audit?limit=200')).data.audit as Json[];
    expect(mine.some(a => /Secret Lane/.test(a.entity))).toBe(true);
  });
});

describe('Tenants', () => {
  it('records lease details and contacts per property, and keeps them on their own property', async () => {
    const a = (await post(OWNER, '/api/properties', property({ name: 'Tenant House A' }))).data.id;
    const b = (await post(OWNER, '/api/properties', property({ name: 'Tenant House B' }))).data.id;
    const t = { name: 'Sam Tenant', unit: '2', email: 'sam@example.test', phone: '416-555-0199', leaseStart: '2025-09-01', leaseEnd: '2026-08-31', rentCents: 240000, rentFrequency: 'Monthly', rentDueDay: '1st', depositCents: 240000, leaseLink: 'https://example.test/lease.pdf', leaseNotes: 'No pets.' };
    const r = await post(STAFF, `/api/properties/${a}/tenants`, t);
    expect(r.status).toBe(201);
    expect((await post(STAFF, `/api/properties/${a}/tenants`, { ...t, leaseEnd: '2025-01-01' })).status).toBe(400);
    expect((await post(STAFF, `/api/properties/${a}/tenants`, { ...t, leaseLink: 'http://insecure.example.test' })).status).toBe(400);
    const d = (await get(STAFF, `/api/properties/${a}`)).data;
    expect(d.tenants).toHaveLength(1);
    expect(d.tenants[0].rentCents).toBe(240000);
    // Editing through the wrong property changes nothing.
    expect((await patch(STAFF, `/api/properties/${b}/tenants/${r.data.id}`, { ...t, name: 'Moved', rev: 1 })).status).toBe(409);
    expect((await patch(STAFF, `/api/properties/${a}/tenants/${r.data.id}`, { ...t, status: 'Former', rev: 1 })).status).toBe(200);
    expect((await get(STAFF, '/api/properties')).data.properties.find((p: Json) => p.id === a).currentTenants).toBe(0);
  });
});

describe('Properties contacts', () => {
  const contact = (over: Json = {}) => ({ division: 'properties', name: 'Sam Fixit', organization: 'Example Plumbing', role: 'Plumber', email: 'sam@example.test', phone: '416-555-0199', city: 'Mississauga', status: 'Active', ...over });

  it('keeps a city on each contact and hides them from staff without Properties', async () => {
    const r = await post(STAFF, '/api/contacts', contact());
    expect(r.status).toBe(201);
    const list = (await get(STAFF, '/api/contacts?division=properties')).data.contacts as Json[];
    expect(list.find(c => c.id === r.data.id)).toMatchObject({ city: 'Mississauga', organization: 'Example Plumbing', role: 'Plumber' });
    expect((await post(OTHER, '/api/contacts', contact({ name: 'Not allowed' }))).status).toBe(403);
    expect((await patch(STAFF, `/api/contacts/${r.data.id}`, { ...contact(), city: 'Oakville', rev: 1 })).status).toBe(200);
    const again = (await get(STAFF, '/api/contacts?division=properties')).data.contacts as Json[];
    expect(again.find(c => c.id === r.data.id)!.city).toBe('Oakville');
  });

  it('keeps Properties contact activity out of the log for staff without the division', async () => {
    await post(STAFF, '/api/contacts', contact({ name: 'Hidden Roofer', email: '' }));
    const theirs = (await get(OTHER, '/api/audit?limit=200')).data.audit as Json[];
    expect(theirs.some(a => /Hidden Roofer/.test(a.entity))).toBe(false);
    const mine = (await get(STAFF, '/api/audit?limit=200')).data.audit as Json[];
    expect(mine.some(a => /Hidden Roofer/.test(a.entity) && a.scope === 'properties')).toBe(true);
  });

  it('no longer has service providers on a property', async () => {
    const id = (await post(STAFF, '/api/properties', property({ name: 'No Providers Ave' }))).data.id;
    expect((await get(STAFF, `/api/properties/${id}`)).data).not.toHaveProperty('providers');
    expect((await post(STAFF, `/api/properties/${id}/providers`, { name: 'x' })).status).toBe(404);
  });

  it('copies old service providers into Properties contacts, without passwords', async () => {
    const pid = (await post(STAFF, '/api/properties', property({ name: 'Copy St' }))).data.id;
    const t = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO property_providers (id, property_id, name, company, services, address, phone, email, account_number, login, password_enc, notes, status, created_at, updated_at)
      VALUES ('prov-old', ?, 'Lee Contact', 'Example Hydro', 'Electricity', '1 Grid Rd', '416-555-0123', 'billing@example.test', 'ACC-42', 'maple-account', 'v1.secret', 'Call before noon', 'Former', ?, ?)`).bind(pid, t, t).run();
    const sql = fs.readFileSync('migrations/0007_property_contacts.sql', 'utf8');
    await env.DB.prepare(sql.slice(sql.indexOf('INSERT INTO div_contacts')).replace(/;\s*$/, '')).run();
    const row = (await get(STAFF, '/api/contacts?division=properties')).data.contacts.find((c: Json) => c.id === 'prov-old');
    expect(row).toMatchObject({ name: 'Lee Contact', organization: 'Example Hydro', role: 'Electricity', status: 'Archived' });
    expect(row.notes).toBe('Property: Copy St\nAddress: 1 Grid Rd\nAccount number: ACC-42\nLogin: maple-account\n\nCall before noon');
    expect(JSON.stringify(row)).not.toContain('v1.secret');
  });
});
