import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv, Env } from './env';
import { randomToken, seal, sha256b64url, unseal } from './session';

/**
 * "Sign in with Google" (OpenID Connect, authorization code flow with PKCE).
 * Google proves who the person is; Momentum's People and access list decides whether they get in and what they see.
 */

export const SESSION_COOKIE = 'momentum_session';
const FLOW_COOKIE = 'momentum_signin';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export const sessionHours = (env: Env) => Math.min(Math.max(Number(env.SESSION_HOURS) || 12, 1), 72);
export const signInReady = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 && env.PUBLIC_BASE_URL);
const base = (env: Env) => env.PUBLIC_BASE_URL!.replace(/\/$/, '');
const secure = (env: Env) => base(env).startsWith('https://');
const safeNext = (n: string | undefined) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n.slice(0, 500) : '/');

/** Create the signed session cookie for a verified email address. */
export async function startSession(c: Context<AppEnv>, email: string) {
  const hours = sessionHours(c.env);
  setCookie(c, SESSION_COOKIE, await seal({ email }, c.env.SESSION_SECRET!, hours * 3600), {
    path: '/', httpOnly: true, secure: secure(c.env), sameSite: 'Lax', maxAge: hours * 3600,
  });
}

const page = (c: Context<AppEnv>, title: string, message: string, status: 400 | 403 | 500 | 502 = 400) => {
  c.header('Cache-Control', 'no-store');
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Momentum</title>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;line-height:1.5">
<h1 style="font-size:20px">${title}</h1><p>${message}</p><p><a href="/auth/login">Try signing in again</a></p></body>`, status);
};

export const signIn = new Hono<AppEnv>();

signIn.get('/login', async c => {
  if (!signInReady(c.env)) return page(c, 'Sign-in isn’t set up yet', 'The Google sign-in settings haven’t been added to the server yet (see GO-LIVE.md).', 500);
  const state = randomToken(), nonce = randomToken(), verifier = randomToken(48);
  setCookie(c, FLOW_COOKIE, await seal({ state, nonce, verifier, next: safeNext(c.req.query('next')) }, c.env.SESSION_SECRET!, 600), {
    path: '/auth', httpOnly: true, secure: secure(c.env), sameSite: 'Lax', maxAge: 600,
  });
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!, redirect_uri: `${base(c.env)}/auth/callback`, response_type: 'code',
    scope: 'openid email profile', state, nonce, code_challenge: await sha256b64url(verifier), code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (c.env.GOOGLE_HOSTED_DOMAIN) q.set('hd', c.env.GOOGLE_HOSTED_DOMAIN);
  c.header('Cache-Control', 'no-store');
  return c.redirect(`${GOOGLE_AUTH}?${q}`, 302);
});

signIn.get('/callback', async c => {
  if (!signInReady(c.env)) return page(c, 'Sign-in isn’t set up yet', 'The Google sign-in settings haven’t been added to the server yet.', 500);
  const flow = await unseal<{ state: string; nonce: string; verifier: string; next: string }>(getCookie(c, FLOW_COOKIE), c.env.SESSION_SECRET!);
  deleteCookie(c, FLOW_COOKIE, { path: '/auth', secure: secure(c.env) });
  if (c.req.query('error')) return page(c, 'Sign-in was cancelled', 'Google didn’t complete the sign-in.');
  const code = c.req.query('code'), state = c.req.query('state');
  if (!flow || !code || !state || state !== flow.state) return page(c, 'That sign-in link has expired', 'Please start again from the sign-in page.');

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${base(c.env)}/auth/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier,
    }),
  });
  if (!res.ok) { console.error('Google token exchange failed', res.status, await res.text()); return page(c, 'Google sign-in failed', 'Google didn’t accept the sign-in. Please try again.', 502); }
  const { id_token } = (await res.json()) as { id_token?: string };
  try {
    const { payload } = await jwtVerify(String(id_token), googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: c.env.GOOGLE_CLIENT_ID!,
    });
    if (payload.nonce !== flow.nonce) throw new Error('nonce mismatch');
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || payload.email_verified !== true) return page(c, 'Email not verified', 'Your Google account’s email address isn’t verified.', 403);
    if (c.env.GOOGLE_HOSTED_DOMAIN && payload.hd !== c.env.GOOGLE_HOSTED_DOMAIN) return page(c, 'Wrong Google account', `Sign in with your @${c.env.GOOGLE_HOSTED_DOMAIN} account.`, 403);
    await startSession(c, email);
  } catch (e) {
    console.error('Google ID token rejected', e);
    return page(c, 'Google sign-in failed', 'The sign-in couldn’t be verified. Please try again.', 502);
  }
  c.header('Cache-Control', 'no-store');
  return c.redirect(flow.next, 302);
});

signIn.post('/logout', c => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'Requests must come from Momentum itself.' }, 403);
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secure(c.env) });
  return c.body(null, 204);
});
