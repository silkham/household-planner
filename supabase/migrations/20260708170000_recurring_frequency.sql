-- Recurring-flow frequencies (Session 11). Until now every recurring_flow was
-- implicitly monthly. Add a cadence so a flow can be weekly / monthly / yearly
-- with an interval (every N periods). The engine spreads the per-occurrence
-- `amount` into calendar months accordingly:
--   monthly  → lands every interval_n months from start_month
--   yearly   → lands on start_month's month-of-year, every interval_n years
--   weekly   → accrues amount × (52/12) / interval_n each active month
-- Backward-compatible: existing rows default to monthly / 1 = today's behaviour.
alter table house_project.recurring_flows
  add column if not exists frequency  text not null default 'monthly',
  add column if not exists interval_n  int  not null default 1;
