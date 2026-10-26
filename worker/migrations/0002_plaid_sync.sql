-- Phase 1: Plaid sync bookkeeping
-- tx_cursor       = committed cursor (start point of the current pagination run)
-- tx_cursor_next  = in-progress cursor while has_more is true; NULL when caught up.
--                   On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION we clear it and restart from tx_cursor.
ALTER TABLE plaid_items ADD COLUMN tx_cursor_next TEXT;
ALTER TABLE plaid_items ADD COLUMN tx_status TEXT;            -- Plaid transactions_update_status, or 'unsupported'
ALTER TABLE plaid_items ADD COLUMN link_type TEXT NOT NULL DEFAULT 'bank';   -- bank | investment
ALTER TABLE plaid_items ADD COLUMN last_snapshot_date TEXT;   -- PT date of last balances/liabilities/holdings pull
