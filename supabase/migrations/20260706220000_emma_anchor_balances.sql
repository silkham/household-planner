-- Emma integration, phase 1a: hybrid anchor balances.
-- Emma's Google-Sheet export is a *transaction feed with no current balances*
-- (live-synced accounts only carry ~12 months of history, no opening figure).
-- So a current balance is derived as: anchor_balance (a real balance the user
-- entered on anchor_date) + SUM(Emma transactions dated after anchor_date).
-- The engine + Finances UI keep reading `accounts.balance`; the Emma sync just
-- recomputes it from the anchor. No real balances live in this repo — they are
-- written only to the live DB (public repo).

alter table house_project.accounts
  add column if not exists anchor_balance numeric,       -- true balance at anchor_date
  add column if not exists anchor_date    date,           -- when the anchor was set
  add column if not exists emma_account   text;           -- matching sheet `Account` name (null = manual only)

-- Emma sheet config (sheet id + which tab holds the transactions). The service
-- account key stays server-side in the emma-sheet Edge Function secret; only the
-- non-secret sheet id/tab live here.
alter table house_project.settings
  add column if not exists emma_sheet_id text,
  add column if not exists emma_tab      text default 'Mclean Household';
