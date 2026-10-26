// Phase 2: accounts, month-start levels, net worth, holdings.
import { json, ptDate } from './util.js';

export const GROUPS = ['cash', 'vault', 'credit', 'investment', 'loan', 'other'];

// Accounts the caller may SEE: their own, plus household-shared ones from their household.
const VISIBLE = `(a.owner_user_id = ?1 OR (a.visibility = 'household' AND ow.household_id = ?2))`;
const GROUP_EXPR = `COALESCE(a.account_group, CASE a.type
    WHEN 'depository' THEN 'cash' WHEN 'credit' THEN 'credit'
    WHEN 'investment' THEN 'investment' WHEN 'loan' THEN 'loan' ELSE 'other' END)`;

// Liabilities count negative in net worth (Plaid reports amount owed as a positive "current").
export const isLiability = (group) => group === 'credit' || group === 'loan';

export async function listAccounts(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.item_id, a.owner_user_id, a.name, a.display_name, a.official_name, a.mask, a.type, a.subtype,
            a.visibility, a.hidden, a.include_in_net_worth, a.track_levels, a.sort,
            ${GROUP_EXPR} AS grp,
            i.institution_name, i.status AS item_status,
            b.date AS balance_date, b.current, b.available, b.credit_limit,
            cs.statement_balance, cs.statement_date, cs.due_date, cs.minimum_payment,
            (SELECT COUNT(*) FROM holdings_snapshots h WHERE h.account_id = a.id
               AND h.date = (SELECT MAX(date) FROM holdings_snapshots WHERE account_id = a.id)) AS holdings_count
       FROM accounts a
       JOIN plaid_items i ON i.id = a.item_id
       JOIN users ow ON ow.id = a.owner_user_id
       LEFT JOIN balance_snapshots b ON b.account_id = a.id
            AND b.date = (SELECT MAX(date) FROM balance_snapshots WHERE account_id = a.id)
       LEFT JOIN card_statements cs ON cs.account_id = a.id
            AND cs.statement_date = (SELECT MAX(statement_date) FROM card_statements WHERE account_id = a.id)
      WHERE ${VISIBLE}
      ORDER BY a.sort, i.institution_name, a.name`
  ).bind(user.id, user.household_id).all();
  return json({ accounts: results.map((a) => ({ ...a, is_mine: a.owner_user_id === user.id })) });
}

// Only the owner can change an account's settings.
async function ownedAccountIds(env, user, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT id FROM accounts WHERE owner_user_id = ? AND id IN (${ph})`)
    .bind(user.id, ...ids).all();
  return results.map((r) => r.id);
}

function cleanPatch(body) {
  const set = {};
  if ('display_name' in body) {
    const v = body.display_name === null ? null : String(body.display_name).trim().slice(0, 60);
    set.display_name = v || null;
  }
  if ('account_group' in body) {
    if (body.account_group !== null && !GROUPS.includes(body.account_group)) throw new Error('bad account_group');
    set.account_group = body.account_group;
  }
  for (const k of ['hidden', 'include_in_net_worth', 'track_levels']) {
    if (k in body) set[k] = body[k] ? 1 : 0;
  }
  if ('visibility' in body) {
    if (!['private', 'household'].includes(body.visibility)) throw new Error('bad visibility');
    set.visibility = body.visibility;
  }
  return set;
}

export async function patchAccounts(env, user, ids, body) {
  let set;
  try { set = cleanPatch(body || {}); } catch (e) { return json({ error: 'bad_request', message: e.message }, 400); }
  const keys = Object.keys(set);
  if (!keys.length) return json({ error: 'bad_request', message: 'nothing to change' }, 400);
  const owned = await ownedAccountIds(env, user, ids.slice(0, 90));
  if (!owned.length) return json({ error: 'not_found' }, 404);
  const sql = `UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await env.DB.batch(owned.map((id) => env.DB.prepare(sql).bind(...keys.map((k) => set[k]), id)));
  return json({ ok: true, updated: owned.length });
}

// Manual balance for a past date (e.g. backfilling Oct 1 from the old spreadsheet).
export async function putManualBalance(env, user, accountId, body) {
  const [owned] = await ownedAccountIds(env, user, [accountId]);
  if (!owned) return json({ error: 'not_found' }, 404);
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= ptDate()) {
    return json({ error: 'bad_request', message: 'Date must be YYYY-MM-DD and before today.' }, 400);
  }
  const cents = Number(body.current_cents);
  if (!Number.isFinite(cents) || !Number.isInteger(cents) || Math.abs(cents) > 1e12) {
    return json({ error: 'bad_request', message: 'Amount is invalid.' }, 400);
  }
  const existing = await env.DB.prepare('SELECT source FROM balance_snapshots WHERE account_id = ? AND date = ?')
    .bind(accountId, date).first();
  if (existing && existing.source === 'plaid') {
    return json({ error: 'conflict', message: 'A synced balance already exists for that date.' }, 409);
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO balance_snapshots (account_id, date, current, available, credit_limit, currency, source)
     VALUES (?, ?, ?, NULL, NULL, 'USD', 'manual')`
  ).bind(accountId, date, cents).run();
  return json({ ok: true });
}

export async function deleteManualBalance(env, user, accountId, date) {
  const [owned] = await ownedAccountIds(env, user, [accountId]);
  if (!owned) return json({ error: 'not_found' }, 404);
  await env.DB.prepare("DELETE FROM balance_snapshots WHERE account_id = ? AND date = ? AND source = 'manual'")
    .bind(accountId, date).run();
  return json({ ok: true });
}

function monthKeys(n) {
  const [y, m] = ptDate().split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// For each visible account and each of the last N months: the balance on the earliest
// snapshot in that month (ideally the 1st), plus whether it was a manual entry.
export async function monthLevels(env, user, months) {
  const keys = monthKeys(Math.min(Math.max(months || 6, 1), 24));
  const from = `${keys[0]}-01`;
  const { results } = await env.DB.prepare(
    `SELECT s.account_id, substr(s.date, 1, 7) AS month, s.date, s.current, s.source
       FROM balance_snapshots s
       JOIN (SELECT bs.account_id, substr(bs.date, 1, 7) AS m, MIN(bs.date) AS d
               FROM balance_snapshots bs
               JOIN accounts a ON a.id = bs.account_id
               JOIN users ow ON ow.id = a.owner_user_id
              WHERE bs.date >= ?3 AND ${VISIBLE}
              GROUP BY bs.account_id, m) f
         ON f.account_id = s.account_id AND f.d = s.date`
  ).bind(user.id, user.household_id, from).all();
  const values = {};
  for (const r of results) {
    (values[r.account_id] ||= {})[r.month] = { date: r.date, current: r.current, source: r.source };
  }
  return json({ months: keys, values });
}

// Daily net worth: for every date with any snapshot, carry each account's last known balance forward.
export async function netWorth(env, user, days) {
  const span = Math.min(Math.max(days || 365, 7), 3650);
  const from = ptDate(new Date(Date.now() - span * 86400000));
  const accts = (await env.DB.prepare(
    `SELECT a.id, ${GROUP_EXPR} AS grp FROM accounts a JOIN users ow ON ow.id = a.owner_user_id
      WHERE ${VISIBLE} AND a.hidden = 0 AND a.include_in_net_worth = 1`
  ).bind(user.id, user.household_id).all()).results;
  if (!accts.length) return json({ series: [] });
  const groupOf = new Map(accts.map((a) => [a.id, a.grp]));
  const ph = accts.map(() => '?').join(',');

  const ids = accts.map((a) => a.id);
  const [inRange, before] = await env.DB.batch([
    env.DB.prepare(`SELECT account_id, date, current FROM balance_snapshots
                     WHERE account_id IN (${ph}) AND date >= ? ORDER BY date`).bind(...ids, from),
    env.DB.prepare(`SELECT s.account_id, s.date, s.current FROM balance_snapshots s
                     JOIN (SELECT account_id, MAX(date) d FROM balance_snapshots
                            WHERE account_id IN (${ph}) AND date < ? GROUP BY account_id) l
                       ON l.account_id = s.account_id AND l.d = s.date`).bind(...ids, from),
  ]);

  const last = new Map();
  for (const r of before.results) last.set(r.account_id, r.current || 0);
  const byDate = new Map();
  for (const r of inRange.results) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const series = [];
  for (const date of [...byDate.keys()].sort()) {
    for (const r of byDate.get(date)) last.set(r.account_id, r.current || 0);
    let assets = 0, liabilities = 0;
    for (const [id, v] of last) {
      if (isLiability(groupOf.get(id))) liabilities += v; else assets += v;
    }
    series.push({ date, assets, liabilities, net: assets - liabilities });
  }
  return json({ series });
}

export async function holdings(env, user, accountId) {
  const acct = await env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN users ow ON ow.id = a.owner_user_id WHERE a.id = ?3 AND ${VISIBLE}`
  ).bind(user.id, user.household_id, accountId).first();
  if (!acct) return json({ error: 'not_found' }, 404);
  const { results } = await env.DB.prepare(
    `SELECT ticker, name, type, quantity, price, value, cost_basis, date FROM holdings_snapshots
      WHERE account_id = ? AND date = (SELECT MAX(date) FROM holdings_snapshots WHERE account_id = ?)
      ORDER BY value DESC`
  ).bind(accountId, accountId).all();
  return json({ holdings: results });
}
