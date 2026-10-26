// AES-GCM encryption for Plaid access tokens at rest.
// TOKEN_ENC_KEY is a base64 32-byte key set with `wrangler secret put TOKEN_ENC_KEY`.
import { b64ToBytes, bytesToB64 } from './util.js';

let cachedKey = null;
let cachedKeySource = null;

async function getKey(env) {
  const src = String(env.TOKEN_ENC_KEY || '').trim();
  if (!src) throw new Error('TOKEN_ENC_KEY is not set on the Worker');
  if (cachedKey && cachedKeySource === src) return cachedKey;
  const raw = b64ToBytes(src);
  if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
  cachedKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  cachedKeySource = src;
  return cachedKey;
}

export async function encryptToken(env, plaintext) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(env), new TextEncoder().encode(plaintext));
  return { ct: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
}

export async function decryptToken(env, ctB64, ivB64) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64) }, await getKey(env), b64ToBytes(ctB64)
  );
  return new TextDecoder().decode(pt);
}
