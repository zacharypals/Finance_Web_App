-- Finance Pal — initial schema
-- Conventions:
--   ids          TEXT (crypto.randomUUID)
--   timestamps   INTEGER, milliseconds since epoch (UTC)
--   dates        TEXT 'YYYY-MM-DD'
--   money        INTEGER cents. Plaid sign convention: positive = money out, negative = money in.

-- ── People ─────────────────────────────────────────────
CREATE TABLE households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  household_id  TEXT NOT NULL REFERENCES households(id),
  role          TEXT NOT NULL DEFAULT 'member',      -- owner | member
  created_at    INTEGER NOT NULL
);

-- App sessions (issued by the Worker after Google sign-in). Only the SHA-256 hash is stored.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ── Plaid connections & accounts ───────────────────────
CREATE TABLE plaid_items (
  id                  TEXT PRIMARY KEY,
  owner_user_id       TEXT NOT NULL REFERENCES users(id),
  plaid_item_id       TEXT NOT NULL UNIQUE,
  institution_id      TEXT,
  institution_name    TEXT,
  access_token_enc    TEXT NOT NULL,                 -- AES-GCM ciphertext, base64
  access_token_iv     TEXT NOT NULL,                 -- base64
  tx_cursor           TEXT,
  status              TEXT NOT NULL DEFAULT 'ok',    -- ok | login_required | error
  error_code          TEXT,
  consent_expires_at  INTEGER,
  last_synced_at      INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE TABLE accounts (
  id                    TEXT PRIMARY KEY,
  item_id               TEXT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  plaid_account_id      TEXT NOT NULL UNIQUE,
  owner_user_id         TEXT NOT NULL REFERENCES users(id),
  visibility            TEXT NOT NULL DEFAULT 'private',   -- private | household
  name                  TEXT,
  official_name         TEXT,
  display_name          TEXT,
  mask                  TEXT,
  type                  TEXT,                              -- depository | credit | investment | loan
  subtype               TEXT,
  include_in_net_worth  INTEGER NOT NULL DEFAULT 1,
  hidden                INTEGER NOT NULL DEFAULT 0,
  sort                  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_accounts_owner ON accounts(owner_user_id);

-- ── Snapshots ──────────────────────────────────────────
CREATE TABLE balance_snapshots (
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  current       INTEGER,
  available     INTEGER,
  credit_limit  INTEGER,
  currency      TEXT DEFAULT 'USD',
  PRIMARY KEY (account_id, date)
);

CREATE TABLE card_statements (
  account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  statement_date       TEXT NOT NULL,
  statement_balance    INTEGER,
  minimum_payment      INTEGER,
  due_date             TEXT,
  last_payment_amount  INTEGER,
  last_payment_date    TEXT,
  PRIMARY KEY (account_id, statement_date)
);

CREATE TABLE holdings_snapshots (
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  security_id  TEXT NOT NULL,
  ticker       TEXT,
  name         TEXT,
  type         TEXT,
  quantity     REAL,
  price        INTEGER,
  value        INTEGER,
  cost_basis   INTEGER,
  PRIMARY KEY (account_id, date, security_id)
);

-- ── Categories ─────────────────────────────────────────
CREATE TABLE categories (
  id              TEXT PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES households(id),
  name            TEXT NOT NULL,
  parent_id       TEXT REFERENCES categories(id),
  kind            TEXT NOT NULL DEFAULT 'expense',   -- expense | income | transfer
  color           TEXT,
  budget_monthly  INTEGER,
  archived        INTEGER NOT NULL DEFAULT 0,
  sort            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE category_rules (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id),
  priority      INTEGER NOT NULL DEFAULT 100,
  field         TEXT NOT NULL,      -- merchant | name | account | amount
  op            TEXT NOT NULL,      -- contains | equals | starts_with | between
  value         TEXT,
  account_id    TEXT REFERENCES accounts(id),
  amount_min    INTEGER,
  amount_max    INTEGER,
  category_id   TEXT REFERENCES categories(id),
  mark_transfer INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE plaid_category_map (
  household_id  TEXT NOT NULL REFERENCES households(id),
  pfc_detailed  TEXT NOT NULL,
  category_id   TEXT NOT NULL REFERENCES categories(id),
  PRIMARY KEY (household_id, pfc_detailed)
);

-- ── Buckets & paychecks ────────────────────────────────
CREATE TABLE buckets (
  id                 TEXT PRIMARY KEY,
  scope_type         TEXT NOT NULL,          -- user | household
  scope_id           TEXT NOT NULL,
  name               TEXT NOT NULL,
  parent_id          TEXT REFERENCES buckets(id),
  kind               TEXT NOT NULL,          -- bill | card | savings_goal | spending | passthrough
  backing            TEXT NOT NULL,          -- sofi_vault | account | none
  linked_account_id  TEXT REFERENCES accounts(id),
  target_amount      INTEGER,
  cadence            TEXT,                   -- monthly | weekly | yearly | none
  due_day            INTEGER,
  goal_amount        INTEGER,
  category_id        TEXT REFERENCES categories(id),
  archived           INTEGER NOT NULL DEFAULT 0,
  sort               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE paychecks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  pay_date        TEXT NOT NULL,
  expected_total  INTEGER,
  actual_total    INTEGER,
  status          TEXT NOT NULL DEFAULT 'projected',   -- projected | received
  UNIQUE (user_id, pay_date)
);

CREATE TABLE transactions (
  id                    TEXT PRIMARY KEY,
  plaid_transaction_id  TEXT NOT NULL UNIQUE,
  account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date                  TEXT NOT NULL,
  authorized_date       TEXT,
  amount                INTEGER NOT NULL,
  merchant_name         TEXT,
  name                  TEXT,
  pending               INTEGER NOT NULL DEFAULT 0,
  pfc_primary           TEXT,
  pfc_detailed          TEXT,
  pfc_confidence        TEXT,
  category_id           TEXT REFERENCES categories(id),
  category_source       TEXT NOT NULL DEFAULT 'none',   -- manual | rule | plaid | none
  is_transfer           INTEGER NOT NULL DEFAULT 0,
  transfer_pair_id      TEXT,
  is_income             INTEGER NOT NULL DEFAULT 0,
  paycheck_id           TEXT REFERENCES paychecks(id),
  notes                 TEXT,
  removed               INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_tx_account_date ON transactions(account_id, date);
CREATE INDEX idx_tx_date ON transactions(date);
CREATE INDEX idx_tx_category ON transactions(category_id);

CREATE TABLE bucket_entries (
  id              TEXT PRIMARY KEY,
  bucket_id       TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  type            TEXT NOT NULL,          -- allocation | payment | adjustment | interest
  status          TEXT NOT NULL DEFAULT 'planned',   -- planned | done
  paycheck_id     TEXT REFERENCES paychecks(id),
  transaction_id  TEXT REFERENCES transactions(id),
  note            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_bucket_entries_bucket ON bucket_entries(bucket_id, date);

CREATE TABLE paycheck_templates (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  cadence         TEXT NOT NULL DEFAULT 'weekly',
  anchor_date     TEXT NOT NULL,
  expected_total  INTEGER,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE template_allocations (
  template_id  TEXT NOT NULL REFERENCES paycheck_templates(id) ON DELETE CASCADE,
  bucket_id    TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  amount       INTEGER NOT NULL,
  PRIMARY KEY (template_id, bucket_id)
);

-- ── Ops ────────────────────────────────────────────────
CREATE TABLE sync_log (
  id           TEXT PRIMARY KEY,
  job          TEXT NOT NULL,
  item_id      TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT,
  detail       TEXT
);
