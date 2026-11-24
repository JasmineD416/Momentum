import { webcrypto } from 'node:crypto';
import type { Env } from './env';
import { fail } from './util';

/**
 * Encrypts small secrets (service provider passwords) before they're stored, with AES-256-GCM.
 * The key (DATA_ENCRYPTION_KEY, 64 hex characters) lives only in the server's settings, never in the database or backups.
 */

const enc = new TextEncoder(), dec = new TextDecoder();
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const keys = new Map<string, Promise<webcrypto.CryptoKey>>();

export const secretsReady = (env: Env) => /^[0-9a-f]{64}$/i.test(env.DATA_ENCRYPTION_KEY || '');

function key(env: Env) {
  if (!secretsReady(env)) fail(500, 'Password storage isn’t set up on the server yet (DATA_ENCRYPTION_KEY).');
  const hex = env.DATA_ENCRYPTION_KEY!;
  let k = keys.get(hex);
  if (!k) { k = crypto.subtle.importKey('raw', Buffer.from(hex, 'hex'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); keys.set(hex, k); }
  return k;
}

/** `aad` ties the ciphertext to its record, so it can't be copied onto another row. */
export async function seal(env: Env, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await key(env), enc.encode(plain)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function open(env: Env, sealed: string, aad: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) fail(500, 'This stored password is in an unknown format.');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(aad) }, await key(env), fromB64url(ct));
    return dec.decode(pt);
  } catch {
    return fail(500, 'This stored password can’t be decrypted with the server’s current key.');
  }
}
