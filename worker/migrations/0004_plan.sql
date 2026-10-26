-- Phase 4: paycheck plan
ALTER TABLE buckets ADD COLUMN card_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;  -- credit card a 'card' bucket pays

-- One row per (payday, bucket) only when you override the weekly default or tick a move done.
CREATE TABLE plan_cells (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pay_date   TEXT NOT NULL,
  bucket_id  TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  amount     INTEGER,                 -- cents; NULL = use the bucket's weekly default
  done       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, pay_date, bucket_id)
);
