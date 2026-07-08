-- Transfer → Investment (Session 11). An investment/savings account with no Emma
-- transaction feed of its own can still be kept current: link it to a non-counting
-- "Transfer - X" category, and emma.js sums transfers in that category (outflows
-- from a current account) into this account's balance, on top of its manual anchor.
-- Reuses category_rules + the managed-category "counts as spend" flag — no new
-- merchant→account table. Nullable; null = purely manual (unchanged behaviour).
alter table house_project.accounts
  add column if not exists contrib_category text;
