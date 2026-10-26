// Minimal Plaid API client + webhook verification.
import { b64urlToBytes, b64urlToString, sha256Hex, timingSafeEqual } from './util.js';

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidError extends Error {
  constructor(status, body) {
    super(body.error_code || `plaid_http_${status}`);
    this.status = status;
    this.code = body.error_code || null;
    this.type = body.error_type || null;
    this.displayMessage = body.display_message || null;
    this.plaidMessage = body.error_message || null;
  }
}

// Errors that mean "the user has to reconnect this bank in Link (update mode)".
export const LOGIN_REQUIRED_CODES = new Set([
  'ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'INSUFFICIENT_CREDENTIALS', 'ITEM_LOCKED',
  'USER_SETUP_REQUIRED', 'INVALID_MFA', 'PENDING_EXPIRATION', 'OAUTH_INVALID_TOKEN',
]);

// Errors that mean "this product doesn't apply to this connection" — skip quietly.
export const PRODUCT_SKIP_CODES = new Set([
  'PRODUCTS_NOT_SUPPORTED', 'PRODUCT_NOT_READY', 'NO_LIABILITY_ACCOUNTS', 'NO_INVESTMENT_ACCOUNTS',
  'NO_INVESTMENT_AUTH_ACCOUNTS', 'ADDITIONAL_CONSENT_REQUIRED', 'PRODUCT_NOT_ENABLED', 'INVALID_PRODUCT',
  'NO_ACCOUNTS',
]);

export async function plaid(env, path, body) {
  const host = HOSTS[env.PLAID_ENV];
  if (!host) throw new Error(`PLAID_ENV must be "sandbox" or "production" (got "${env.PLAID_ENV}")`);
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('Plaid secrets are not set on the Worker');
  const res = await fetch(host + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
      'PLAID-SECRET': env.PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlaidError(res.status, data);
  return data;
}

// Verifies the Plaid-Verification JWT (ES256) and the body hash. Returns true/false.
export async function verifyPlaidWebhook(env, req, rawBody) {
  const jwt = req.headers.get('Plaid-Verification');
  if (!jwt) return false;
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;

  let header, claims;
  try {
    header = JSON.parse(b64urlToString(h));
    claims = JSON.parse(b64urlToString(p));
  } catch (e) {
    console.warn('Webhook JWT not parseable', e);
    return false;
  }
  if (header.alg !== 'ES256' || !header.kid) return false;

  const cacheKey = `plaid_jwk:${env.PLAID_ENV}:${header.kid}`;
  let jwk = await env.KV.get(cacheKey, 'json');
  if (!jwk) {
    const r = await plaid(env, '/webhook_verification_key/get', { key_id: header.kid });
    jwk = r.key;
    await env.KV.put(cacheKey, JSON.stringify(jwk), { expirationTtl: 24 * 60 * 60 });
  }
  if (!jwk || jwk.expired_at) return false;

  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return false;
  if (!claims.iat || Date.now() / 1000 - claims.iat > 5 * 60) return false;
  return timingSafeEqual(await sha256Hex(rawBody), String(claims.request_body_sha256 || ''));
}
