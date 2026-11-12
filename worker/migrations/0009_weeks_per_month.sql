-- v0.13.0: the Expenses "weeks per month" divider becomes a setting (it was a fixed ÷ 4).
-- Per paycheck = CEILING(monthly ÷ weeks_per_month, $1). Default 4.25 (52 ÷ 12 = 4.33 would be
-- exact; a lower number leaves a cushion). Existing households start at 4.25; set it back to 4 in
-- Expenses to get the old behaviour. Additive only — old code ignores the column.
ALTER TABLE households ADD COLUMN weeks_per_month REAL NOT NULL DEFAULT 4.25;
