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
      ['POST', `/api/properties/${data.id}/tenants`], ['POST', `/api/properties/${data.id}/providers`]] as const) {
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

describe('Service providers and stored passwords', () => {
  let propertyId = '', providerId = '';
  const provider = { name: 'Lee Contact', company: 'Example Hydro', services: 'Electricity', phone: '416-555-0123', email: 'billing@example.test', accountNumber: 'ACC-42', login: 'maple-account' };

  it('stores the password encrypted and never lists it', async () => {
    propertyId = (await post(OWNER, '/api/properties', property({ name: 'Provider House' }))).data.id;
    const r = await post(STAFF, `/api/properties/${propertyId}/providers`, { ...provider, password: 'Example-Passw0rd!' });
    expect(r.status).toBe(201);
    providerId = r.data.id;
    const d = (await get(STAFF, `/api/properties/${propertyId}`)).data;
    const listed = JSON.stringify(d);
    expect(listed).not.toContain('Example-Passw0rd!');
    expect(d.providers[0].hasPassword).toBe(true);
    expect(d.providers[0]).not.toHaveProperty('passwordEnc');
    const raw = await env.DB.prepare('SELECT password_enc FROM property_providers WHERE id = ?').bind(providerId).first<{ password_enc: string }>();
    expect(raw!.password_enc.startsWith('v1.')).toBe(true);
    expect(raw!.password_enc).not.toContain('Example-Passw0rd');
  });

  it('shows a password only on request, to people with access, and logs each viewing', async () => {
    expect((await post(OTHER, `/api/properties/${propertyId}/providers/${providerId}/password`)).status).toBe(403);
    const r = await post(STAFF, `/api/properties/${propertyId}/providers/${providerId}/password`);
    expect(r.status).toBe(200);
    expect(r.data.password).toBe('Example-Passw0rd!');
    const audit = (await get(OWNER, '/api/audit?limit=200')).data.audit as Json[];
    expect(audit.some(a => a.action === 'Viewed provider password' && /Example Hydro/.test(a.entity) && a.scope === 'properties')).toBe(true);
  });

  it('keeps the password when edited without one, replaces it when given, and can remove it', async () => {
    expect((await patch(STAFF, `/api/properties/${propertyId}/providers/${providerId}`, { ...provider, services: 'Electricity and water', rev: 1 })).status).toBe(200);
    expect((await post(STAFF, `/api/properties/${propertyId}/providers/${providerId}/password`)).data.password).toBe('Example-Passw0rd!');
    expect((await patch(STAFF, `/api/properties/${propertyId}/providers/${providerId}`, { ...provider, password: 'Second-Passw0rd', rev: 2 })).status).toBe(200);
    expect((await post(STAFF, `/api/properties/${propertyId}/providers/${providerId}/password`)).data.password).toBe('Second-Passw0rd');
    expect((await patch(STAFF, `/api/properties/${propertyId}/providers/${providerId}`, { ...provider, clearPassword: true, rev: 3 })).status).toBe(200);
    expect((await post(STAFF, `/api/properties/${propertyId}/providers/${providerId}/password`)).status).toBe(404);
  });

  it('won’t decrypt a password copied onto another provider', async () => {
    const one = (await post(STAFF, `/api/properties/${propertyId}/providers`, { ...provider, company: 'One', password: 'pw-one-secret' })).data.id;
    const two = (await post(STAFF, `/api/properties/${propertyId}/providers`, { ...provider, company: 'Two' })).data.id;
    const { password_enc } = (await env.DB.prepare('SELECT password_enc FROM property_providers WHERE id = ?').bind(one).first<{ password_enc: string }>())!;
    await env.DB.prepare('UPDATE property_providers SET password_enc = ? WHERE id = ?').bind(password_enc, two).run();
    expect((await post(STAFF, `/api/properties/${propertyId}/providers/${two}/password`)).status).toBe(500);
  });

  it('refuses to store a password when the server has no encryption key, but saves everything else', async () => {
    const noKey: Env = { ...env, DATA_ENCRYPTION_KEY: '' };
    expect((await call(STAFF, 'POST', `/api/properties/${propertyId}/providers`, { ...provider, password: 'x-secret' }, noKey)).status).toBe(500);
    expect((await call(STAFF, 'POST', `/api/properties/${propertyId}/providers`, { ...provider, company: 'No password Co' }, noKey)).status).toBe(201);
  });
});
