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
//
// Tags (v0.10.0) ride along in the same batch. They are additive — a transaction can have many —
// and come from your rules (any rule with a tag) and Plaid's code (plaid_tag_map). Tags you add by
// hand are 'manual'; tags you remove become 'off' so automatic tagging never puts them back.

const SEED = [
  ['Home', 'expense', ['Mortgage', 'HOA', 'Utilities', 'Home & Repairs']],
  ['Food', 'expense', ['Groceries', 'Dining Out']],
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
  FOOD_AND_DRINK_GROCERIES: 'Groceries', GENERAL_MERCHANDISE_CONVENIENCE_STORES: 'Dining Out',
  TRANSPORTATION_GAS: 'Gas', TRANSPORTATION_PARKING: 'Parking & Rideshare',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'Parking & Rideshare', TRANSPORTATION_PUBLIC_TRANSIT: 'Parking & Rideshare',
  TRANSPORTATION_TOLLS: 'Parking & Rideshare',
  RENT_AND_UTILITIES_RENT: 'Mortgage', RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'Phone & Internet',
  RENT_AND_UTILITIES_TELEPHONE: 'Phone & Internet',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'Clothes', GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'Gifts',
  GENERAL_SERVICES_INSURANCE: 'Insurance', GENERAL_SERVICES_AUTOMOTIVE: 'Car',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Gifts', PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Health & Fitness',
};

// Starter tags and the Plaid codes that feed them. Editable in Settings → Tags.
const TAG_SEED = ['Coffee', 'Restaurant', 'Fast Food', 'Convenience Store', 'Date Night'];
const PLAID_TAG_DEFAULTS = {
  FOOD_AND_DRINK_COFFEE: 'Coffee',
  FOOD_AND_DRINK_RESTAURANT: 'Restaurant',
  FOOD_AND_DRINK_FAST_FOOD: 'Fast Food',
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: 'Convenience Store',
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

// One-time per household (v0.10.0): starter tags, their Plaid codes, and the move from the old
// Coffee category to Dining Out + a Coffee tag (transactions, rules, Plaid map, buckets, expenses),
// convenience stores → Dining Out, then tags applied to all history. Claims the household first
// so two requests can't both run it.
export async function ensureTags(env, householdId) {
  const hh = await env.DB.prepare('SELECT tags_seeded FROM households WHERE id = ?').bind(householdId).first();
  if (!hh || hh.tags_seeded) return false;
  const claim = await env.DB.prepare('UPDATE households SET tags_seeded = 1 WHERE id = ? AND tags_seeded = 0').bind(householdId).run();
  if (!claim.meta || !claim.meta.changes) return false;
  try {
    const now = Date.now();
    const stmts = TAG_SEED.map((name, i) => env.DB.prepare(
      'INSERT OR IGNORE INTO tags (id, household_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), householdId, name, i, now));
    for (const [code, name] of Object.entries(PLAID_TAG_DEFAULTS)) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO plaid_tag_map (household_id, pfc_detailed, tag_id)
         SELECT ?, ?, id FROM tags WHERE household_id = ? AND name = ?`
      ).bind(householdId, code, householdId, name));
    }
    const cat = (name) => env.DB.prepare(
      'SELECT id FROM categories WHERE household_id = ? AND name = ? AND parent_id IS NOT NULL ORDER BY archived, sort LIMIT 1'
    ).bind(householdId, name).first();
    const dining = await cat('Dining Out');
    const coffee = await cat('Coffee');
    const coffeeTag = `(SELECT id FROM tags WHERE household_id = ? AND name = 'Coffee')`;
    if (dining && coffee) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id, source)
           SELECT t.id, ${coffeeTag}, CASE t.category_source WHEN 'manual' THEN 'manual' WHEN 'rule' THEN 'rule' ELSE 'plaid' END
             FROM transactions t WHERE t.category_id = ?`
        ).bind(householdId, coffee.id),
        env.DB.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').bind(dining.id, coffee.id),
        env.DB.prepare(`UPDATE category_rules SET category_id = ?, tag_id = ${coffeeTag} WHERE household_id = ? AND category_id = ?`)
          .bind(dining.id, householdId, householdId, coffee.id),
        env.DB.prepare('UPDATE plaid_category_map SET category_id = ? WHERE household_id = ? AND category_id = ?').bind(dining.id, householdId, coffee.id),
        env.DB.prepare('UPDATE buckets SET category_id = ? WHERE category_id = ?').bind(dining.id, coffee.id),
        env.DB.prepare('UPDATE expenses SET category_id = ? WHERE category_id = ?').bind(dining.id, coffee.id),
        env.DB.prepare('UPDATE categories SET archived = 1 WHERE id = ?').bind(coffee.id),
      );
    }
    if (dining) {
      // Convenience stores count as Dining Out (Plaid-guessed ones only; rules and your picks stay).
      stmts.push(
        env.DB.prepare(`INSERT OR IGNORE INTO plaid_category_map (household_id, pfc_detailed, category_id) VALUES (?, 'GENERAL_MERCHANDISE_CONVENIENCE_STORES', ?)`)
          .bind(householdId, dining.id),
        env.DB.prepare(
          `UPDATE transactions SET category_id = ? WHERE category_source = 'plaid' AND pfc_detailed = 'GENERAL_MERCHANDISE_CONVENIENCE_STORES'
              AND account_id IN (${HH_ACCOUNTS})`
        ).bind(dining.id, householdId),
      );
    }
    await env.DB.batch(stmts);
    const rules = (await env.DB.prepare('SELECT * FROM category_rules WHERE household_id = ? AND enabled = 1 AND tag_id IS NOT NULL')
      .bind(householdId).all()).results;
    await env.DB.batch(tagStatements(env, householdId, rules, {}));
  } catch (e) {
    await env.DB.prepare('UPDATE households SET tags_seeded = 0 WHERE id = ?').bind(householdId).run();
    throw e;
  }
  return true;
}

// Statements that add automatic tags (never touching 'manual' or 'off' rows).
//   sinceDays — only transactions posted in the last N days (routine syncs); omit for all history
//   tagId     — only this tag
//   reset     — first drop automatic tags in scope, so changed mappings/rules take effect
export function tagStatements(env, householdId, rules, { sinceDays = null, tagId = null, reset = false } = {}) {
  const stmts = [];
  const win = sinceDays ? ` AND date >= date('now', '-${Number(sinceDays)} days')` : '';
  if (reset) {
    stmts.push(env.DB.prepare(
      `DELETE FROM transaction_tags WHERE source IN ('plaid', 'rule')${tagId ? ' AND tag_id = ?' : ''}
          AND transaction_id IN (SELECT id FROM transactions WHERE account_id IN (${HH_ACCOUNTS}))`
    ).bind(...(tagId ? [tagId] : []), householdId));
  }
  stmts.push(env.DB.prepare(
    `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id, source)
     SELECT t.id, m.tag_id, 'plaid' FROM transactions t
       JOIN plaid_tag_map m ON m.household_id = ? AND (m.pfc_detailed = t.pfc_detailed OR m.pfc_detailed = 'P:' || t.pfc_primary)
      WHERE t.account_id IN (${HH_ACCOUNTS}) AND t.removed = 0${win.replace('date', 't.date')}${tagId ? ' AND m.tag_id = ?' : ''}`
  ).bind(householdId, householdId, ...(tagId ? [tagId] : [])));
  for (const r of rules) {
    if (!r.tag_id || (tagId && r.tag_id !== tagId)) continue;
    const w = ruleWhere(r);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id, source)
       SELECT id, ?, 'rule' FROM transactions
        WHERE account_id IN (${HH_ACCOUNTS}) AND removed = 0${win} AND ${w.sql}`
    ).bind(r.tag_id, householdId, ...w.params));
  }
  return stmts;
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
  await ensureTags(env, householdId);
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
  // 1b. Moves to/from SoFi vaults ("To Mortgage Vault") are your own money changing places → Transfers.
  //     Runs before Plaid's guess and also corrects earlier Plaid guesses; never touches manual choices.
  if (transfersId) {
    stmts.push(env.DB.prepare(
      `UPDATE transactions SET category_id = ?, category_source = 'auto', is_transfer = 1, is_income = 0
        WHERE category_source IN ('none', 'plaid') AND ${scope} AND removed = 0
          AND date >= date('now', ?)
          AND (LOWER(COALESCE(name, '')) LIKE '%vault%' OR LOWER(COALESCE(merchant_name, '')) LIKE '%vault%')
          AND COALESCE((SELECT kind FROM categories c WHERE c.id = transactions.category_id), '') != 'transfer'`
    ).bind(transfersId, householdId, reset ? '-100 years' : `-${windowDays} days`));
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
  // 4. Tags: all history on a reset (automatic tags rebuilt), else just the routine window.
  stmts.push(...tagStatements(env, householdId, rules, reset ? { reset: true } : { sinceDays: windowDays }));
  await env.DB.batch(stmts);
}

// Apply ONE rule to all history (overrides plaid/auto/other-rule choices, never manual).
export async function applyRuleToHistory(env, householdId, rule) {
  if (rule.tag_id) await env.DB.batch(tagStatements(env, householdId, [rule], {}));
  if (!rule.category_id) return;
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
