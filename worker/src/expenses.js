// Expenses: recurring costs → what each needs per paycheck → which bucket pays it.
//
// Per-paycheck rule (Zachary's, on purpose): monthly ÷ 4, rounded UP to the whole dollar —
// the same as CEILING(D/4, 1) in Budget v2. Living on 4 paychecks a month leaves the
// 4 extra weekly paychecks each year (52 − 48) as a bonus.
// Split pools work like the sheet's Chase/Wells column: sum the pool's expenses, then each
// bucket gets CEILING(total × pct, 1).
import { json } from './util.js';

export const perPaycheck = (monthlyCents) => Math.ceil(monthlyCents / 4 / 100) * 100;
const poolShare = (totalCents, pct) => Math.ceil(totalCents * pct / 100 / 100 - 1e-9) * 100;
const SCOPE = (t) => `((${t}.scope_type = 'user' AND ${t}.scope_id = ?) OR (${t}.scope_type = 'household' AND ${t}.scope_id = ?))`;
const MAX = 1e9;

async function bucketOk(env, user, id) {
  if (!id) return true;
  return !!(await env.DB.prepare(`SELECT 1 FROM buckets b WHERE b.id = ? AND ${SCOPE('b')}`).bind(id, user.id, user.household_id).first());
}
async function poolOk(env, user, id) {
  if (!id) return true;
  return !!(await env.DB.prepare(`SELECT 1 FROM expense_pools p WHERE p.id = ? AND ${SCOPE('p')}`).bind(id, user.id, user.household_id).first());
}

export async function listExpenses(env, user) {
  const s = [user.id, user.household_id];
  const [exp, pools, shares, buckets, tpl] = await env.DB.batch([
    env.DB.prepare(`SELECT e.* FROM expenses e WHERE ${SCOPE('e')} ORDER BY e.sort, e.created_at`).bind(...s),
    env.DB.prepare(`SELECT p.* FROM expense_pools p WHERE ${SCOPE('p')} ORDER BY p.created_at`).bind(...s),
    env.DB.prepare(`SELECT ps.* FROM pool_shares ps JOIN expense_pools p ON p.id = ps.pool_id WHERE ${SCOPE('p')}`).bind(...s),
    env.DB.prepare(
      `SELECT b.id, b.name, b.kind, b.archived, ta.amount AS weekly_amount FROM buckets b
         LEFT JOIN paycheck_templates pt ON pt.user_id = ? AND pt.active = 1
         LEFT JOIN template_allocations ta ON ta.template_id = pt.id AND ta.bucket_id = b.id
        WHERE ${SCOPE('b')} ORDER BY b.sort, b.name`).bind(user.id, ...s),
    env.DB.prepare('SELECT expected_total, cadence FROM paycheck_templates WHERE user_id = ? AND active = 1 LIMIT 1').bind(user.id),
  ]);
  const expenses = exp.results.map((e) => ({ ...e, per_paycheck: perPaycheck(e.monthly_amount) }));
  const poolList = pools.results.map((p) => ({ ...p, shares: shares.results.filter((x) => x.pool_id === p.id) }));

  // What the expenses imply for each bucket.
  const byBucket = new Map();
  const add = (bid, amt, source) => {
    if (!byBucket.has(bid)) byBucket.set(bid, { bucket_id: bid, suggested: 0, sources: [] });
    const r = byBucket.get(bid); r.suggested += amt; r.sources.push(source);
  };
  for (const e of expenses) if (e.bucket_id) add(e.bucket_id, e.per_paycheck, { name: e.name, amount: e.per_paycheck });
  for (const p of poolList) {
    const total = expenses.filter((e) => e.pool_id === p.id).reduce((t, e) => t + e.per_paycheck, 0);
    p.per_paycheck = total;
    for (const sh of p.shares) add(sh.bucket_id, poolShare(total, sh.pct), { name: `${p.name} (${sh.pct}% of ${total / 100})`, amount: poolShare(total, sh.pct), pool: true });
  }
  const bmap = new Map(buckets.results.map((b) => [b.id, b]));
  const suggestions = [...byBucket.values()].filter((r) => bmap.has(r.bucket_id)).map((r) => {
    const b = bmap.get(r.bucket_id);
    return { ...r, name: b.name, archived: !!b.archived, current: b.weekly_amount || 0 };
  });

  const t = tpl.results[0] || {};
  const monthly = expenses.reduce((x, e) => x + e.monthly_amount, 0);
  const weekly = expenses.reduce((x, e) => x + e.per_paycheck, 0);
  return json({
    expenses, pools: poolList, suggestions,
    buckets: buckets.results.filter((b) => !b.archived).map((b) => ({ id: b.id, name: b.name, kind: b.kind, weekly_amount: b.weekly_amount || 0 })),
    totals: {
      monthly, per_paycheck: weekly, paycheck: t.expected_total || null,
      extra_paychecks_per_year: t.cadence === 'biweekly' ? 2 : 4,  // 52 − 48 weekly, or 26 − 24 every other week
      unassigned: expenses.filter((e) => !e.bucket_id && !e.pool_id && e.monthly_amount > 0).length,
    },
  });
}

function clean(body, existing) {
  const e = existing ? { ...existing } : {};
  if ('name' in body || !existing) {
    e.name = String(body.name || '').trim().slice(0, 60);
    if (!e.name) return { error: 'Name is required.' };
  }
  if ('group_name' in body || !existing) e.group_name = String(body.group_name || 'Other').trim().slice(0, 40) || 'Other';
  if ('monthly_amount' in body || !existing) {
    const n = Math.round(Number(body.monthly_amount || 0));
    if (!Number.isFinite(n) || n < 0 || n > MAX) return { error: 'Monthly amount is invalid.' };
    e.monthly_amount = n;
  }
  if ('paid_from' in body) {
    // "bucket:<id>", "pool:<id>" or null
    const v = body.paid_from || '';
    e.bucket_id = v.startsWith('bucket:') ? v.slice(7) : null;
    e.pool_id = v.startsWith('pool:') ? v.slice(5) : null;
  }
  if ('category_id' in body) e.category_id = body.category_id || null;
  if ('notes' in body) e.notes = body.notes ? String(body.notes).slice(0, 200) : null;
  return { e };
}

async function saveExpense(env, user, body, existing) {
  const r = clean(body, existing);
  if (r.error) return json({ error: 'bad_request', message: r.error }, 400);
  const e = r.e;
  if (!(await bucketOk(env, user, e.bucket_id)) || !(await poolOk(env, user, e.pool_id))) {
    return json({ error: 'bad_request', message: 'Unknown bucket or pool.' }, 400);
  }
  if (e.category_id && !(await env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').bind(e.category_id, user.household_id).first())) {
    return json({ error: 'bad_request', message: 'Unknown category.' }, 400);
  }
  if (existing) {
    await env.DB.prepare(
      'UPDATE expenses SET name = ?, group_name = ?, monthly_amount = ?, bucket_id = ?, pool_id = ?, category_id = ?, notes = ? WHERE id = ?'
    ).bind(e.name, e.group_name, e.monthly_amount, e.bucket_id || null, e.pool_id || null, e.category_id || null, e.notes || null, e.id).run();
    return json({ id: e.id });
  }
  const id = crypto.randomUUID();
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(e.sort), 0) AS m FROM expenses e WHERE ${SCOPE('e')}`).bind(user.id, user.household_id).first();
  await env.DB.prepare(
    `INSERT INTO expenses (id, scope_type, scope_id, name, group_name, monthly_amount, bucket_id, pool_id, category_id, notes, sort, created_at)
     VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, e.name, e.group_name, e.monthly_amount, e.bucket_id || null, e.pool_id || null, e.category_id || null,
    e.notes || null, (max ? max.m : 0) + 1, Date.now()).run();
  return json({ id });
}

async function ownedExpense(env, user, id) {
  return env.DB.prepare(`SELECT e.* FROM expenses e WHERE e.id = ? AND ${SCOPE('e')}`).bind(id, user.id, user.household_id).first();
}

export const createExpense = (env, user, body) => saveExpense(env, user, body, null);
export async function patchExpense(env, user, id, body) {
  const ex = await ownedExpense(env, user, id);
  return ex ? saveExpense(env, user, body, ex) : json({ error: 'not_found' }, 404);
}
export async function deleteExpense(env, user, id) {
  const ex = await ownedExpense(env, user, id);
  if (!ex) return json({ error: 'not_found' }, 404);
  await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// Pools: { name, shares: [{ bucket_id, pct }] }
async function writePool(env, user, body, id) {
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) return json({ error: 'bad_request', message: 'Name is required.' }, 400);
  const shares = Array.isArray(body.shares) ? body.shares.filter((s) => s.bucket_id) : [];
  for (const s of shares) {
    s.pct = Number(s.pct);
    if (!(s.pct > 0 && s.pct <= 100) || !(await bucketOk(env, user, s.bucket_id))) {
      return json({ error: 'bad_request', message: 'Each share needs a bucket and a percent from 1 to 100.' }, 400);
    }
  }
  const total = shares.reduce((t, s) => t + s.pct, 0);
  if (shares.length && Math.abs(total - 100) > 0.01) return json({ error: 'bad_request', message: `Shares add up to ${total}% — they need to total 100%.` }, 400);
  const stmts = [];
  if (id) {
    stmts.push(env.DB.prepare('UPDATE expense_pools SET name = ? WHERE id = ?').bind(name, id));
    stmts.push(env.DB.prepare('DELETE FROM pool_shares WHERE pool_id = ?').bind(id));
  } else {
    id = crypto.randomUUID();
    stmts.push(env.DB.prepare("INSERT INTO expense_pools (id, scope_type, scope_id, name, created_at) VALUES (?, 'user', ?, ?, ?)").bind(id, user.id, name, Date.now()));
  }
  for (const s of shares) stmts.push(env.DB.prepare('INSERT INTO pool_shares (pool_id, bucket_id, pct) VALUES (?, ?, ?)').bind(id, s.bucket_id, s.pct));
  await env.DB.batch(stmts);
  return json({ id });
}
export const createPool = (env, user, body) => writePool(env, user, body, null);
export async function patchPool(env, user, id, body) {
  return (await poolOk(env, user, id)) && id ? writePool(env, user, body, id) : json({ error: 'not_found' }, 404);
}
export async function deletePool(env, user, id) {
  if (!(await poolOk(env, user, id)) || !id) return json({ error: 'not_found' }, 404);
  await env.DB.batch([
    env.DB.prepare('UPDATE expenses SET pool_id = NULL WHERE pool_id = ?').bind(id),
    env.DB.prepare('DELETE FROM expense_pools WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// ── Import from Budget v2 (Expenses tab, Oct 2026) ─────
// [group, name, monthly $, destination]  destination: 'C' = Christine, 'P' = card pool, bucket name, or null
const V2 = [
  ['Subscriptions', 'LA Fitness', 32, 'P'], ['Subscriptions', 'Planet Fitness', 25, 'P'], ['Subscriptions', 'Netflix', 0, null],
  ['Subscriptions', 'Prime', 7.7, 'C'], ['Subscriptions', 'Hulu', 2.99, 'P'], ['Subscriptions', 'Disney', 0, null],
  ['Subscriptions', 'HBO', 0, null], ['Subscriptions', 'YouTube TV', 0, null], ['Subscriptions', 'IMDB Pro', 12.5, 'C'],
  ['Subscriptions', 'We Audition', 7.5, 'C'], ['Subscriptions', 'Actors Access', 4.54, 'C'], ['Subscriptions', 'SAG-AFTRA', 126.47, 'C'],
  ['Subscriptions', 'Weight Watchers', 12.5, 'C'], ['Subscriptions', 'Cinemark', 12, 'P'], ['Subscriptions', 'NYT Games', 6, 'P'],
  ['Subscriptions', 'ChatGPT', 20, 'C'], ['Subscriptions', 'Anthropic', 20, 'P'], ['Subscriptions', 'Microsoft Office', 0, null],
  ['Debts & services', 'Car Insurance', 231.88, 'C'], ['Debts & services', 'CL Life Insurance', 55, 'C'],
  ['Debts & services', 'ZP Life Insurance', 85.45, 'P'], ['Debts & services', 'Student Loan', 168.36, 'C'],
  ['Debts & services', 'HOA', 570, 'C'], ['Debts & services', 'Mortgage', 615, 'C'], ['Debts & services', 'LADWP (and gas)', 350, 'C'],
  ['Debts & services', 'Allowance', 400, 'C'], ['Debts & services', 'Meds', 160, 'P'], ['Debts & services', 'Health Insurance', 1060, 'P'],
  ['Other', 'Gasoline', 120, 'P'], ['Other', 'Food', 1100, 'P'], ['Other', 'Eat Out', 400, 'EatOut'],
  ['Other', 'Trad IRA', 300, 'IRAs'], ['Other', 'Roth IRA', 300, 'IRAs'], ['Other', 'Misc', 150, 'P'],
  ['Other', 'Clothes', 80, 'Clothes'], ['Other', 'Gifts', 50, 'Gifts'], ['Other', 'Travel', 160, 'Travel'],
  ['Other', 'Entertainment', 0, null], ['Other', 'Classes', 192, 'Classes'], ['Other', 'Personal Care', 120, 'PersCare'],
  ['Other', 'Splurge', 40, 'Splurge'], ['Other', 'Comedy', 100, 'Comedy'], ['Other', 'Savings', 60, 'Savings'],
  ['Other', 'Car', 40, 'Car'], ['Other', 'Dance', 100, 'Dance'], ['Other', 'Health Savings', 60, 'Health Savings'],
];

export async function importBudgetV2(env, user) {
  const has = await env.DB.prepare(`SELECT 1 FROM expenses e WHERE ${SCOPE('e')} LIMIT 1`).bind(user.id, user.household_id).first();
  if (has) return json({ error: 'conflict', message: 'You already have expenses — import only works on an empty list.' }, 409);
  const buckets = (await env.DB.prepare(`SELECT b.id, b.name FROM buckets b WHERE ${SCOPE('b')} AND b.archived = 0`)
    .bind(user.id, user.household_id).all()).results;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (...names) => {
    for (const n of names) { const b = buckets.find((x) => norm(x.name) === norm(n)); if (b) return b.id; }
    return null;
  };
  const christine = find('Christine', 'ToChristine');
  const chase = find('Chase'), wells = find('Wells');

  const stmts = [];
  let poolId = null;
  if (chase || wells) {
    poolId = crypto.randomUUID();
    stmts.push(env.DB.prepare("INSERT INTO expense_pools (id, scope_type, scope_id, name, created_at) VALUES (?, 'user', ?, 'Credit cards', ?)").bind(poolId, user.id, Date.now()));
    if (chase && wells) {
      stmts.push(env.DB.prepare('INSERT INTO pool_shares (pool_id, bucket_id, pct) VALUES (?, ?, 60), (?, ?, 40)').bind(poolId, chase, poolId, wells));
    } else {
      stmts.push(env.DB.prepare('INSERT INTO pool_shares (pool_id, bucket_id, pct) VALUES (?, ?, 100)').bind(poolId, chase || wells));
    }
  }
  const unmatched = [];
  let sort = 0;
  const now = Date.now();
  for (const [group, name, dollars, dest] of V2) {
    let bucketId = null, pool = null;
    if (dest === 'C') bucketId = christine;
    else if (dest === 'P') pool = poolId;
    else if (dest) bucketId = find(dest, name);
    if (dest && !bucketId && !pool) unmatched.push(name);
    stmts.push(env.DB.prepare(
      `INSERT INTO expenses (id, scope_type, scope_id, name, group_name, monthly_amount, bucket_id, pool_id, sort, created_at)
       VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.id, name, group, Math.round(dollars * 100), bucketId, pool, sort++, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, created: V2.length, unmatched });
}
