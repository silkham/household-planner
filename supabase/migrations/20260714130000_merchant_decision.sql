-- Keep / Review / Kill decision moves from CATEGORY level to MERCHANT level.
-- category_rules is already the per-merchant record (keyed on match_key), so the
-- decision lives here now. Values: 'keep' | 'review' | 'kill' | null (undecided).
-- The old categories.decision + recurring_flows.decision columns are left in
-- place but UNUSED (non-destructive, like the retired priority columns).
alter table house_project.category_rules
  add column if not exists decision text;
