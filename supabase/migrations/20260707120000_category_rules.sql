-- Emma integration, phase 1b: the Spending tab's categorisation override layer.
-- Emma's own `Category` is the default for each transaction; a household can
-- override it by merchant. Rules are keyed on Emma's `Custom Name` (the cleaned
-- merchant, e.g. "Specsavers") — Counterparty carries varying refs, so it's a
-- poor key. One rule per (household, merchant) re-buckets every past & future
-- transaction from that merchant. The Emma feed itself is never mutated.

create table if not exists house_project.category_rules (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  match_key    text not null,   -- Emma "Custom Name" to match (exact)
  category     text not null,   -- category to assign instead of Emma's
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- one rule per merchant per household
create unique index if not exists idx_hp_catrules_key
  on house_project.category_rules(household_id, match_key);
create index if not exists idx_hp_catrules_household
  on house_project.category_rules(household_id);

-- grants + RLS (same pattern as every other planner table)
grant all on house_project.category_rules to authenticated;

alter table house_project.category_rules enable row level security;
drop policy if exists hp_rw on house_project.category_rules;
create policy hp_rw on house_project.category_rules
  using (household_id in (select house_project.my_household_ids()))
  with check (household_id in (select house_project.my_household_ids()));

-- updated_at trigger
drop trigger if exists trg_touch_category_rules on house_project.category_rules;
create trigger trg_touch_category_rules before update on house_project.category_rules
  for each row execute function house_project.touch_updated_at();
