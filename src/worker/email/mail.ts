import { AwsClient } from 'aws4fetch';
import type { Env } from '../env';
import { fail, newId } from '../util';

/* ---------------- MIME ---------------- */
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
/** RFC 2047 encoding for header text that isn't plain ASCII. */
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (name: string, email: string) => (name ? `"${word(name.replace(/["\\\r\n]/g, ''))}" <${email}>` : email);

export type Outgoing = {
  fromName: string; fromEmail: string; replyTo: string; to: string; subject: string; html: string; text: string;
  unsubscribeUrl: string; feedbackId: string;
};

/**
 * A complete message with the headers Gmail and Yahoo require from bulk senders:
 * one-click unsubscribe (RFC 8058), a plain-text part, and a Feedback-ID for complaint reporting.
 */
export function buildMime(m: Outgoing) {
  const boundary = `=_momentum_${newId().replace(/-/g, '')}`;
  const headers = [
    `From: ${addr(m.fromName, m.fromEmail)}`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${word(m.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `List-Unsubscribe: <${m.unsubscribeUrl}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    `Feedback-ID: ${m.feedbackId}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(m.text)),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(m.html)),
    `--${boundary}--`, '',
  ].join('\r\n');
}

/* ---------------- Provider ---------------- */
export type SendResult = { ok: true; id: string } | { ok: false; error: string; retry: boolean };

/** Sent messages when EMAIL_PROVIDER is "log" (development and tests). */
export const outbox: { to: string; subject: string; raw: string }[] = [];

function ses(env: Env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION) fail(500, 'Email sending isn’t configured yet (see GO-LIVE.md, “Email sending”).');
  return { client: new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, region: env.AWS_REGION!, service: 'ses' }), base: `https://email.${env.AWS_REGION}.amazonaws.com/v2/email` };
}

export function providerReady(env: Env) {
  if (env.EMAIL_PROVIDER === 'log') return env.ENVIRONMENT === 'development';
  return env.EMAIL_PROVIDER === 'ses' && !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.EMAIL_SIGNING_SECRET && env.PUBLIC_BASE_URL);
}

export async function sendRaw(env: Env, m: Outgoing): Promise<SendResult> {
  const raw = buildMime(m);
  if (env.EMAIL_PROVIDER === 'log') {
    if (env.ENVIRONMENT !== 'development') return { ok: false, error: 'The log provider only works in development.', retry: false };
    outbox.push({ to: m.to, subject: m.subject, raw });
    return { ok: true, id: `log-${newId()}` };
  }
  if (env.EMAIL_PROVIDER !== 'ses') return { ok: false, error: 'EMAIL_PROVIDER must be "ses".', retry: false };
  const { client, base } = ses(env);
  const res = await client.fetch(`${base}/outbound-emails`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ FromEmailAddress: m.fromEmail, Destination: { ToAddresses: [m.to] }, Content: { Raw: { Data: b64(raw) } }, ...(env.SES_CONFIGURATION_SET ? { ConfigurationSetName: env.SES_CONFIGURATION_SET } : {}) }),
  });
  const data = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string; Message?: string };
  if (res.ok && data.MessageId) return { ok: true, id: data.MessageId };
  const error = data.message || data.Message || `Amazon SES returned ${res.status}`;
  // Throttling and server errors are retried on the next run; rejections (bad address, unverified sender) are not.
  return { ok: false, error, retry: res.status === 429 || res.status >= 500 };
}

/** Whether Amazon SES has verified the sending domain and its DKIM signing. */
export async function checkIdentity(env: Env, domain: string) {
  if (env.EMAIL_PROVIDER === 'log') return { verified: true, dkim: 'SUCCESS (development)', records: [] as { name: string; value: string }[] };
  const { client, base } = ses(env);
  const res = await client.fetch(`${base}/identities/${encodeURIComponent(domain)}`);
  if (res.status === 404) return { verified: false, dkim: 'NOT_STARTED', records: [] };
  const d = (await res.json()) as { VerifiedForSendingStatus?: boolean; DkimAttributes?: { Status?: string; Tokens?: string[] } };
  return {
    verified: !!d.VerifiedForSendingStatus, dkim: d.DkimAttributes?.Status ?? 'UNKNOWN',
    records: (d.DkimAttributes?.Tokens ?? []).map(t => ({ name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com` })),
  };
}

/* ---------------- Signed unsubscribe links ---------------- */
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function secret(env: Env) {
  if (!env.EMAIL_SIGNING_SECRET || env.EMAIL_SIGNING_SECRET.length < 16) fail(500, 'EMAIL_SIGNING_SECRET isn’t set (see GO-LIVE.md).');
  return env.EMAIL_SIGNING_SECRET!;
}
export type UnsubPayload = { subscriberId: string; brand: string; mailingId: string };
export async function unsubscribeToken(env: Env, p: UnsubPayload) {
  const data = b64url(enc.encode(`${p.subscriberId}|${p.brand}|${p.mailingId}`));
  return `${data}.${await hmac(secret(env), data)}`;
}
export async function readUnsubscribeToken(env: Env, token: string): Promise<UnsubPayload | null> {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = await hmac(secret(env), data);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  const [subscriberId, brand, mailingId] = fromB64url(data).split('|');
  return subscriberId && brand ? { subscriberId, brand, mailingId: mailingId ?? '' } : null;
}
export const unsubscribeUrl = async (env: Env, p: UnsubPayload) => `${(env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/u/${await unsubscribeToken(env, p)}`;
