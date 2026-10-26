-- Expenses: recurring costs, what each needs per paycheck, and which bucket (or split pool) pays it.
CREATE TABLE expense_pools (
  id          TEXT PRIMARY KEY,
  scope_type  TEXT NOT NULL,            -- user | household
  scope_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- e.g. "Credit cards" pool: Chase 60%, Wells 40%
CREATE TABLE pool_shares (
  pool_id    TEXT NOT NULL REFERENCES expense_pools(id) ON DELETE CASCADE,
  bucket_id  TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  pct        REAL NOT NULL,
  PRIMARY KEY (pool_id, bucket_id)
);

CREATE TABLE expenses (
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  group_name      TEXT NOT NULL DEFAULT 'Other',
  monthly_amount  INTEGER NOT NULL DEFAULT 0,   -- cents
  bucket_id       TEXT REFERENCES buckets(id) ON DELETE SET NULL,
  pool_id         TEXT REFERENCES expense_pools(id) ON DELETE SET NULL,
  category_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,  -- for comparing with actual spending later
  notes           TEXT,
  sort            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_expenses_scope ON expenses(scope_type, scope_id);
