import type { MiddlewareHandler } from 'hono';
import { DIVISION_IDS } from '../shared/constants';
import type { AppEnv, Env } from './env';
import { SESSION_COOKIE, signInReady } from './google';
import { unseal } from './session';
import { fail, memberFromRow, newId, nowIso } from './util';

/**
 * Work out who is signed in.
 * Production: "Sign in with Google" (google.ts) leaves a signed session cookie; we verify it on every request.
 * Development: a stand-in identity from .env, never available when ENVIRONMENT is "production".
 */
export async function signedInEmail(req: Request, env: Env): Promise<string> {
  // Defence in depth: the stand-in identity also requires the request to be addressed to this computer.
  const host = new URL(req.url).hostname;
  if (env.ENVIRONMENT === 'development' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) {
    const email = req.headers.get('x-dev-user') || env.DEV_USER_EMAIL;
    if (!email) fail(401, 'Set DEV_USER_EMAIL in .env for local development.');
    return email!.trim().toLowerCase();
  }
  if (!signInReady(env)) fail(500, 'Sign-in isn’t configured yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET and PUBLIC_BASE_URL (see GO-LIVE.md).');
  const cookie = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.get('cookie') || '')?.[1];
  const session = await unseal<{ email: string }>(cookie, env.SESSION_SECRET!);
  if (!session || typeof session.email !== 'string' || !session.email) fail(401, 'Please sign in.');
  return session!.email.toLowerCase();
}
/** Resolve the signed-in Google account to an active Momentum member, creating the Owner on first sign-in. */
export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = await signedInEmail(c.req.raw, c.env);
  const db = c.env.DB;
  let row = await db.prepare('SELECT * FROM members WHERE email = ?').bind(email).first<Record<string, unknown>>();
  if (!row && c.env.OWNER_EMAIL && email === c.env.OWNER_EMAIL.trim().toLowerCase()) {
    const owner = await db.prepare("SELECT id FROM members WHERE role = 'Owner'").first();
    if (!owner) {
      const t = nowIso();
      await db.prepare("INSERT INTO members (id, email, name, title, role, divisions, active, first_sign_in, created_at, updated_at) VALUES (?, ?, 'Jasmine Daya', '', 'Owner', ?, 1, ?, ?, ?)")
        .bind(newId(), email, JSON.stringify(DIVISION_IDS), t, t, t).run();
      row = await db.prepare('SELECT * FROM members WHERE email = ?').bind(email).first<Record<string, unknown>>();
    }
  }
  if (!row) fail(403, `You’re signed in as ${email}, which isn’t a Momentum member. Ask Jasmine to add you in People and access.`);
  const member = memberFromRow(row!);
  if (!member.active) fail(403, 'Your Momentum access has been turned off. Ask Jasmine if this is a mistake.');
  if (!row!.first_sign_in) await db.prepare('UPDATE members SET first_sign_in = ? WHERE id = ?').bind(nowIso(), member.id).run();
  c.set('member', member);
  await next();
};

/** Mutations must come from this site as JSON (blocks cross-site form posts). */
export const sameOriginJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) fail(403, 'Requests must come from Momentum itself.');
    if (!(c.req.header('content-type') || '').toLowerCase().startsWith('application/json')) fail(415, 'Send JSON.');
    const len = Number(c.req.header('content-length') || 0);
    if (len > 1024 * 1024) fail(413, 'That request is too large.');
  }
  await next();
};
