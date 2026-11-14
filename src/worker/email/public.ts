import { Hono, type Context } from 'hono';
import { emailBrandName } from '../../shared/email';
import type { AppEnv, Env } from '../env';
import { nowIso } from '../util';
import { readUnsubscribeToken } from './mail';

/**
 * Routes reachable without signing in (with /auth and /healthz):
 * unsubscribe links from emails, and Amazon SES bounce and complaint notifications.
 */
export const publicEmail = new Hono<AppEnv>();

const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f5f3f6;color:#222;margin:0;padding:48px 16px}main{max-width:460px;margin:auto;background:#fff;border-radius:10px;padding:28px;border-top:4px solid #C14B8A}h1{font-size:20px;margin:0 0 12px}button{background:#111;color:#fff;border:0;border-radius:6px;padding:11px 18px;font-size:15px;cursor:pointer}p{line-height:1.5}</style>
</head><body><main>${body}</main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
const escHtml = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Unsubscribe from one entity's list. Safe to repeat. */
export async function unsubscribe(env: Env, subscriberId: string, brand: string, mailingId: string, source: string) {
  const db = env.DB, t = nowIso();
  const r = await db.prepare("UPDATE subscriptions SET status = 'Unsubscribed', unsubscribed_at = ?, unsubscribe_source = ?, updated_at = ? WHERE subscriber_id = ? AND brand = ? AND status = 'Subscribed'")
    .bind(t, source, t, subscriberId, brand).run();
  if (r.meta.changes && mailingId) {
    await db.batch([
      db.prepare('UPDATE mailing_recipients SET unsubscribed = 1 WHERE mailing_id = ? AND subscriber_id = ?').bind(mailingId, subscriberId),
      db.prepare('UPDATE mailings SET unsubscribe_count = unsubscribe_count + 1 WHERE id = ?').bind(mailingId),
    ]);
  }
  return r.meta.changes > 0;
}

async function tokenOf(c: Context<AppEnv>) {
  try { return await readUnsubscribeToken(c.env, c.req.param('token') ?? ''); } catch { return null; }
}

// Showing a page first (rather than unsubscribing on GET) stops link scanners in corporate mail from unsubscribing people.
publicEmail.get('/u/:token', async c => {
  const p = await tokenOf(c);
  if (!p) return page('Link not valid', '<h1>This link isn’t valid</h1><p>It may have been copied incompletely. Reply to the email and ask to be removed, and we’ll take care of it.</p>', 400);
  if (p.subscriberId === 'test') return page('Test email', '<h1>This was a test email</h1><p>Unsubscribe links in real mailings work from here.</p>');
  const name = escHtml(emailBrandName(p.brand));
  return page('Unsubscribe', `<h1>Unsubscribe from ${name}</h1><p>You’ll stop receiving marketing emails from ${name}. This doesn’t affect other businesses or any legal matter you have with us.</p>
    <form method="post"><button type="submit">Unsubscribe</button></form>`);
});

// Handles both the button above and one-click unsubscribe from Gmail, Yahoo and Apple Mail (RFC 8058).
publicEmail.post('/u/:token', async c => {
  const p = await tokenOf(c);
  if (!p) return page('Link not valid', '<h1>This link isn’t valid</h1>', 400);
  if (p.subscriberId !== 'test') {
    const oneClick = /List-Unsubscribe=One-Click/i.test(await c.req.text().catch(() => ''));
    await unsubscribe(c.env, p.subscriberId, p.brand, p.mailingId, oneClick ? 'One-click (mail app)' : 'Unsubscribe page');
  }
  const name = escHtml(emailBrandName(p.brand));
  return page('Unsubscribed', `<h1>You’re unsubscribed</h1><p>You won’t receive more marketing emails from ${name}.</p>`);
});

/* ---------------- Amazon SES notifications (through SNS) ---------------- */
type SesEvent = {
  eventType?: string; notificationType?: string; mail?: { messageId?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress: string }[]; complaintFeedbackType?: string };
};

const sameSecret = (a: string, b: string) => {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function applySesEvent(env: Env, ev: SesEvent) {
  const db = env.DB, type = ev.eventType || ev.notificationType, messageId = ev.mail?.messageId ?? '';
  const stmts: D1PreparedStatement[] = [];
  const recipient = messageId ? await db.prepare('SELECT id, mailing_id, subscriber_id FROM mailing_recipients WHERE provider_id = ?').bind(messageId).first<Record<string, string>>() : null;
  if (type === 'Bounce' && ev.bounce?.bounceType === 'Permanent') {
    for (const r of ev.bounce.bouncedRecipients ?? [])
      stmts.push(db.prepare("INSERT OR IGNORE INTO suppressions (email, reason, detail, created_at) VALUES (?, 'Hard bounce', ?, ?)").bind(r.emailAddress.toLowerCase(), (r.diagnosticCode ?? '').slice(0, 300), nowIso()));
    if (recipient) stmts.push(
      db.prepare('UPDATE mailing_recipients SET bounced = 1 WHERE id = ? AND bounced = 0').bind(recipient.id),
      db.prepare('UPDATE mailings SET bounce_count = bounce_count + changes() WHERE id = ?').bind(recipient.mailing_id),
    );
  } else if (type === 'Complaint') {
    for (const r of ev.complaint?.complainedRecipients ?? [])
      stmts.push(db.prepare("INSERT OR IGNORE INTO suppressions (email, reason, detail, created_at) VALUES (?, 'Complaint', ?, ?)").bind(r.emailAddress.toLowerCase(), ev.complaint?.complaintFeedbackType ?? '', nowIso()));
    if (recipient) stmts.push(
      db.prepare('UPDATE mailing_recipients SET complained = 1 WHERE id = ? AND complained = 0').bind(recipient.id),
      db.prepare('UPDATE mailings SET complaint_count = complaint_count + changes() WHERE id = ?').bind(recipient.mailing_id),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return type ?? 'unknown';
}

publicEmail.post('/hooks/ses', async c => {
  const env = c.env;
  if (!env.SES_WEBHOOK_TOKEN || !sameSecret(c.req.query('token') ?? '', env.SES_WEBHOOK_TOKEN)) return c.text('Forbidden', 403);
  let msg: { Type?: string; TopicArn?: string; SubscribeURL?: string; Message?: string };
  try { msg = JSON.parse(await c.req.text()); } catch { return c.text('Bad request', 400); }
  if (env.SES_TOPIC_ARN && msg.TopicArn !== env.SES_TOPIC_ARN) return c.text('Wrong topic', 403);
  if (msg.Type === 'SubscriptionConfirmation') {
    // Confirm only with Amazon SNS itself.
    const u = (() => { try { return new URL(msg.SubscribeURL ?? ''); } catch { return null; } })();
    if (!u || u.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return c.text('Bad confirmation URL', 400);
    await fetch(u.toString());
    return c.text('Subscribed');
  }
  if (msg.Type === 'Notification' && msg.Message) {
    let ev: SesEvent;
    try { ev = JSON.parse(msg.Message); } catch { return c.text('Bad message', 400); }
    return c.text(`Processed ${await applySesEvent(env, ev)}`);
  }
  return c.text('Ignored');
});
