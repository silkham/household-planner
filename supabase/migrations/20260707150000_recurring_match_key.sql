-- Emma integration, phase 1c: recurring-payment detection → one-tap link.
-- The detector scans the Emma feed for repeating monthly-ish payments and
-- offers to create a `recurring_flows` row (the thing that actually feeds the
-- cashflow engine). To avoid re-suggesting a payment the user has already
-- added, a created flow remembers which Emma merchant it came from.
--
-- Same mapping-driven pattern as accounts.emma_account / category_rules.match_key:
-- keyed on Emma's `Custom Name` (the cleaned merchant). Nullable — a manually
-- entered flow simply has no Emma link.

alter table house_project.recurring_flows
  add column if not exists emma_match_key text;

create index if not exists idx_hp_recflows_emmakey
  on house_project.recurring_flows(household_id, emma_match_key);
