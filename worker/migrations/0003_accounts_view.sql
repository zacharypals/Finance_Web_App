-- Phase 2: account presentation settings + manual (backfilled) balances
ALTER TABLE accounts ADD COLUMN account_group TEXT;                        -- cash | vault | credit | investment | loan | other (NULL = derive from type)
ALTER TABLE accounts ADD COLUMN track_levels INTEGER NOT NULL DEFAULT 0;   -- 1 = show in Monthly Levels
ALTER TABLE balance_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'plaid';   -- plaid | manual
