// Phase 3: categories, Plaid→category mapping, rules, and the categorizer.
//
// Categorization runs entirely in SQL (one db.batch), so it costs almost no Worker CPU
// even over years of history. Order of precedence for each transaction:
//   1. manual      — you picked it; never overwritten
//   2. rule        — your "always categorize X as Y" rules, lowest priority number wins
//   3. plaid       — Plaid's category mapped to yours (detailed code first, then primary)
//   4. auto        — matching in/out pair between two of your accounts → Transfers
//   5. none        — Uncategorized
// is_transfer / is_income always follow the chosen category's kind.

const SEED = [
  ['Home', 'expense', ['Mortgage', 'HOA', 'Utilities', 'Home & Repairs']],
  ['Food', 'expense', ['Groceries', 'Dining Out', 'Coffee']],
  ['Getting around', 'expense', ['Gas', 'Car', 'Parking & Rideshare']],
  ['Fun', 'expense', ['Comedy', 'Entertainment', 'Travel']],
  ['Personal', 'expense', ['Clothes', 'Health & Fitness', 'Personal Care', 'Gifts']],
  ['Bills', 'expense', ['Subscriptions', 'Phone & Internet', 'InCharge', 'Insurance']],
  ['Other', 'expense', ['Shopping', 'Fees']],
  ['Income', 'income', ['Paycheck', 'Interest & Dividends', 'Other Income']],
  ['Not spending', 'transfer', ['Transfers', 'Card Payments', 'Investments']],
];

// Plaid personal_finance_category → our category name. 'P:' keys are primary-level fallbacks.
const PLAID_DEFAULTS = {
  'P:INCOME': 'Other Income', 'P:TRANSFER_IN': 'Transfers', 'P:TRANSFER_OUT': 'Transfers',
  'P:LOAN_PAYMENTS': 'Transfers', 'P:BANK_FEES': 'Fees', 'P:ENTERTAINMENT': 'Entertainment',
  'P:FOOD_AND_DRINK': 'Dining Out', 'P:GENERAL_MERCHANDISE': 'Shopping', 'P:HOME_IMPROVEMENT': 'Home & Repairs',
  'P:MEDICAL': 'Health & Fitness', 'P:PERSONAL_CARE': 'Personal Care', 'P:GENERAL_SERVICES': 'Shopping',
  'P:GOVERNMENT_AND_NON_PROFIT': 'Fees', 'P:TRANSPORTATION': 'Car', 'P:TRAVEL': 'Travel',
  'P:RENT_AND_UTILITIES': 'Utilities',
  INCOME_WAGES: 'Paycheck', INCOME_DIVIDENDS: 'Interest & Dividends', INCOME_INTEREST_EARNED: 'Interest & Dividends',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'Investments', TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'Investments',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Card Payments', LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Mortgage',
  LOAN_PAYMENTS_CAR_PAYMENT: 'Car',
  FOOD_AND_DRINK_GROCERIES: 'Groceries', FOOD_AND_DRINK_COFFEE: 'Coffee',
  TRANSPORTATION_GAS: 'Gas', TRANSPORTATION_PARKING: 'Parking & Rideshare',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'Parking & Rideshare', TRANSPORTATION_PUBLIC_TRANSIT: 'Parking & Rideshare',
  TRANSPORTATION_TOLLS: 'Parking & Rideshare',
  RENT_AND_UTILITIES_RENT: 'Mortgage', RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'Phone & Internet',
  RENT_AND_UTILITIES_TELEPHONE: 'Phone & Internet',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'Clothes', GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'Gifts',
  GENERAL_SERVICES_INSURANCE: 'Insurance', GENERAL_SERVICES_AUTOMOTIVE: 'Car',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Gifts', PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Health & Fitness',
};

// All transactions on accounts belonging to anyone in the household.
export const HH_ACCOUNTS = `SELECT a.id FROM accounts a JOIN users ow ON ow.id = a.owner_user_id WHERE ow.household_id = ?`;

export async function ensureCategories(env, householdId) {
  const has = await env.DB.prepare('SELECT 1 FROM categories WHERE household_id = ? LIMIT 1').bind(householdId).first();
  if (has) return false;
  const stmts = [];
  const idByName = {};
  let sort = 0;
  for (const [parent, kind, children] of SEED) {
    const pid = crypto.randomUUID();
    stmts.push(env.DB.prepare('INSERT INTO categories (id, household_id, name, parent_id, kind, sort) VALUES (?, ?, ?, NULL, ?, ?)')
      .bind(pid, householdId, parent, kind, sort++));
    for (const c of children) {
      const id = crypto.randomUUID();
      idByName[c] = id;
      stmts.push(env.DB.prepare('INSERT INTO categories (id, household_id, name, parent_id, kind, sort) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, householdId, c, pid, kind, sort++));
    }
  }
  for (const [code, name] of Object.entries(PLAID_DEFAULTS)) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO plaid_category_map (household_id, pfc_detailed, category_id) VALUES (?, ?, ?)')
      .bind(householdId, code, idByName[name]));
  }
  await env.DB.batch(stmts);
  return true;
}

// SQL condition + params for one rule against table alias-less `transactions`.
function likeEscape(s) { return String(s).replace(/[\\%_]/g, (m) => '\\' + m); }
export function ruleWhere(rule) {
  const parts = [];
  const params = [];
  const text = `COALESCE(merchant_name, '') || ' ' || COALESCE(name, '')`;
  if (rule.value) {
    const v = likeEscape(rule.value);
    if (rule.op === 'equals') {
      parts.push(`(LOWER(COALESCE(merchant_name, '')) = LOWER(?) OR LOWER(COALESCE(name, '')) = LOWER(?))`);
      params.push(rule.value, rule.value);
    } else if (rule.op === 'starts_with') {
      parts.push(`(COALESCE(merchant_name, '') LIKE ? ESCAPE '\\' OR COALESCE(name, '') LIKE ? ESCAPE '\\')`);
      params.push(v + '%', v + '%');
    } else {
      parts.push(`(${text} LIKE ? ESCAPE '\\')`);
      params.push('%' + v + '%');
    }
  }
  if (rule.account_id) { parts.push('account_id = ?'); params.push(rule.account_id); }
  if (rule.amount_min !== null && rule.amount_min !== undefined) { parts.push('amount >= ?'); params.push(rule.amount_min); }
  if (rule.amount_max !== null && rule.amount_max !== undefined) { parts.push('amount <= ?'); params.push(rule.amount_max); }
  return { sql: parts.length ? parts.join(' AND ') : '0', params };
}

// Flags follow the category's kind. Computed inline in every UPDATE that sets a category,
// so there is no separate full-table pass on normal runs.
const kindIs = (kind, idExpr) => `COALESCE((SELECT kind = '${kind}' FROM categories WHERE id = ${idExpr}), 0)`;
const mapKindIs = (kind, codeExpr) =>
  `COALESCE((SELECT c.kind = '${kind}' FROM plaid_category_map m JOIN categories c ON c.id = m.category_id
             WHERE m.household_id = ? AND m.pfc_detailed = ${codeExpr}), 0)`;

function flagStatements(env, householdId) {
  const kindOf = `(SELECT kind FROM categories c WHERE c.id = transactions.category_id)`;
  const isT = `CASE WHEN ${kindOf} = 'transfer' THEN 1 ELSE 0 END`;
  const isI = `CASE WHEN ${kindOf} = 'income' THEN 1 ELSE 0 END`;
  return [env.DB.prepare(
    `UPDATE transactions SET is_transfer = ${isT}, is_income = ${isI}
      WHERE account_id IN (${HH_ACCOUNTS}) AND (is_transfer != ${isT} OR is_income != ${isI})`
  ).bind(householdId)];
}

// Categorize transactions still at 'none' (cheap: uses the category_source index).
//   windowDays — how far back to look for transfer pairs (10 on routine syncs, 120 on first run / reset)
//   reset      — clear everything except manual choices first ("Re-apply to all history")
export async function categorize(env, householdId, { reset = false, windowDays = 10 } = {}) {
  await ensureCategories(env, householdId);
  const rules = (await env.DB.prepare(
    'SELECT * FROM category_rules WHERE household_id = ? AND enabled = 1 ORDER BY priority, created_at'
  ).bind(householdId).all()).results;
  const transfersId = (await env.DB.prepare(
    "SELECT id FROM categories WHERE household_id = ? AND name = 'Transfers' AND kind = 'transfer' AND archived = 0 LIMIT 1"
  ).bind(householdId).first() || {}).id;
  if (reset) windowDays = 120;

  const scope = `account_id IN (${HH_ACCOUNTS})`;
  const stmts = [];
  if (reset) {
    stmts.push(env.DB.prepare(
      `UPDATE transactions SET category_id = NULL, category_source = 'none', transfer_pair_id = NULL, is_transfer = 0, is_income = 0
        WHERE ${scope} AND category_source IN ('rule', 'plaid', 'auto')`
    ).bind(householdId));
  }
  // 1. Rules (first matching rule wins because later statements only touch 'none').
  for (const r of rules) {
    if (!r.category_id) continue;
    const w = ruleWhere(r);
    stmts.push(env.DB.prepare(
      `UPDATE transactions SET category_id = ?, category_source = 'rule',
              is_transfer = ${kindIs('transfer', '?')}, is_income = ${kindIs('income', '?')}
        WHERE category_source = 'none' AND ${scope} AND removed = 0 AND ${w.sql}`
    ).bind(r.category_id, r.category_id, r.category_id, householdId, ...w.params));
  }
  // 2. Plaid detailed, then primary.
  for (const code of ['transactions.pfc_detailed', `'P:' || transactions.pfc_primary`]) {
    stmts.push(env.DB.prepare(
      `UPDATE transactions SET category_source = 'plaid',
              category_id = (SELECT m.category_id FROM plaid_category_map m WHERE m.household_id = ? AND m.pfc_detailed = ${code}),
              is_transfer = ${mapKindIs('transfer', code)}, is_income = ${mapKindIs('income', code)}
        WHERE category_source = 'none' AND ${scope}
          AND ${code.replace(/transactions\./g, '')} IN (SELECT pfc_detailed FROM plaid_category_map WHERE household_id = ?)`
    ).bind(householdId, householdId, householdId, householdId, householdId));
  }
  // 3. Pairs: same amount out of one of your accounts and into another within 3 days → Transfers.
  //    The ±3-day date range on t2 keeps this an index lookup per row, not a scan of all history.
  if (transfersId) {
    stmts.push(env.DB.prepare(
      `UPDATE transactions SET category_id = ?, category_source = 'auto', is_transfer = 1, is_income = 0
        WHERE id IN (
          SELECT t1.id FROM transactions t1
            JOIN transactions t2 ON t2.date BETWEEN date(t1.date, '-3 days') AND date(t1.date, '+3 days')
             AND t2.amount = -t1.amount AND t2.account_id != t1.account_id
           WHERE t1.date >= date('now', ?)
             AND t1.account_id IN (${HH_ACCOUNTS}) AND t2.account_id IN (${HH_ACCOUNTS})
             AND t1.amount != 0 AND t1.removed = 0 AND t2.removed = 0 AND t1.pending = 0 AND t2.pending = 0
             AND t1.category_source IN ('none', 'plaid')
             AND COALESCE((SELECT kind FROM categories c WHERE c.id = t1.category_id), '') NOT IN ('transfer', 'income')
             AND COALESCE((SELECT kind FROM categories c WHERE c.id = t2.category_id), '') != 'income')`
    ).bind(transfersId, `-${windowDays} days`, householdId, householdId));
  }
  if (reset) stmts.push(...flagStatements(env, householdId));
  await env.DB.batch(stmts);
}

// Apply ONE rule to all history (overrides plaid/auto/other-rule choices, never manual).
export async function applyRuleToHistory(env, householdId, rule) {
  const w = ruleWhere(rule);
  await env.DB.prepare(
    `UPDATE transactions SET category_id = ?, category_source = 'rule',
            is_transfer = ${kindIs('transfer', '?')}, is_income = ${kindIs('income', '?')}
      WHERE account_id IN (${HH_ACCOUNTS}) AND category_source != 'manual' AND removed = 0 AND ${w.sql}`
  ).bind(rule.category_id, rule.category_id, rule.category_id, householdId, ...w.params).run();
}

export async function refreshFlags(env, householdId) {
  await env.DB.batch(flagStatements(env, householdId));
}
