// Phase 4: buckets, paycheck template, the Plan grid, funding status and moves.
import { json, ptDate } from './util.js';

const KINDS = ['bill', 'card', 'goal', 'passthrough', 'spending'];
const MAX_CENTS = 1e9;

// ── Date helpers (all dates are 'YYYY-MM-DD') ──────────
const toMs = (iso) => Date.parse(iso + 'T00:00:00Z');
export function addDays(iso, n) {
  const d = new Date(toMs(iso));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthDate(y, m, day) {            // m is 1-12; clamps the day to the month's length
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  const len = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, len)).padStart(2, '0')}`;
}
export function nextMonthly(day, fromIso) {
  const [y, m] = fromIso.split('-').map(Number);
  const d = monthDate(y, m, day);
  return d >= fromIso ? d : monthDate(y, m + 1, day);
}
const prevMonthly = (day, dueIso) => { const [y, m] = dueIso.split('-').map(Number); return monthDate(y, m - 1, day); };
const addMonth = (iso) => { const [y, m, d] = iso.split('-').map(Number); return monthDate(y, m + 1, d); };

// Paydays: one before the most recent, through `count` upcoming.
export function paydays(template, today, count) {
  const step = template.cadence === 'biweekly' ? 14 : 7;
  const diff = Math.floor((toMs(today) - toMs(template.anchor_date)) / 86400000);
  const k = Math.floor(diff / step);
  const last = addDays(template.anchor_date, k * step);   // most recent payday <= today
  const out = [];
  for (let i = -1; i < count; i++) out.push(addDays(last, i * step));
  return { list: out, last, step };
}

// Paydays strictly after `after` and strictly before `before`.
export function countPaydays(template, after, before) {
  const step = template.cadence === 'biweekly' ? 14 : 7;
  const diff = Math.floor((toMs(after) - toMs(template.anchor_date)) / 86400000);
  let d = addDays(template.anchor_date, (Math.floor(diff / step) + 1) * step);
  let n = 0;
  while (d < before && n < 60) { if (d > after) n++; d = addDays(d, step); }
  return n;
}

// ── Scope helpers ──────────────────────────────────────
const BUCKET_SCOPE = `((b.scope_type = 'user' AND b.scope_id = ?) OR (b.scope_type = 'household' AND b.scope_id = ?))`;

async function getTemplate(env, user, create = false) {
  let t = await env.DB.prepare('SELECT * FROM paycheck_templates WHERE user_id = ? AND active = 1 LIMIT 1').bind(user.id).first();
  if (!t && create) {
    // Default: weekly, anchored on the most recent Friday.
    const today = ptDate();
    const dow = new Date(toMs(today)).getUTCDay();
    t = { id: crypto.randomUUID(), user_id: user.id, cadence: 'weekly', anchor_date: addDays(today, -((dow - 5 + 7) % 7)), expected_total: null, active: 1 };
    await env.DB.prepare('INSERT INTO paycheck_templates (id, user_id, cadence, anchor_date, expected_total, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(t.id, t.user_id, t.cadence, t.anchor_date, t.expected_total).run();
  }
  return t;
}

async function ownedBucket(env, user, id) {
  return env.DB.prepare(`SELECT b.* FROM buckets b WHERE b.id = ? AND ${BUCKET_SCOPE}`).bind(id, user.id, user.household_id).first();
}

async function ownAccount(env, user, id) {
  if (!id) return true;
  return !!(await env.DB.prepare('SELECT 1 FROM accounts WHERE id = ? AND owner_user_id = ?').bind(id, user.id).first());
}

const centsOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= MAX_CENTS ? n : NaN;
};

// ── Template ───────────────────────────────────────────
export async function putTemplate(env, user, body) {
  const t = await getTemplate(env, user, true);
  const cadence = body.cadence === 'biweekly' ? 'biweekly' : 'weekly';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(body.anchor_date || '') ? body.anchor_date : t.anchor_date;
  const expected = 'expected_total' in body ? centsOrNull(body.expected_total) : t.expected_total;
  if (Number.isNaN(expected)) return json({ error: 'bad_request', message: 'Paycheck amount is invalid.' }, 400);
  await env.DB.prepare('UPDATE paycheck_templates SET cadence = ?, anchor_date = ?, expected_total = ? WHERE id = ?')
    .bind(cadence, anchor, expected, t.id).run();
  return json({ ok: true });
}

// ── Buckets ────────────────────────────────────────────
async function writeBucket(env, user, body, existing) {
  const b = existing ? { ...existing } : { id: crypto.randomUUID(), scope_type: 'user', scope_id: user.id, sort: Date.now() % 1e9, archived: 0 };
  if ('name' in body || !existing) {
    b.name = String(body.name || '').trim().slice(0, 40);
    if (!b.name) return { error: 'Name is required.' };
  }
  if ('kind' in body || !existing) {
    b.kind = KINDS.includes(body.kind) ? body.kind : 'goal';
  }
  for (const k of ['linked_account_id', 'card_account_id', 'category_id']) {
    if (k in body) b[k] = body[k] || null;
  }
  if (!(await ownAccount(env, user, b.linked_account_id)) || !(await ownAccount(env, user, b.card_account_id))) {
    return { error: 'Unknown account.' };
  }
  if (b.category_id && !(await env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').bind(b.category_id, user.household_id).first())) {
    return { error: 'Unknown category.' };
  }
  b.backing = b.linked_account_id ? 'account' : 'none';
  for (const k of ['target_amount', 'goal_amount']) {
    if (k in body) { b[k] = centsOrNull(body[k]); if (Number.isNaN(b[k])) return { error: 'Amount is invalid.' }; }
  }
  if ('due_day' in body) {
    const d = body.due_day === null || body.due_day === '' ? null : Math.round(Number(body.due_day));
    if (d !== null && !(d >= 1 && d <= 31)) return { error: 'Due day must be 1–31.' };
    b.due_day = d;
  }
  if ('archived' in body) b.archived = body.archived ? 1 : 0;
  b.cadence = b.kind === 'bill' ? 'monthly' : 'none';

  const stmts = [env.DB.prepare(
    `INSERT INTO buckets (id, scope_type, scope_id, name, kind, backing, linked_account_id, card_account_id, target_amount,
        cadence, due_day, goal_amount, category_id, archived, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, backing = excluded.backing,
        linked_account_id = excluded.linked_account_id, card_account_id = excluded.card_account_id,
        target_amount = excluded.target_amount, cadence = excluded.cadence, due_day = excluded.due_day,
        goal_amount = excluded.goal_amount, category_id = excluded.category_id, archived = excluded.archived`
  ).bind(b.id, b.scope_type, b.scope_id, b.name, b.kind, b.backing, b.linked_account_id || null, b.card_account_id || null,
    b.target_amount ?? null, b.cadence, b.due_day ?? null, b.goal_amount ?? null, b.category_id || null, b.archived, b.sort)];

  if ('weekly_amount' in body) {
    const amt = centsOrNull(body.weekly_amount);
    if (Number.isNaN(amt)) return { error: 'Weekly amount is invalid.' };
    const t = await getTemplate(env, user, true);
    stmts.push(amt === null
      ? env.DB.prepare('DELETE FROM template_allocations WHERE template_id = ? AND bucket_id = ?').bind(t.id, b.id)
      : env.DB.prepare('INSERT OR REPLACE INTO template_allocations (template_id, bucket_id, amount) VALUES (?, ?, ?)').bind(t.id, b.id, amt));
  }
  await env.DB.batch(stmts);
  return { id: b.id };
}

export async function createBucket(env, user, body) {
  const r = await writeBucket(env, user, body, null);
  return r.error ? json({ error: 'bad_request', message: r.error }, 400) : json(r);
}

export async function patchBucket(env, user, id, body) {
  const existing = await ownedBucket(env, user, id);
  if (!existing) return json({ error: 'not_found' }, 404);
  const r = await writeBucket(env, user, body, existing);
  return r.error ? json({ error: 'bad_request', message: r.error }, 400) : json(r);
}

export async function reorderBuckets(env, user, ids) {
  const stmts = ids.slice(0, 90).map((id, i) =>
    env.DB.prepare(`UPDATE buckets SET sort = ? WHERE id = ? AND ((scope_type = 'user' AND scope_id = ?) OR (scope_type = 'household' AND scope_id = ?))`)
      .bind(i, id, user.id, user.household_id));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

// "Start from my spreadsheet": the buckets and weekly amounts from Budget App Example.xlsx (Nov 13 column).
const SEED = [
  ['Mortgage', 'bill', 20000, { vault: 'mortg' }],
  ['HOA', 'bill', 14500, { vault: 'hoa', target: 62850 }],
  ['InCharge', 'bill', 0, { vault: 'incharge', target: 62500 }],
  ['Chase', 'card', 40000, { vault: 'chase', card: 'chase' }],
  ['Wells', 'card', 35000, { vault: 'wells', card: 'wells' }],
  ['IRA', 'passthrough', 0, {}],
  ['Roth', 'passthrough', 0, {}],
  ['CL IRA', 'passthrough', 11500, {}],
  ['Splurge', 'goal', 2500, { vault: 'splurge' }],
  ['Comedy', 'goal', 2900, { vault: 'comedy' }],
  ['Allowance', 'goal', 11000, { vault: 'allowance' }],
  ['Savings', 'goal', 6000, { vault: 'savings', exactVault: true }],
  ['Clothes', 'goal', 3000, { vault: 'clothes' }],
  ['Car', 'goal', 2500, { vault: 'car' }],
  ['Travel', 'goal', 3000, { vault: 'travel' }],
  ['Emergency Fund', 'goal', 0, { vault: 'emergency' }],
  ['Spending money', 'spending', 28900, { checking: 'wells' }],
];

export async function seedBuckets(env, user) {
  const has = await env.DB.prepare(`SELECT 1 FROM buckets b WHERE ${BUCKET_SCOPE} LIMIT 1`).bind(user.id, user.household_id).first();
  if (has) return json({ error: 'conflict', message: 'You already have buckets.' }, 409);
  const accts = (await env.DB.prepare(
    `SELECT a.id, LOWER(COALESCE(a.display_name, a.name)) AS nm, LOWER(a.name) AS raw, a.type, a.subtype, a.account_group,
            LOWER(i.institution_name) AS inst
       FROM accounts a JOIN plaid_items i ON i.id = a.item_id WHERE a.owner_user_id = ? AND a.hidden = 0`
  ).bind(user.id).all()).results;
  const used = new Set();
  const pick = (fn) => { const a = accts.find((x) => !used.has(x.id) && fn(x)); if (a) used.add(a.id); return a ? a.id : null; };
  const isSofiSaving = (a) => a.type === 'depository' && a.inst.includes('sofi') && a.subtype !== 'checking';

  const t = await getTemplate(env, user, true);
  const stmts = [];
  let sort = 0, linked = 0;
  for (const [name, kind, weekly, o] of SEED) {
    const id = crypto.randomUUID();
    let vault = null, card = null;
    if (o.vault) {
      vault = o.exactVault
        ? pick((a) => isSofiSaving(a) && a.account_group === 'vault' && (a.nm === o.vault || a.raw === o.vault))
        : pick((a) => isSofiSaving(a) && (a.nm.includes(o.vault) || a.raw.includes(o.vault)) && !/^savings?$/.test(a.raw));
    }
    if (o.checking) vault = pick((a) => a.type === 'depository' && a.subtype === 'checking' && a.inst.includes(o.checking));
    if (o.card) card = accts.find((a) => a.type === 'credit' && a.inst.includes(o.card))?.id || null;
    if (vault) linked++;
    stmts.push(env.DB.prepare(
      `INSERT INTO buckets (id, scope_type, scope_id, name, kind, backing, linked_account_id, card_account_id, target_amount, cadence, archived, sort)
       VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(id, user.id, name, kind, vault ? 'account' : 'none', vault, card, o.target ?? null, kind === 'bill' ? 'monthly' : 'none', sort++));
    if (weekly) stmts.push(env.DB.prepare('INSERT OR REPLACE INTO template_allocations (template_id, bucket_id, amount) VALUES (?, ?, ?)').bind(t.id, id, weekly));
  }
  if (!t.expected_total) stmts.push(env.DB.prepare('UPDATE paycheck_templates SET expected_total = ? WHERE id = ?').bind(151900 + 28900, t.id));
  await env.DB.batch(stmts);
  return json({ ok: true, created: SEED.length, linked });
}

// ── Cells ──────────────────────────────────────────────
export async function putCell(env, user, body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.pay_date || '')) return json({ error: 'bad_request', message: 'Bad date.' }, 400);
  const b = await ownedBucket(env, user, body.bucket_id);
  if (!b) return json({ error: 'not_found' }, 404);
  const cur = await env.DB.prepare('SELECT amount, done FROM plan_cells WHERE user_id = ? AND pay_date = ? AND bucket_id = ?')
    .bind(user.id, body.pay_date, b.id).first() || { amount: null, done: 0 };
  const amount = 'amount' in body ? centsOrNull(body.amount) : cur.amount;
  if (Number.isNaN(amount)) return json({ error: 'bad_request', message: 'Amount is invalid.' }, 400);
  const done = 'done' in body ? (body.done ? 1 : 0) : cur.done;
  if (amount === null && !done) {
    await env.DB.prepare('DELETE FROM plan_cells WHERE user_id = ? AND pay_date = ? AND bucket_id = ?').bind(user.id, body.pay_date, b.id).run();
  } else {
    await env.DB.prepare('INSERT OR REPLACE INTO plan_cells (user_id, pay_date, bucket_id, amount, done) VALUES (?, ?, ?, ?, ?)')
      .bind(user.id, body.pay_date, b.id, amount, done).run();
  }
  return json({ ok: true });
}

// ── The plan ───────────────────────────────────────────
export async function getPlan(env, user, weeks) {
  const today = ptDate();
  const template = await getTemplate(env, user, false);
  const buckets = (await env.DB.prepare(
    `SELECT b.*, ta.amount AS weekly_amount,
            COALESCE(la.display_name, la.name) AS linked_name, lb.current AS linked_balance, lb.date AS linked_balance_date,
            COALESCE(ca.display_name, ca.name) AS card_name, cb.current AS card_balance,
            cs.statement_balance, cs.statement_date, cs.due_date AS statement_due, cs.last_payment_amount, cs.last_payment_date,
            c.name AS category_name
       FROM buckets b
       LEFT JOIN paycheck_templates pt ON pt.user_id = ? AND pt.active = 1
       LEFT JOIN template_allocations ta ON ta.template_id = pt.id AND ta.bucket_id = b.id
       LEFT JOIN accounts la ON la.id = b.linked_account_id
       LEFT JOIN balance_snapshots lb ON lb.account_id = la.id AND lb.date = (SELECT MAX(date) FROM balance_snapshots WHERE account_id = la.id)
       LEFT JOIN accounts ca ON ca.id = b.card_account_id
       LEFT JOIN balance_snapshots cb ON cb.account_id = ca.id AND cb.date = (SELECT MAX(date) FROM balance_snapshots WHERE account_id = ca.id)
       LEFT JOIN card_statements cs ON cs.account_id = ca.id AND cs.statement_date = (SELECT MAX(statement_date) FROM card_statements WHERE account_id = ca.id)
       LEFT JOIN categories c ON c.id = b.category_id
      WHERE ${BUCKET_SCOPE} AND b.archived = 0
      ORDER BY b.sort, b.name`
  ).bind(user.id, user.id, user.household_id).all()).results;

  if (!template) return json({ template: null, buckets, paydays: [], cells: {}, funding: [], moves: null, today });

  const count = Math.min(Math.max(weeks || 8, 2), 26);
  const { list: days, last } = paydays(template, today, count);
  const first = days[0];
  const lastDay = days[days.length - 1];

  const monthStart = today.slice(0, 8) + '01';
  const linkedIds = buckets.map((b) => b.linked_account_id).filter(Boolean);
  const catIds = buckets.map((b) => b.category_id).filter(Boolean);
  const ph = (n) => Array(n).fill('?').join(',') || 'NULL';
  const [cellsRes, payRes, vaultInRes, spendRes] = await env.DB.batch([
    env.DB.prepare('SELECT pay_date, bucket_id, amount, done FROM plan_cells WHERE user_id = ? AND pay_date >= ? AND pay_date <= ?')
      .bind(user.id, addDays(first, -60), lastDay),
    env.DB.prepare(
      `SELECT t.date, -t.amount AS amount FROM transactions t JOIN accounts a ON a.id = t.account_id
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE a.owner_user_id = ? AND t.removed = 0 AND t.amount < 0 AND t.date >= ?
          AND (t.pfc_detailed = 'INCOME_WAGES' OR (c.kind = 'income' AND c.name = 'Paycheck'))`
    ).bind(user.id, addDays(first, -3)),
    env.DB.prepare(
      `SELECT account_id, date, -amount AS amount FROM transactions
        WHERE account_id IN (${ph(linkedIds.length)}) AND removed = 0 AND amount < 0 AND date >= ?`
    ).bind(...linkedIds, addDays(first, -3)),
    env.DB.prepare(
      `SELECT t.category_id, SUM(t.amount) AS spent FROM transactions t
        WHERE t.category_id IN (${ph(catIds.length)}) AND t.removed = 0 AND t.is_transfer = 0 AND t.date >= ?
          AND t.account_id IN (SELECT a.id FROM accounts a JOIN users ow ON ow.id = a.owner_user_id WHERE ow.household_id = ?)
        GROUP BY t.category_id`
    ).bind(...catIds, monthStart, user.household_id),
  ]);

  // cells[bucket][date] = { amount, override, done, auto }
  const overrides = new Map(cellsRes.results.map((c) => [c.bucket_id + '|' + c.pay_date, c]));
  const vaultIns = vaultInRes.results;
  const cells = {};
  for (const b of buckets) {
    cells[b.id] = {};
    for (const d of days) {
      const o = overrides.get(b.id + '|' + d);
      const amount = o && o.amount !== null ? o.amount : (b.weekly_amount || 0);
      // Auto-tick: a deposit of exactly this amount into the linked vault within the payday's week.
      const auto = !!(amount > 0 && b.linked_account_id && d <= today &&
        vaultIns.some((v) => v.account_id === b.linked_account_id && v.amount === amount && v.date >= addDays(d, -2) && v.date <= addDays(d, 6)));
      cells[b.id][d] = { amount, override: !!(o && o.amount !== null), done: !!(o && o.done), auto };
    }
  }

  // Paycheck rows: expected vs what actually arrived (Thursday-evening deposits count for Friday paydays).
  const pays = days.map((d) => {
    const actual = payRes.results.filter((p) => p.date >= addDays(d, -2) && p.date <= addDays(d, 1)).reduce((s, p) => s + p.amount, 0);
    const allocated = buckets.reduce((s, b) => s + cells[b.id][d].amount, 0);
    const income = actual || template.expected_total || 0;
    return { date: d, expected: template.expected_total, actual: actual || null, allocated, left: income - allocated, is_past: d <= today, is_current: d === last };
  });

  // Funding for bills and cards.
  const funding = [];
  for (const b of buckets) {
    if (b.kind !== 'bill' && b.kind !== 'card') continue;
    let due = null, need = null, basis = null, prevDue = null;
    if (b.kind === 'card') {
      const paid = b.last_payment_date && b.statement_date && b.last_payment_date >= b.statement_date &&
        (b.last_payment_amount || 0) >= (b.statement_balance || 0) - 100;
      if (b.statement_due && b.statement_due >= today && !paid) {
        due = b.statement_due; need = b.statement_balance; basis = 'statement';
      } else if (b.card_account_id) {
        due = b.statement_due ? (b.statement_due >= today ? addMonth(b.statement_due) : nextMonthly(Number(b.statement_due.slice(8)), today)) : null;
        need = b.card_balance; basis = 'current balance';
      }
      if (due) prevDue = addDays(due, -30);
    } else if (b.due_day) {
      due = nextMonthly(b.due_day, today);
      prevDue = prevMonthly(b.due_day, due);
      need = b.target_amount; basis = 'bill';
    }
    if (!due || need === null || need === undefined) {
      funding.push({ bucket_id: b.id, name: b.name, kind: b.kind, missing: b.kind === 'card' ? 'Link the credit card this vault pays.' : 'Set the bill amount and due day.' });
      continue;
    }
    // Money that will be in the vault by the due date: balance now + allocations not yet moved.
    const upcoming = days.filter((d) => d >= last && d < due && !(cells[b.id][d].done || cells[b.id][d].auto));
    const planned = upcoming.reduce((s, d) => s + cells[b.id][d].amount, 0);
    const balance = b.linked_account_id ? (b.linked_balance || 0) : 0;
    const available = balance + planned;
    const windowDays = countPaydays(template, prevDue, due) || 1;
    funding.push({
      bucket_id: b.id, name: b.name, kind: b.kind, due, need, basis, balance, planned, available,
      short: Math.max(0, need - available), suggested: Math.ceil(need / windowDays / 100) * 100,
      no_vault: !b.linked_account_id,
    });
  }
  funding.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);

  const spent = Object.fromEntries(spendRes.results.map((r) => [r.category_id, r.spent]));
  for (const b of buckets) b.spent_this_month = b.category_id ? (spent[b.category_id] || 0) : null;

  // Moves for the most recent payday.
  const moves = {
    pay_date: last,
    // 'spending' buckets arrive by direct deposit, so there's nothing to move by hand.
    items: buckets.filter((b) => b.kind !== 'spending' && cells[b.id][last].amount > 0).map((b) => ({
      bucket_id: b.id, name: b.name, kind: b.kind, amount: cells[b.id][last].amount,
      to: b.kind === 'passthrough' ? 'checking → retirement' : (b.linked_name || 'vault (not linked)'),
      done: cells[b.id][last].done, auto: cells[b.id][last].auto,
    })),
  };

  return json({ template, buckets, paydays: pays, cells, funding, moves, today });
}
