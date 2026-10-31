// Finance Pal — finance-api Worker
//
// Auth model:
//   * Google is used only to prove WHO you are. We never store a Google refresh token.
//   * After sign-in the Worker issues its own random session token. Only its SHA-256
//     hash is stored in D1, so a database leak doesn't leak usable sessions.
//   * Every /api/* request must carry `Authorization: Bearer <session token>`.
//   * The allowlist is re-checked on every request, so removing an email locks it out.
//
// Plaid (Phase 1):
//   * Access tokens are AES-GCM encrypted in D1 and never returned to the browser.
//   * /plaid/webhook is verified (ES256 JWT + body hash) before anything happens.
//   * An hourly cron syncs one stale connection per run (free-plan CPU budget).

import { json, sha256Hex } from './util.js';
import { encryptToken, decryptToken } from './crypto.js';
import { plaid, PlaidError, verifyPlaidWebhook } from './plaid.js';
import { syncItem, runScheduledSync, requestBankRefresh } from './sync.js';
import { listAccounts, patchAccounts, putManualBalance, deleteManualBalance, monthLevels, netWorth, holdings } from './accounts.js';

import {
  listCategories, createCategory, patchCategory, listTransactions, patchTransactions, resetTransaction,
  listRules, createRule, deleteRule, rerunCategorization, reportSummary,
} from './transactions.js';

import { getPlan, putTemplate, createBucket, patchBucket, reorderBuckets, seedBuckets, putCell, putPaycheck, refreshCards } from './plan.js';

import { listTags, createTag, patchTag, deleteTag, plaidCodes } from './tags.js';
import { listExpenses, createExpense, patchExpense, deleteExpense, createPool, patchPool, deletePool, importBudgetV2 } from './expenses.js';

const WORKER_VERSION = '0.10.1';
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
      } else if (url.pathname === '/plaid/webhook' && req.method === 'POST') {
        res = await plaidWebhook(req, env, ctx);
      } else if (url.pathname.startsWith('/api/')) {
        const auth = await authenticate(req, env);
        res = auth.error ? auth.error : await routeApi(req, env, ctx, url, auth.user);
      } else {
        res = json({ error: 'not_found' }, 404);
      }
    } catch (err) {
      if (err instanceof PlaidError) {
        console.warn('Plaid error', err.code, err.plaidMessage);
        res = json({ error: 'plaid_error', code: err.code, message: err.displayMessage || err.plaidMessage || err.code }, 502);
      } else {
        console.error('Unhandled error', err && err.stack ? err.stack : err);
        res = json({ error: 'server_error', message: String(err && err.message || err) }, 500);
      }
    }
    return withHeaders(res, cors);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};

// ── API routes ─────────────────────────────────────────

async function routeApi(req, env, ctx, url, user) {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/me' && method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM plaid_items WHERE owner_user_id = ?').bind(user.id).first();
    return json({
      email: user.email,
      name: user.name,
      household_id: user.household_id,
      role: user.role,
      worker_version: WORKER_VERSION,
      plaid_env: env.PLAID_ENV || 'sandbox',
      items_count: n ? n.n : 0,
    });
  }

  if (path === '/api/plaid/link-token' && method === 'POST') return linkToken(req, env, url, user);
  if (path === '/api/plaid/exchange' && method === 'POST') return exchangePublicToken(req, env, user);
  if (path === '/api/items' && method === 'GET') return listItems(env, user);

  // Phase 3: transactions, categories, rules, reports
  const body = () => req.json().catch(() => ({}));
  if (path === '/api/categories' && method === 'GET') return listCategories(env, user);
  if (path === '/api/categories' && method === 'POST') return createCategory(env, user, await body());
  const cm = path.match(/^\/api\/categories\/([^/]+)$/);
  if (cm && method === 'PATCH') return patchCategory(env, user, cm[1], await body());
  if (path === '/api/transactions' && method === 'GET') return listTransactions(env, user, url.searchParams);
  if (path === '/api/transactions/bulk' && method === 'POST') {
    const b = await body();
    const patch = { tags_add: b.tags_add, tags_remove: b.tags_remove };
    if ('category_id' in b) patch.category_id = b.category_id ?? null;
    return patchTransactions(env, user, Array.isArray(b.ids) ? b.ids.map(String) : [], patch);
  }
  const tm = path.match(/^\/api\/transactions\/([^/]+)(\/reset)?$/);
  if (tm && !tm[2] && method === 'PATCH') return patchTransactions(env, user, [tm[1]], await body());
  if (tm && tm[2] && method === 'POST') return resetTransaction(env, user, tm[1]);
  if (path === '/api/rules' && method === 'GET') return listRules(env, user);
  if (path === '/api/rules' && method === 'POST') return createRule(env, user, await body());
  const rm = path.match(/^\/api\/rules\/([^/]+)$/);
  if (rm && method === 'DELETE') return deleteRule(env, user, rm[1]);
  if (path === '/api/categorize/rerun' && method === 'POST') return rerunCategorization(env, user);
  if (path === '/api/tags' && method === 'GET') return listTags(env, user);
  if (path === '/api/tags' && method === 'POST') return createTag(env, user, await body());
  if (path === '/api/tags/plaid-codes' && method === 'GET') return plaidCodes(env, user);
  const gm = path.match(/^\/api\/tags\/([^/]+)$/);
  if (gm && method === 'PATCH') return patchTag(env, user, gm[1], await body());
  if (gm && method === 'DELETE') return deleteTag(env, user, gm[1]);
  if (path === '/api/reports/summary' && method === 'GET') return reportSummary(env, user, url.searchParams);

  // Expenses
  if (path === '/api/expenses' && method === 'GET') return listExpenses(env, user);
  if (path === '/api/expenses' && method === 'POST') return createExpense(env, user, await body());
  if (path === '/api/expenses/import-v2' && method === 'POST') return importBudgetV2(env, user);
  const em = path.match(/^\/api\/expenses\/([^/]+)$/);
  if (em && method === 'PATCH') return patchExpense(env, user, em[1], await body());
  if (em && method === 'DELETE') return deleteExpense(env, user, em[1]);
  if (path === '/api/pools' && method === 'POST') return createPool(env, user, await body());
  const pm = path.match(/^\/api\/pools\/([^/]+)$/);
  if (pm && method === 'PATCH') return patchPool(env, user, pm[1], await body());
  if (pm && method === 'DELETE') return deletePool(env, user, pm[1]);

  // Phase 4: plan
  if (path === '/api/plan' && method === 'GET') return getPlan(env, user, Number(url.searchParams.get('weeks')), Number(url.searchParams.get('past')));
  if (path === '/api/plan/paycheck' && method === 'PUT') return putPaycheck(env, user, await body());
  if (path === '/api/plan/refresh-cards' && method === 'POST') return refreshCards(env, user);
  if (path === '/api/plan/template' && method === 'PUT') return putTemplate(env, user, await body());
  if (path === '/api/plan/cell' && method === 'PUT') return putCell(env, user, await body());
  if (path === '/api/buckets' && method === 'POST') return createBucket(env, user, await body());
  if (path === '/api/buckets/seed' && method === 'POST') return seedBuckets(env, user);
  if (path === '/api/buckets/order' && method === 'POST') { const b = await body(); return reorderBuckets(env, user, Array.isArray(b.ids) ? b.ids.map(String) : []); }
  const bm = path.match(/^\/api\/buckets\/([^/]+)$/);
  if (bm && method === 'PATCH') return patchBucket(env, user, bm[1], await body());

  // Phase 2: accounts & net worth
  if (path === '/api/accounts' && method === 'GET') return listAccounts(env, user);
  if (path === '/api/accounts/bulk' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    return patchAccounts(env, user, Array.isArray(body.ids) ? body.ids.map(String) : [], body.set);
  }
  if (path === '/api/levels' && method === 'GET') return monthLevels(env, user, Number(url.searchParams.get('months')));
  if (path === '/api/networth' && method === 'GET') return netWorth(env, user, Number(url.searchParams.get('days')));
  const am = path.match(/^\/api\/accounts\/([^/]+)(?:\/(holdings|balances)(?:\/(\d{4}-\d{2}-\d{2}))?)?$/);
  if (am) {
    const [, accountId, sub, date] = am;
    if (!sub && method === 'PATCH') return patchAccounts(env, user, [accountId], await req.json().catch(() => ({})));
    if (sub === 'holdings' && method === 'GET') return holdings(env, user, accountId);
    if (sub === 'balances' && !date && method === 'POST') return putManualBalance(env, user, accountId, await req.json().catch(() => ({})));
    if (sub === 'balances' && date && method === 'DELETE') return deleteManualBalance(env, user, accountId, date);
  }

  const m = path.match(/^\/api\/items\/([^/]+)(\/(sync|reconnected))?$/);
  if (m) {
    const item = await ownedItem(env, user, m[1]);
    if (!item) return json({ error: 'not_found' }, 404);
    if (!m[3] && method === 'DELETE') return removeItem(env, item);
    if (m[3] === 'sync' && method === 'POST') {
      const body = await req.json().catch(() => ({}));
      // First round of "Sync now" also asks Plaid to check the bank right away.
      const askedBank = body.full ? await requestBankRefresh(env, item) : false;
      const summary = await syncItem(env, item, { maxPages: 3, forceSnapshot: !!body.full });
      return json({ ...summary, asked_bank: askedBank });
    }
    if (m[3] === 'reconnected' && method === 'POST') {
      await env.DB.prepare("UPDATE plaid_items SET status = 'ok', error_code = NULL WHERE id = ?").bind(item.id).run();
      const fresh = await ownedItem(env, user, item.id);
      const summary = await syncItem(env, fresh, { maxPages: 1, forceSnapshot: true });
      return json(summary);
    }
  }

  return json({ error: 'not_found' }, 404);
}

// ── Plaid: Link ────────────────────────────────────────

async function linkToken(req, env, url, user) {
  const body = await req.json().catch(() => ({}));
  const req0 = {
    client_name: 'Finance Pal',
    user: { client_user_id: user.id },
    country_codes: ['US'],
    language: 'en',
    redirect_uri: env.PLAID_REDIRECT_URI,
    webhook: `${url.origin}/plaid/webhook`,
  };

  if (body.item_id) {
    // Update mode: reconnect an existing bank. No products; account selection lets new accounts be added.
    const item = await ownedItem(env, user, body.item_id);
    if (!item) return json({ error: 'not_found' }, 404);
    const token = await decryptToken(env, item.access_token_enc, item.access_token_iv);
    const r = await plaid(env, '/link/token/create', {
      ...req0, access_token: token, update: { account_selection_enabled: true },
    });
    return json({ link_token: r.link_token, expiration: r.expiration });
  }

  let request;
  if (body.type === 'investment') {
    request = { ...req0, products: ['investments'] };
  } else {
    request = {
      ...req0,
      products: ['transactions'],
      required_if_supported_products: ['liabilities'],
      transactions: { days_requested: 730 },
    };
  }
  let r;
  try {
    r = await plaid(env, '/link/token/create', request);
  } catch (err) {
    // If this Plaid plan rejects required_if_supported_products, fall back to asking for consent only.
    if (err instanceof PlaidError && err.code === 'INVALID_FIELD' && request.required_if_supported_products) {
      delete request.required_if_supported_products;
      request.additional_consented_products = ['liabilities'];
      r = await plaid(env, '/link/token/create', request);
    } else {
      throw err;
    }
  }
  return json({ link_token: r.link_token, expiration: r.expiration });
}

async function exchangePublicToken(req, env, user) {
  const body = await req.json().catch(() => ({}));
  if (!body.public_token) return json({ error: 'bad_request' }, 400);
  const type = body.type === 'investment' ? 'investment' : 'bank';
  const inst = body.institution || {};

  const ex = await plaid(env, '/item/public_token/exchange', { public_token: body.public_token });

  // Each connection counts toward the Trial plan's 10-Item cap. If this bank is already
  // linked, remove the new duplicate right away and tell the user to use Reconnect instead.
  if (inst.institution_id) {
    const dup = await env.DB.prepare(
      'SELECT id FROM plaid_items WHERE owner_user_id = ? AND institution_id = ? AND link_type = ?'
    ).bind(user.id, inst.institution_id, type).first();
    if (dup) {
      try {
        await plaid(env, '/item/remove', { access_token: ex.access_token });
      } catch (e) {
        console.warn('Failed to remove duplicate item', e.code || e);
      }
      return json({ error: 'duplicate_institution', message: `${inst.name || 'That bank'} is already linked. Use Reconnect on the existing connection instead.` }, 409);
    }
  }

  const enc = await encryptToken(env, ex.access_token);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO plaid_items (id, owner_user_id, plaid_item_id, institution_id, institution_name,
       access_token_enc, access_token_iv, status, link_type, tx_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)`
  ).bind(id, user.id, ex.item_id, inst.institution_id || null, inst.name || 'Bank', enc.ct, enc.iv, type,
    type === 'investment' ? 'unsupported' : null, Date.now()).run();

  const item = await env.DB.prepare('SELECT * FROM plaid_items WHERE id = ?').bind(id).first();
  let summary = null, syncError = null;
  try {
    summary = await syncItem(env, item, { maxPages: 1, forceSnapshot: true });
  } catch (e) {
    syncError = e.code || e.message; // the item is saved; the next sync will retry
  }
  return json({ id, institution_name: item.institution_name, summary, sync_error: syncError });
}

async function listItems(env, user) {
  const items = (await env.DB.prepare(
    `SELECT id, institution_name, status, error_code, link_type, tx_status, last_synced_at,
            last_snapshot_date, consent_expires_at, created_at
       FROM plaid_items WHERE owner_user_id = ? ORDER BY created_at`
  ).bind(user.id).all()).results;

  const accounts = (await env.DB.prepare(
    `SELECT a.id, a.item_id, a.name, a.display_name, a.mask, a.type, a.subtype, a.visibility, a.hidden,
            b.date AS balance_date, b.current, b.available, b.credit_limit,
            cs.statement_balance, cs.due_date, cs.minimum_payment,
            (SELECT MAX(t.date) FROM transactions t WHERE t.account_id = a.id) AS latest_tx,
            (SELECT COUNT(*) FROM holdings_snapshots h WHERE h.account_id = a.id
               AND h.date = (SELECT MAX(date) FROM holdings_snapshots WHERE account_id = a.id)) AS holdings_count
       FROM accounts a
       JOIN plaid_items i ON i.id = a.item_id
       LEFT JOIN balance_snapshots b ON b.account_id = a.id
            AND b.date = (SELECT MAX(date) FROM balance_snapshots WHERE account_id = a.id)
       LEFT JOIN card_statements cs ON cs.account_id = a.id
            AND cs.statement_date = (SELECT MAX(statement_date) FROM card_statements WHERE account_id = a.id)
      WHERE i.owner_user_id = ?
      ORDER BY a.type, a.name`
  ).bind(user.id).all()).results;

  return json({ items: items.map((it) => ({ ...it, accounts: accounts.filter((a) => a.item_id === it.id) })) });
}

async function removeItem(env, item) {
  try {
    const token = await decryptToken(env, item.access_token_enc, item.access_token_iv);
    await plaid(env, '/item/remove', { access_token: token });
  } catch (e) {
    // Still delete locally if Plaid already forgot the item.
    if (!(e instanceof PlaidError && e.code === 'ITEM_NOT_FOUND')) throw e;
  }
  // Unlink anything that points at this bank's accounts, then delete (accounts/transactions cascade).
  const ofItem = 'SELECT id FROM accounts WHERE item_id = ?';
  await env.DB.batch([
    env.DB.prepare(`UPDATE buckets SET linked_account_id = NULL, backing = 'none' WHERE linked_account_id IN (${ofItem})`).bind(item.id),
    env.DB.prepare(`UPDATE buckets SET card_account_id = NULL WHERE card_account_id IN (${ofItem})`).bind(item.id),
    env.DB.prepare(`DELETE FROM category_rules WHERE account_id IN (${ofItem})`).bind(item.id),
    env.DB.prepare('DELETE FROM plaid_items WHERE id = ?').bind(item.id),
  ]);
  return json({ ok: true });
}

async function ownedItem(env, user, id) {
  return env.DB.prepare('SELECT * FROM plaid_items WHERE id = ? AND owner_user_id = ?').bind(id, user.id).first();
}

// ── Plaid: webhooks ────────────────────────────────────

async function plaidWebhook(req, env, ctx) {
  const raw = await req.text();
  if (!(await verifyPlaidWebhook(env, req, raw))) return json({ error: 'invalid_signature' }, 401);

  const hook = JSON.parse(raw);
  const item = hook.item_id
    ? await env.DB.prepare('SELECT * FROM plaid_items WHERE plaid_item_id = ?').bind(hook.item_id).first()
    : null;
  if (!item) return json({ ok: true, ignored: 'unknown_item' });

  const setStatus = (status, code) =>
    env.DB.prepare('UPDATE plaid_items SET status = ?, error_code = ? WHERE id = ?').bind(status, code, item.id).run();

  const key = `${hook.webhook_type}:${hook.webhook_code}`;
  switch (key) {
    case 'TRANSACTIONS:SYNC_UPDATES_AVAILABLE':
      ctx.waitUntil(syncItem(env, item, { maxPages: 3, transactionsOnly: true }).catch(() => {}));
      break;
    case 'ITEM:ERROR': {
      const code = hook.error && hook.error.error_code;
      await setStatus(code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error', code || 'ITEM_ERROR');
      break;
    }
    case 'ITEM:PENDING_EXPIRATION':
    case 'ITEM:PENDING_DISCONNECT':
      await setStatus('ok', 'PENDING_EXPIRATION');
      break;
    case 'ITEM:USER_PERMISSION_REVOKED':
    case 'ITEM:USER_ACCOUNT_REVOKED':
      await setStatus('error', hook.webhook_code);
      break;
    case 'ITEM:LOGIN_REPAIRED':
      await setStatus('ok', null);
      break;
    case 'ITEM:NEW_ACCOUNTS_AVAILABLE':
      await setStatus(item.status, 'NEW_ACCOUNTS_AVAILABLE');
      break;
    default:
      // HOLDINGS / LIABILITIES default updates are picked up by the daily snapshot.
      break;
  }
  return json({ ok: true });
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
