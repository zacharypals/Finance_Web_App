-- "Effective date": the day the card was run (Plaid authorized_date), else the day it posted.
-- Used for the Transactions list, Reports and spending totals. Posted `date` is still used for
-- statements, transfer matching, paycheck detection and vault-move matching.
ALTER TABLE transactions ADD COLUMN eff_date TEXT GENERATED ALWAYS AS (COALESCE(authorized_date, date)) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_tx_eff_date ON transactions(eff_date);
CREATE INDEX IF NOT EXISTS idx_tx_cat_eff ON transactions(category_id, eff_date);
