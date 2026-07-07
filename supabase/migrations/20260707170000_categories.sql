-- Emma integration, phase 1d: managed categories.
-- Spending/recurring previously hardcoded {Excluded, Transfers} as the only
-- non-counting categories. This table makes "counts as spend" a per-category
-- property the household controls, and gives the categorise dropdown a canonical
-- list. Emma's own categories still flow through the feed; this table layers
-- flags + custom buckets on top (a category counts unless a row says otherwise).

create table if not exists house_project.categories (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  name            text not null,
  counts_as_spend boolean not null default true,   -- false = excluded from spend totals
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- one row per category name per household (case-insensitive)
create unique index if not exists idx_hp_categories_name
  on house_project.categories(household_id, lower(name));
create index if not exists idx_hp_categories_household
  on house_project.categories(household_id);

grant all on house_project.categories to authenticated;

alter table house_project.categories enable row level security;
drop policy if exists hp_rw on house_project.categories;
create policy hp_rw on house_project.categories
  using (household_id in (select house_project.my_household_ids()))
  with check (household_id in (select house_project.my_household_ids()));

drop trigger if exists trg_touch_categories on house_project.categories;
create trigger trg_touch_categories before update on house_project.categories
  for each row execute function house_project.touch_updated_at();
