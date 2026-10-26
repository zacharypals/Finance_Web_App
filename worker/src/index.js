// Finance Pal — finance-api Worker
// Phase 0: Google sign-in → Worker-issued session, email allowlist, /api/me.
//
// Auth model (differs from planner-auth on purpose):
//   * Google is used only to prove WHO you are. We never store a Google refresh token.
//   * After sign-in the Worker issues its own random session token. Only its SHA-256
//     hash is stored in D1, so a database leak doesn't leak usable sessions.
//   * Every /api/* request must carry `Authorization: Bearer <session token>`.
//   * The allowlist is re-checked on every request, so removing an email locks it out.

const WORKER_VERSION = '0.1.0';
const SESSION_DAYS = 90;          // sliding: extended on use, at most once per day
const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        res = json({ ok: true, version: WORKER_VERSION });
      } else if (url.pathname === '/auth/exchange' && req.method === 'POST') {
        res = await authExchange(req, env);
      } else if (url.pathname === '/auth/logout' && req.method === 'POST') {
        res = await authLogout(req, env);
      } else if (url.pathname.startsWith('/api/')) {
        const auth = await authenticate(req, env);
        res = auth.error ? auth.error : await routeApi(req, env, url, auth.user);
      } else {
        res = json({ error: 'not_found' }, 404);
      }
    } catch (err) {
      console.error('Unhandled error', err && err.stack ? err.stack : err);
      res = json({ error: 'server_error' }, 500);
    }
    return withHeaders(res, cors);
  },
};

// ── API routes ─────────────────────────────────────────

async function routeApi(req, env, url, user) {
  if (url.pathname === '/api/me' && req.method === 'GET') {
    return json({
      email: user.email,
      name: user.name,
      household_id: user.household_id,
      role: user.role,
      worker_version: WORKER_VERSION,
      plaid_env: env.PLAID_ENV || 'sandbox',
    });
  }
  return json({ error: 'not_found' }, 404);
}

// ── Auth ───────────────────────────────────────────────

async function authExchange(req, env) {
  const body = await req.json().catch(() => ({}));
  const { code, redirect_uri } = body;
  if (!code || redirect_uri !== env.REDIRECT_URI) return json({ error: 'bad_request' }, 400);
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: 'worker_missing_google_secret' }, 500);

  // 1. Trade the one-time code for a short-lived Google access token.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) {
    console.warn('Google token exchange failed', tokenRes.status, tok.error);
    return json({ error: 'google_exchange_failed' }, 400);
  }

  // 2. Ask Google who this is. The access token is used once and discarded.
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info.email || info.email_verified !== true) {
    return json({ error: 'unverified_email' }, 403);
  }
  const email = String(info.email).toLowerCase();
  if (!allowedEmails(env).includes(email)) return json({ error: 'not_allowed' }, 403);

  // 3. Create the user on first sign-in, then issue a session.
  const user = await upsertUser(env, email, info.name || null);
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * DAY_MS;
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(await sha256Hex(token), user.id, now, now, expiresAt, (req.headers.get('User-Agent') || '').slice(0, 200)).run();

  return json({
    session_token: token,
    expires_at: expiresAt,
    email,
    name: info.name || '',
    picture: info.picture || '',
  });
}

async function authLogout(req, env) {
  const token = bearer(req);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true });
}

// Returns { user } or { error: Response }
async function authenticate(req, env) {
  const token = bearer(req);
  if (!token) return { error: json({ error: 'unauthenticated' }, 401) };

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.last_used_at, s.expires_at,
            u.id, u.email, u.name, u.household_id, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(hash).first();

  const now = Date.now();
  if (!row || row.expires_at <= now) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return { error: json({ error: 'session_expired' }, 401) };
  }
  if (!allowedEmails(env).includes(row.email)) return { error: json({ error: 'not_allowed' }, 403) };

  if (now - row.last_used_at > DAY_MS) {
    await env.DB.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, now + SESSION_DAYS * DAY_MS, hash).run();
  }
  return { user: { id: row.id, email: row.email, name: row.name, household_id: row.household_id, role: row.role } };
}

async function upsertUser(env, email, name) {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    if (name && name !== existing.name) {
      await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, existing.id).run();
    }
    return existing;
  }
  // First user creates the household and owns it; later allowlisted users join it.
  const now = Date.now();
  let household = await env.DB.prepare('SELECT id FROM households ORDER BY created_at LIMIT 1').first();
  let role = 'member';
  if (!household) {
    household = { id: crypto.randomUUID() };
    role = 'owner';
    await env.DB.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)')
      .bind(household.id, 'Household', now).run();
  }
  const user = { id: crypto.randomUUID(), email, name, household_id: household.id, role, created_at: now };
  await env.DB.prepare('INSERT INTO users (id, email, name, household_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, email, name, household.id, role, now).run();
  return user;
}

// ── Helpers ────────────────────────────────────────────

function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function bearer(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (origin && origin === env.ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  r.headers.set('Cache-Control', 'no-store');
  return r;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
