/** Signed, tamper-proof cookie values (HMAC-SHA256). Nothing secret goes in them, only who is signed in and until when. */

import { webcrypto } from 'node:crypto';

const enc = new TextEncoder();
const keys = new Map<string, Promise<webcrypto.CryptoKey>>();
const key = (secret: string) => {
  let k = keys.get(secret);
  if (!k) { k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); keys.set(secret, k); }
  return k;
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256b64url = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));

/** Sign a JSON payload that expires after `seconds`. */
export async function seal(payload: Record<string, unknown>, secret: string, seconds: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + seconds })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The payload if the signature is good and it hasn't expired; otherwise null. */
export async function unseal<T extends Record<string, unknown>>(value: string | undefined, secret: string): Promise<T | null> {
  if (!value || !secret) return null;
  const [body, sig, extra] = value.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T & { exp?: number };
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
