// Phase 3: transactions list/edit, categories, rules, reports.
import { json } from './util.js';
import { ensureCategories, ensureTags, categorize, applyRuleToHistory, tagStatements, HH_ACCOUNTS } from './categorize.js';

// Transactions the caller may see: on visible, non-hidden accounts.
const TX_FROM = `FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  JOIN users ow ON ow.id = a.owner_user_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories pc ON pc.id = c.parent_id`;
const TX_VISIBLE = `(a.owner_user_id = ? OR (a.visibility = 'household' AND ow.household_id = ?)) AND a.hidden = 0 AND t.removed = 0`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// First visit after Phase 3 deploys: create the starter categories, then categorize all history once.
async function ensureReady(env, householdId) {
  if (await ensureCategories(env, householdId)) await categorize(env, householdId, { windowDays: 120 });
  else await ensureTags(env, householdId);
}
export { ensureReady };

// A transaction's live tags (not ones you switched off), as "id,id,…". One primary-key range lookup per row.
const TAG_IDS = `(SELECT group_concat(tt.tag_id) FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.source != 'off')`;
const HAS_TAG = `EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.source != 'off'`;

// ── Categories ─────────────────────────────────────────

export async function listCategories(env, user) {
  await ensureReady(env, user.household_id);
  const { results } = await env.DB.prepare(
    'SELECT id, name, parent_id, kind, color, budget_monthly, archived, sort FROM categories WHERE household_id = ? ORDER BY sort, name'
  ).bind(user.household_id).all();
  return json({ categories: results });
}

export async function createCategory(env, user, body) {
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) return json({ error: 'bad_request', message: 'Name is required.' }, 400);
  await ensureReady(env, user.household_id);
  const parent = body.parent_id
    ? await env.DB.prepare('SELECT id, kind FROM categories WHERE id = ? AND household_id = ? AND parent_id IS NULL').bind(body.parent_id, user.household_id).first()
    : null;
  if (body.parent_id && !parent) return json({ error: 'bad_request', message: 'Unknown group.' }, 400);
  const kind = parent ? parent.kind : (['expense', 'income', 'transfer'].includes(body.kind) ? body.kind : 'expense');
  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM categories WHERE household_id = ?').bind(user.household_id).first();
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO categories (id, household_id, name, parent_id, kind, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, user.household_id, name, parent ? parent.id : null, kind, (max ? max.m : 0) + 1).run();
  return json({ id });
}

export async function patchCategory(env, user, id, body) {
  const cat = await env.DB.prepare('SELECT * FROM categories WHERE id = ? AND household_id = ?').bind(id, user.household_id).first();
  if (!cat) return json({ error: 'not_found' }, 404);
  const name = 'name' in body ? String(body.name || '').trim().slice(0, 40) || cat.name : cat.name;
  const archived = 'archived' in body ? (body.archived ? 1 : 0) : cat.archived;
  const budget = 'budget_monthly' in body
    ? (body.budget_monthly === null || body.budget_monthly === '' ? null : Math.round(Number(body.budget_monthly)))
    : cat.budget_monthly;
  if (budget !== null && !Number.isFinite(budget)) return json({ error: 'bad_request', message: 'Budget is invalid.' }, 400);
  await env.DB.prepare('UPDATE categories SET name = ?, archived = ?, budget_monthly = ? WHERE id = ?')
    .bind(name, archived, budget, id).run();
  return json({ ok: true });
}

// ── Transactions ───────────────────────────────────────

export async function listTransactions(env, user, q) {
  await ensureReady(env, user.household_id);
  const where = [TX_VISIBLE];
  const params = [user.id, user.household_id];
  const from = q.get('from'), to = q.get('to');
  if (from && DATE_RE.test(from)) { where.push('t.eff_date >= ?'); params.push(from); }
  if (to && DATE_RE.test(to)) { where.push('t.eff_date <= ?'); params.push(to); }
  if (q.get('account')) { where.push('t.account_id = ?'); params.push(q.get('account')); }
  const cat = q.get('category');
  if (cat === 'uncategorized') where.push('t.category_id IS NULL');
  else if (cat) { where.push('(t.category_id = ? OR c.parent_id = ?)'); params.push(cat, cat); }
  if (q.get('transfers') === 'hide') where.push('t.is_transfer = 0');
  const tag = q.get('tag');
  if (tag === 'none') where.push(`NOT ${HAS_TAG})`);
  else if (tag) { where.push(`${HAS_TAG} AND tt.tag_id = ?)`); params.push(tag); }
  const search = (q.get('q') || '').trim();
  if (search) {
    where.push(`(COALESCE(t.merchant_name, '') || ' ' || COALESCE(t.name, '') || ' ' || COALESCE(t.notes, '')) LIKE ? ESCAPE '\\'`);
    params.push('%' + search.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
  }
  const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500);
  const offset = Math.max(Number(q.get('offset')) || 0, 0);
  const W = where.join(' AND ');
  const [rows, agg] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.id, t.date, t.eff_date, t.authorized_date, t.amount, t.merchant_name, t.name, t.pending, t.notes,
              t.category_id, t.category_source, t.is_transfer, t.is_income, t.pfc_primary, t.pfc_detailed,
              t.account_id, COALESCE(a.display_name, a.name) AS account_name, a.mask AS account_mask,
              c.name AS category_name, c.kind AS category_kind, pc.name AS category_group, ${TAG_IDS} AS tag_ids
         ${TX_FROM} WHERE ${W}
        ORDER BY t.eff_date DESC, t.pending DESC, t.date DESC, t.id LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN t.is_transfer = 0 AND t.is_income = 0 THEN t.amount ELSE 0 END), 0) AS spending,
              COALESCE(SUM(CASE WHEN t.is_income = 1 THEN -t.amount ELSE 0 END), 0) AS income
         ${TX_FROM} WHERE ${W}`
    ).bind(...params),
  ]);
  return json({ transactions: rows.results, total: agg.results[0].n, spending: agg.results[0].spending, income: agg.results[0].income });
}

async function visibleTxIds(env, user, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT t.id ${TX_FROM} WHERE ${TX_VISIBLE} AND t.id IN (${ph})`)
    .bind(user.id, user.household_id, ...ids).all();
  return results.map((r) => r.id);
}

async function validCategory(env, user, categoryId) {
  if (categoryId === null) return true;
  return !!(await env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').bind(categoryId, user.household_id).first());
}

async function validTags(env, user, tagIds) {
  if (!tagIds.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id FROM tags WHERE household_id = ? AND id IN (${tagIds.map(() => '?').join(',')})`
  ).bind(user.household_id, ...tagIds).all();
  return results.length === new Set(tagIds).size ? results.map((r) => r.id) : null;
}
const idList = (v) => (Array.isArray(v) ? v.map(String).slice(0, 20) : []);

// Body: { category_id?, notes?, tags_add?, tags_remove? } for one id, or { ids, … } in bulk.
// Added tags are 'manual'; removed ones become 'off' so automatic tagging doesn't bring them back.
export async function patchTransactions(env, user, ids, body) {
  const ok = await visibleTxIds(env, user, ids.slice(0, 90));
  if (!ok.length) return json({ error: 'not_found' }, 404);
  const stmts = [];
  const add = await validTags(env, user, idList(body.tags_add));
  const remove = await validTags(env, user, idList(body.tags_remove));
  if (!add || !remove) return json({ error: 'bad_request', message: 'Unknown tag.' }, 400);
  for (const [tagIds, source] of [[add, 'manual'], [remove, 'off']]) {
    for (const tagId of tagIds) {
      stmts.push(env.DB.prepare(
        `INSERT INTO transaction_tags (transaction_id, tag_id, source)
         SELECT value, ?, ? FROM json_each(?) WHERE true
         ON CONFLICT(transaction_id, tag_id) DO UPDATE SET source = excluded.source`
      ).bind(tagId, source, JSON.stringify(ok)));
    }
  }
  if ('category_id' in body) {
    const cid = body.category_id || null;
    if (!(await validCategory(env, user, cid))) return json({ error: 'bad_request', message: 'Unknown category.' }, 400);
    for (const id of ok) {
      stmts.push(env.DB.prepare(
        `UPDATE transactions SET category_id = ?, category_source = 'manual', transfer_pair_id = NULL,
                is_transfer = COALESCE((SELECT kind = 'transfer' FROM categories WHERE id = ?), 0),
                is_income = COALESCE((SELECT kind = 'income' FROM categories WHERE id = ?), 0)
          WHERE id = ?`).bind(cid, cid, cid, id));
    }
  }
  if ('notes' in body && ok.length === 1) {
    const notes = body.notes === null ? null : String(body.notes).slice(0, 500) || null;
    stmts.push(env.DB.prepare('UPDATE transactions SET notes = ? WHERE id = ?').bind(notes, ok[0]));
  }
  if (!stmts.length) return json({ error: 'bad_request', message: 'Nothing to change.' }, 400);
  await env.DB.batch(stmts);
  return json({ ok: true, updated: ok.length });
}

// "Let the app decide again" for one transaction: clears a manual choice.
export async function resetTransaction(env, user, id) {
  const ok = await visibleTxIds(env, user, [id]);
  if (!ok.length) return json({ error: 'not_found' }, 404);
  await env.DB.prepare("UPDATE transactions SET category_id = NULL, category_source = 'none' WHERE id = ?").bind(id).run();
  await categorize(env, user.household_id);
  return json({ ok: true });
}

// ── Rules ──────────────────────────────────────────────

export async function listRules(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.priority, r.field, r.op, r.value, r.account_id, r.amount_min, r.amount_max, r.category_id, r.tag_id, r.enabled,
            c.name AS category_name, tg.name AS tag_name, COALESCE(a.display_name, a.name) AS account_name
       FROM category_rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN tags tg ON tg.id = r.tag_id
      WHERE r.household_id = ? ORDER BY r.priority, r.created_at`
  ).bind(user.household_id).all();
  return json({ rules: results });
}

export async function createRule(env, user, body) {
  const value = String(body.value || '').trim().slice(0, 80);
  const op = ['contains', 'equals', 'starts_with'].includes(body.op) ? body.op : 'contains';
  if (!value) return json({ error: 'bad_request', message: 'Enter the text to match.' }, 400);
  const categoryId = body.category_id || null, tagId = body.tag_id || null;
  if (!categoryId && !tagId) return json({ error: 'bad_request', message: 'Pick a category or a tag.' }, 400);
  if (categoryId && !(await validCategory(env, user, categoryId))) return json({ error: 'bad_request', message: 'Unknown category.' }, 400);
  if (tagId && !(await validTags(env, user, [tagId]))) return json({ error: 'bad_request', message: 'Unknown tag.' }, 400);
  const rule = {
    id: crypto.randomUUID(), household_id: user.household_id, priority: Number.isInteger(body.priority) ? body.priority : 100,
    field: 'text', op, value, account_id: body.account_id || null,
    amount_min: Number.isFinite(body.amount_min) ? body.amount_min : null,
    amount_max: Number.isFinite(body.amount_max) ? body.amount_max : null,
    category_id: categoryId, tag_id: tagId,
  };
  await env.DB.prepare(
    `INSERT INTO category_rules (id, household_id, priority, field, op, value, account_id, amount_min, amount_max, category_id, tag_id, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(rule.id, rule.household_id, rule.priority, rule.field, rule.op, rule.value, rule.account_id,
    rule.amount_min, rule.amount_max, rule.category_id, rule.tag_id, Date.now()).run();
  let changed = null;
  if (body.apply !== false) {
    await applyRuleToHistory(env, user.household_id, rule);
    changed = true;
  }
  return json({ id: rule.id, applied: !!changed });
}

export async function deleteRule(env, user, id) {
  // Tags a rule added go with it (categories stay until "Re-apply to all history", as before).
  const rule = await env.DB.prepare('SELECT * FROM category_rules WHERE id = ? AND household_id = ?').bind(id, user.household_id).first();
  if (!rule) return json({ ok: true });
  await env.DB.prepare('DELETE FROM category_rules WHERE id = ?').bind(id).run();
  if (rule.tag_id) {
    const rules = (await env.DB.prepare('SELECT * FROM category_rules WHERE household_id = ? AND enabled = 1 AND tag_id = ?')
      .bind(user.household_id, rule.tag_id).all()).results;
    await env.DB.batch(tagStatements(env, user.household_id, rules, { tagId: rule.tag_id, reset: true }));
  }
  return json({ ok: true });
}

export async function rerunCategorization(env, user) {
  await categorize(env, user.household_id, { reset: true });
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE account_id IN (${HH_ACCOUNTS}) AND removed = 0 AND category_id IS NULL`)
    .bind(user.household_id).first();
  return json({ ok: true, uncategorized: n ? n.n : 0 });
}

// ── Reports ────────────────────────────────────────────

function monthsBack(to, n) {
  const [y, m] = to.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - (n - 1), 1));
  return d.toISOString().slice(0, 10);
}

export async function reportSummary(env, user, q) {
  const from = q.get('from'), to = q.get('to');
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return json({ error: 'bad_request', message: 'from/to must be YYYY-MM-DD' }, 400);
  }
  await ensureReady(env, user.household_id);
  const base = [user.id, user.household_id];
  const EXPENSE = `t.is_transfer = 0 AND t.is_income = 0`;
  // Spending-by-month chart window: the 12 months ending at trend_to (front end pins it to
  // the current month so clicking a bar doesn't slide later months off). Defaults to `to`.
  const trendTo = DATE_RE.test(q.get('trend_to') || '') ? q.get('trend_to') : to;
  const trendFrom = monthsBack(trendTo, 12);
  const [byCat, totals, months, merchants, uncategorized, incomeByCat, byTag, untagged] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.category_id, c.name, c.parent_id, pc.name AS parent_name, c.budget_monthly,
              SUM(t.amount) AS total, COUNT(*) AS n
         ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ? AND ${EXPENSE}
        GROUP BY t.category_id ORDER BY total DESC`
    ).bind(...base, from, to),
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN ${EXPENSE} THEN t.amount ELSE 0 END), 0) AS spending,
              COALESCE(SUM(CASE WHEN t.is_income = 1 THEN -t.amount ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN t.is_transfer = 1 THEN 1 ELSE 0 END), 0) AS transfers
         ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ?`
    ).bind(...base, from, to),
    env.DB.prepare(
      `SELECT substr(t.eff_date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN ${EXPENSE} THEN t.amount ELSE 0 END), 0) AS spending,
              COALESCE(SUM(CASE WHEN t.is_income = 1 THEN -t.amount ELSE 0 END), 0) AS income
         ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ?
        GROUP BY month ORDER BY month`
    ).bind(...base, trendFrom, trendTo),
    env.DB.prepare(
      `SELECT COALESCE(t.merchant_name, t.name) AS merchant, SUM(t.amount) AS total, COUNT(*) AS n
         ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ? AND ${EXPENSE}
        GROUP BY merchant HAVING total > 0 ORDER BY total DESC LIMIT 10`
    ).bind(...base, from, to),
    env.DB.prepare(
      `SELECT COUNT(*) AS n ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ? AND t.category_id IS NULL`
    ).bind(...base, from, to),
    env.DB.prepare(
      `SELECT t.category_id, c.name, c.parent_id, pc.name AS parent_name, SUM(-t.amount) AS total, COUNT(*) AS n
         ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ? AND t.is_income = 1
        GROUP BY t.category_id ORDER BY total DESC`
    ).bind(...base, from, to),
    // Spending per category per tag. A purchase with two tags counts under both.
    env.DB.prepare(
      `SELECT t.category_id, tt.tag_id, tg.name AS tag_name, SUM(t.amount) AS total, COUNT(*) AS n
         ${TX_FROM} JOIN transaction_tags tt ON tt.transaction_id = t.id AND tt.source != 'off'
         JOIN tags tg ON tg.id = tt.tag_id
        WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ? AND ${EXPENSE}
        GROUP BY t.category_id, tt.tag_id ORDER BY total DESC`
    ).bind(...base, from, to),
    env.DB.prepare(
      `SELECT t.category_id, SUM(t.amount) AS total, COUNT(*) AS n
         ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ? AND ${EXPENSE} AND NOT ${HAS_TAG})
        GROUP BY t.category_id`
    ).bind(...base, from, to),
  ]);
  return json({
    from, to,
    spending: totals.results[0].spending, income: totals.results[0].income,
    by_category: byCat.results, months: months.results, merchants: merchants.results,
    uncategorized: uncategorized.results[0].n,
    income_by_category: incomeByCat.results,
    by_category_tag: byTag.results, by_category_untagged: untagged.results,
  });
}

// Spending by month for one category (v0.11.0) — the Reports chart's category picker.
// `category` = a category id (a parent group includes its subcategories) or 'uncategorized'.
// Same 12-month eff_date range as the summary's overall trend, so it reads no more rows than that.
export async function reportTrend(env, user, q) {
  const to = q.get('to'), cat = q.get('category') || '';
  if (!DATE_RE.test(to || '') || !cat) return json({ error: 'bad_request', message: 'to (YYYY-MM-DD) and category are required' }, 400);
  await ensureReady(env, user.household_id);
  const base = [user.id, user.household_id];
  let catSql, catArgs;
  if (cat === 'uncategorized') {
    catSql = 't.category_id IS NULL'; catArgs = [];
  } else {
    const c = await env.DB.prepare('SELECT id FROM categories WHERE id = ? AND household_id = ?').bind(cat, user.household_id).first();
    if (!c) return json({ error: 'not_found', message: 'Category not found' }, 404);
    catSql = '(t.category_id = ? OR c.parent_id = ?)'; catArgs = [cat, cat];
  }
  const { results } = await env.DB.prepare(
    `SELECT substr(t.eff_date, 1, 7) AS month, COALESCE(SUM(t.amount), 0) AS spending
       ${TX_FROM} WHERE ${TX_VISIBLE} AND t.eff_date >= ? AND t.eff_date <= ?
        AND t.is_transfer = 0 AND t.is_income = 0 AND ${catSql}
      GROUP BY month ORDER BY month`
  ).bind(...base, monthsBack(to, 12), to, ...catArgs).all();
  return json({ to, category: cat, months: results });
}
