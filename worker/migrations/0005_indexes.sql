-- Performance: keep D1 row reads low (free tier = 5M rows read/day).
CREATE INDEX IF NOT EXISTS idx_tx_source ON transactions(category_source);
CREATE INDEX IF NOT EXISTS idx_tx_amount_date ON transactions(amount, date);
CREATE INDEX IF NOT EXISTS idx_tx_cat_date ON transactions(category_id, date);
DROP INDEX IF EXISTS idx_tx_category;
