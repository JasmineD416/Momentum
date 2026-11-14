import { describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { app } from '../src/worker/index';
import { seal, unseal } from '../src/worker/session';
import { env as devEnv } from './env';

// Production settings: the development stand-in identity is off and Google sign-in is configured (with made-up values).
const SECRET = 'test-session-secret-0123456789-abcdefghij';
const prod: Env = {
  ...devEnv,
  ENVIRONMENT: 'production',
  OWNER_EMAIL: 'owner@example.test',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: SECRET,
  PUBLIC_BASE_URL: 'https://momentum.example.test',
};

const req = (path: string, init: RequestInit = {}, env: Env = prod) => app.request(`https://momentum.example.test${path}`, init, env);
const asCookie = async (email: string, seconds = 3600, secret = SECRET) => ({ cookie: `momentum_session=${await seal({ email }, secret, seconds)}` });

describe('Google sign-in sessions', () => {
  it('refuses everything until sign-in is configured', async () => {
    const res = await req('/api/me', {}, { ...prod, GOOGLE_CLIENT_ID: '' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/isn’t configured/);
  });

  it('asks people with no session to sign in, and ignores the development identity header', async () => {
    expect((await req('/api/me')).status).toBe(401);
    expect((await req('/api/me', { headers: { 'x-dev-user': 'owner@example.test' } })).status).toBe(401);
  });

  it('lets the Owner in with a valid session, and makes them Owner on first sign-in', async () => {
    const res = await req('/api/me', { headers: await asCookie('owner@example.test') });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: { role: string } }).member.role).toBe('Owner');
  });

  it('rejects tampered, expired and wrongly signed sessions', async () => {
    const good = (await asCookie('owner@example.test')).cookie;
    const [body, sig] = good.split('=')[1].split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'owner@example.test', exp: 9999999999 })).toString('base64url');
    expect((await req('/api/me', { headers: { cookie: `momentum_session=${forged}.${sig}` } })).status).toBe(401);
    expect((await req('/api/me', { headers: { cookie: `momentum_session=${body}.${sig}x` } })).status).toBe(401);
    expect((await req('/api/me', { headers: await asCookie('owner@example.test', -10) })).status).toBe(401);
    expect((await req('/api/me', { headers: await asCookie('owner@example.test', 3600, 'another-secret-0123456789-abcdefghijkl') })).status).toBe(401);
  });

  it('turns away signed-in Google accounts that are not Momentum members', async () => {
    const res = await req('/api/me', { headers: await asCookie('stranger@example.test') });
    expect(res.status).toBe(403);
  });

  it('starts Google sign-in with state, nonce and PKCE, and never redirects off-site afterwards', async () => {
    const res = await req('/auth/login?next=//evil.example.test/x');
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('redirect_uri')).toBe('https://momentum.example.test/auth/callback');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    const flow = await unseal<{ state: string; next: string }>(/momentum_signin=([^;]+)/.exec(setCookie)![1], SECRET);
    expect(flow!.state).toBe(to.searchParams.get('state'));
    expect(flow!.next).toBe('/');
  });

  it('rejects a sign-in callback whose state does not match', async () => {
    const login = await req('/auth/login');
    const flowCookie = /momentum_signin=[^;]+/.exec(login.headers.get('set-cookie')!)![0];
    const res = await req('/auth/callback?code=abc&state=wrong', { headers: { cookie: flowCookie } });
    expect(res.status).toBe(400);
    expect((await req('/auth/callback?code=abc&state=x')).status).toBe(400);
  });

  it('signs out only when asked from Momentum itself', async () => {
    expect((await req('/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example.test' } })).status).toBe(403);
    const res = await req('/auth/logout', { method: 'POST', headers: { origin: 'https://momentum.example.test' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/momentum_session=;/);
  });

  it('answers health checks without signing in', async () => {
    const res = await req('/healthz');
    expect(res.status).toBe(200);
  });
});
