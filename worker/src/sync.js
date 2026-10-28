// Pulls data from Plaid into D1.
//
// Free-plan budget: each Worker invocation gets ~10 ms of CPU (network wait is free) and
// 50 D1 queries (a db.batch() counts as one). So a sync does a bounded amount of work and
// is resumable: transactions are fetched at most `maxPages` pages at a time, and the caller
// (the app's "Sync now" loop, or the next hourly cron run) continues while `more` is true.
import { decryptToken } from './crypto.js';
import { plaid, PlaidError, LOGIN_REQUIRED_CODES, PRODUCT_SKIP_CODES } from './plaid.js';
import { cents, ptDate } from './util.js';
import { categorize } from './categorize.js';

const TX_PAGE_SIZE = 250;

// Ask Plaid to check the bank right now (Transactions Refresh). Results arrive a minute or two later
// through the SYNC_UPDATES_AVAILABLE webhook. Best-effort: errors (rate limits, unsupported) are ignored.
export async function requestBankRefresh(env, item) {
  if (item.tx_status === 'unsupported' || item.status === 'login_required') return false;
  try {
    const token = await decryptToken(env, item.access_token_enc, item.access_token_iv);
    await plaid(env, '/transactions/refresh', { access_token: token });
    return true;
  } catch (e) {
    console.warn('transactions/refresh failed', item.id, e.code || e.message);
    return false;
  }
}

export async function syncItem(env, item, { maxPages = 3, forceSnapshot = false, transactionsOnly = false } = {}) {
  const started = Date.now();
  const logId = crypto.randomUUID();
  const summary = { snapshot: false, liabilities: 0, holdings: 0, added: 0, modified: 0, removed: 0, more: false };
  try {
    const token = await decryptToken(env, item.access_token_enc, item.access_token_iv);
    const today = ptDate();

    if (transactionsOnly) {
      // New transactions arrived: refresh balances too, so card running totals (balance + pending)
      // never mix an old balance with newer transactions. /accounts/get is Plaid's cached balance (free).
      await syncAccountsAndBalances(env, item, token, today);
    } else if (forceSnapshot || item.last_snapshot_date !== today) {
      const accounts = await syncAccountsAndBalances(env, item, token, today);
      summary.snapshot = true;
      if (accounts.some((a) => a.type === 'credit')) summary.liabilities = await syncLiabilities(env, token, accounts);
      if (accounts.some((a) => a.type === 'investment')) summary.holdings = await syncHoldings(env, token, accounts, today);
      await env.DB.prepare('UPDATE plaid_items SET last_snapshot_date = ? WHERE id = ?').bind(today, item.id).run();
    }

    if (item.tx_status !== 'unsupported') {
      Object.assign(summary, await syncTransactions(env, item, token, maxPages));
      if (summary.added || summary.modified) {
        const owner = await env.DB.prepare('SELECT household_id FROM users WHERE id = ?').bind(item.owner_user_id).first();
        if (owner) await categorize(env, owner.household_id);
      }
    }

    await env.DB.prepare(
      "UPDATE plaid_items SET status = 'ok', error_code = CASE WHEN error_code IN ('NEW_ACCOUNTS_AVAILABLE', 'PENDING_EXPIRATION') THEN error_code ELSE NULL END, last_synced_at = ? WHERE id = ?"
    ).bind(Date.now(), item.id).run();
    await log(env, logId, item.id, started, 'ok', summary);
    return summary;
  } catch (err) {
    const code = err instanceof PlaidError ? err.code : null;
    const status = code && LOGIN_REQUIRED_CODES.has(code) ? 'login_required' : 'error';
    await env.DB.prepare('UPDATE plaid_items SET status = ?, error_code = ?, last_synced_at = ? WHERE id = ?')
      .bind(status, code || 'SYNC_FAILED', Date.now(), item.id).run();
    await log(env, logId, item.id, started, status, { error: code || String(err.message || err) });
    console.error('syncItem failed', item.id, code || err);
    throw err;
  }
}

async function syncAccountsAndBalances(env, item, token, today) {
  const r = await plaid(env, '/accounts/get', { access_token: token });

  const upserts = r.accounts.map((a) => env.DB.prepare(
    `INSERT INTO accounts (id, item_id, plaid_account_id, owner_user_id, name, official_name, mask, type, subtype)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plaid_account_id) DO UPDATE SET
       name = excluded.name, official_name = excluded.official_name, mask = excluded.mask,
       type = excluded.type, subtype = excluded.subtype`
  ).bind(crypto.randomUUID(), item.id, a.account_id, item.owner_user_id, a.name, a.official_name || null,
    a.mask || null, a.type, a.subtype || null));
  const consent = r.item && r.item.consent_expiration_time ? Date.parse(r.item.consent_expiration_time) : null;
  upserts.push(env.DB.prepare('UPDATE plaid_items SET consent_expires_at = ? WHERE id = ?').bind(consent, item.id));
  await env.DB.batch(upserts);

  const accounts = await accountMap(env, item.id);
  const byPlaidId = new Map(accounts.map((a) => [a.plaid_account_id, a]));
  const snaps = [];
  for (const a of r.accounts) {
    const acct = byPlaidId.get(a.account_id);
    if (!acct) continue;
    const b = a.balances || {};
    snaps.push(env.DB.prepare(
      `INSERT OR REPLACE INTO balance_snapshots (account_id, date, current, available, credit_limit, currency)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(acct.id, today, cents(b.current), cents(b.available), cents(b.limit), b.iso_currency_code || 'USD'));
  }
  if (snaps.length) await env.DB.batch(snaps);
  return accounts;
}

async function syncLiabilities(env, token, accounts) {
  let r;
  try {
    r = await plaid(env, '/liabilities/get', { access_token: token });
  } catch (err) {
    if (err instanceof PlaidError && PRODUCT_SKIP_CODES.has(err.code)) return 0;
    throw err;
  }
  const byPlaidId = new Map(accounts.map((a) => [a.plaid_account_id, a]));
  const stmts = [];
  for (const c of (r.liabilities && r.liabilities.credit) || []) {
    const acct = byPlaidId.get(c.account_id);
    if (!acct || !c.last_statement_issue_date) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO card_statements
         (account_id, statement_date, statement_balance, minimum_payment, due_date, last_payment_amount, last_payment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(acct.id, c.last_statement_issue_date, cents(c.last_statement_balance), cents(c.minimum_payment_amount),
      c.next_payment_due_date || null, cents(c.last_payment_amount), c.last_payment_date || null));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

async function syncHoldings(env, token, accounts, today) {
  let r;
  try {
    r = await plaid(env, '/investments/holdings/get', { access_token: token });
  } catch (err) {
    if (err instanceof PlaidError && PRODUCT_SKIP_CODES.has(err.code)) return 0;
    throw err;
  }
  const byPlaidId = new Map(accounts.map((a) => [a.plaid_account_id, a]));
  const securities = new Map((r.securities || []).map((s) => [s.security_id, s]));
  const stmts = [];
  // Replace today's snapshot for these accounts (holdings can disappear when sold).
  for (const a of accounts.filter((x) => x.type === 'investment')) {
    stmts.push(env.DB.prepare('DELETE FROM holdings_snapshots WHERE account_id = ? AND date = ?').bind(a.id, today));
  }
  for (const h of r.holdings || []) {
    const acct = byPlaidId.get(h.account_id);
    if (!acct) continue;
    const sec = securities.get(h.security_id) || {};
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO holdings_snapshots
         (account_id, date, security_id, ticker, name, type, quantity, price, value, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(acct.id, today, h.security_id, sec.ticker_symbol || null, sec.name || null, sec.type || null,
      h.quantity ?? null, cents(h.institution_price), cents(h.institution_value), cents(h.cost_basis)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return (r.holdings || []).length;
}

async function syncTransactions(env, item, token, maxPages) {
  const out = { added: 0, modified: 0, removed: 0, more: false };
  let accounts = await accountMap(env, item.id);
  let byPlaidId = new Map(accounts.map((a) => [a.plaid_account_id, a]));
  let cursor = item.tx_cursor_next || item.tx_cursor || '';

  for (let page = 0; page < maxPages; page++) {
    let r;
    try {
      r = await plaid(env, '/transactions/sync', { access_token: token, cursor: cursor || undefined, count: TX_PAGE_SIZE });
    } catch (err) {
      if (err instanceof PlaidError && err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        // Plaid says: restart pagination from the cursor we had before the first page.
        await env.DB.prepare('UPDATE plaid_items SET tx_cursor_next = NULL WHERE id = ?').bind(item.id).run();
        out.more = true;
        return out;
      }
      if (err instanceof PlaidError && PRODUCT_SKIP_CODES.has(err.code) && err.code !== 'PRODUCT_NOT_READY') {
        await env.DB.prepare("UPDATE plaid_items SET tx_status = 'unsupported' WHERE id = ?").bind(item.id).run();
        return out;
      }
      throw err;
    }

    // A new account can show up mid-stream; refresh the map once if we see an unknown id.
    const unknown = [...r.added, ...r.modified].some((t) => !byPlaidId.has(t.account_id));
    if (unknown) {
      accounts = await accountMap(env, item.id);
      byPlaidId = new Map(accounts.map((a) => [a.plaid_account_id, a]));
    }

    const now = Date.now();
    const stmts = [];
    for (const t of [...r.added, ...r.modified]) {
      const acct = byPlaidId.get(t.account_id);
      if (!acct) continue;
      const pfc = t.personal_finance_category || {};
      stmts.push(env.DB.prepare(
        `INSERT INTO transactions
           (id, plaid_transaction_id, account_id, date, authorized_date, amount, merchant_name, name, pending,
            pfc_primary, pfc_detailed, pfc_confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plaid_transaction_id) DO UPDATE SET
           account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date,
           amount = excluded.amount, merchant_name = excluded.merchant_name, name = excluded.name,
           pending = excluded.pending, pfc_primary = excluded.pfc_primary, pfc_detailed = excluded.pfc_detailed,
           pfc_confidence = excluded.pfc_confidence, removed = 0, updated_at = excluded.updated_at`
      ).bind(crypto.randomUUID(), t.transaction_id, acct.id, t.date, t.authorized_date || null, cents(t.amount),
        t.merchant_name || null, t.name || null, t.pending ? 1 : 0, pfc.primary || null, pfc.detailed || null,
        pfc.confidence_level || null, now));
    }
    for (const t of r.removed) {
      stmts.push(env.DB.prepare('UPDATE transactions SET removed = 1, updated_at = ? WHERE plaid_transaction_id = ?')
        .bind(now, t.transaction_id));
    }
    // Cursor bookkeeping goes in the same batch, so data and cursor commit together.
    if (r.has_more) {
      stmts.push(env.DB.prepare('UPDATE plaid_items SET tx_cursor_next = ?, tx_status = ? WHERE id = ?')
        .bind(r.next_cursor, r.transactions_update_status || null, item.id));
    } else {
      stmts.push(env.DB.prepare('UPDATE plaid_items SET tx_cursor = ?, tx_cursor_next = NULL, tx_status = ? WHERE id = ?')
        .bind(r.next_cursor, r.transactions_update_status || null, item.id));
    }
    await env.DB.batch(stmts);

    out.added += r.added.length;
    out.modified += r.modified.length;
    out.removed += r.removed.length;
    cursor = r.next_cursor;
    out.more = !!r.has_more;
    if (!r.has_more) break;
  }
  return out;
}

async function accountMap(env, itemId) {
  const { results } = await env.DB.prepare('SELECT id, plaid_account_id, type FROM accounts WHERE item_id = ?')
    .bind(itemId).all();
  return results;
}

async function log(env, id, itemId, started, status, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO sync_log (id, job, item_id, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, 'sync_item', itemId, started, Date.now(), status, JSON.stringify(detail)).run();
  } catch (e) {
    console.warn('sync_log write failed', e);
  }
}

// Hourly cron: sync the stalest connection that hasn't been snapshotted today (or is mid-pagination).
export async function runScheduledSync(env) {
  const item = await env.DB.prepare(
    `SELECT * FROM plaid_items
      WHERE status != 'login_required'
        AND (last_snapshot_date IS NULL OR last_snapshot_date != ? OR tx_cursor_next IS NOT NULL)
      ORDER BY COALESCE(last_synced_at, 0) LIMIT 1`
  ).bind(ptDate()).first();
  if (!item) return null;
  try {
    return await syncItem(env, item, { maxPages: 4 });
  } catch (e) {
    return null; // already logged and recorded on the item
  }
}
