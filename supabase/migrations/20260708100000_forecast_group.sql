-- Current-month reconciliation (phase 2): forecast grouping.
-- Categories gain an optional forecast_group so the Forecast tab's "This month"
-- panel can roll actual Emma spend up into a handful of lines (e.g. Housing =
-- Mortgage + Council Tax + Utilities) and compare each to expected. null = the
-- category is its own line. "General Expenses" is the reserved discretionary
-- group that carries an editable monthly budget (stored in settings.forecast_budgets).

alter table house_project.categories
  add column if not exists forecast_group text;

-- Per-group monthly budgets, keyed by group name: {"General Expenses": 2500}.
-- Only budget groups (currently General Expenses) use this; bill groups take
-- their expected value from the linked recurring flows instead.
alter table house_project.settings
  add column if not exists forecast_budgets jsonb not null default '{}'::jsonb;
