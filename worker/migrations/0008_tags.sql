-- v0.10.0: Tags. A transaction keeps ONE category and can have any number of tags
-- (Coffee, Restaurant, Fast Food, Date Night…). Reports break each category down by tag.
-- The starter tags and the one-time "Coffee category → Dining Out + Coffee tag" move are done
-- by the Worker (ensureTags in categorize.js) the first time it runs after this migration.

CREATE TABLE IF NOT EXISTS tags (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id),
  name          TEXT NOT NULL,
  color         TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(household_id, name COLLATE NOCASE);

-- source: manual (you added it) | rule | plaid | off (you removed an automatic tag — keeps it from coming back)
CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (transaction_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_txtags_tag ON transaction_tags(tag_id, transaction_id);

-- Plaid detailed code (or 'P:<primary>') → tag. A code can feed several tags.
CREATE TABLE IF NOT EXISTS plaid_tag_map (
  household_id  TEXT NOT NULL REFERENCES households(id),
  pfc_detailed  TEXT NOT NULL,
  tag_id        TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (household_id, pfc_detailed, tag_id)
);

-- A rule can now set a category, a tag, or both.
ALTER TABLE category_rules ADD COLUMN tag_id TEXT REFERENCES tags(id);

-- 1 once the starter tags exist and the Coffee move has run for this household.
ALTER TABLE households ADD COLUMN tags_seeded INTEGER NOT NULL DEFAULT 0;
