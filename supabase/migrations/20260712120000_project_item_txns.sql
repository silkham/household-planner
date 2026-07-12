-- Link project line items to the actual Emma transactions that paid for them
-- (Session 14). A line item can have MANY linked transactions (e.g. a 25%
-- deposit now, the balance later). The item's actual_cost becomes the SUM of
-- its links, which rolls up to the project's actual_cost and — via the engine —
-- shrinks the remaining spend the forecast still chases (the money already left
-- the account, so it's already reflected in the Emma-anchored opening cash).
--
-- The amount is SNAPSHOTTED on the link row so it stays correct even after the
-- transaction ages out of Emma's ~12-month export window. The Emma feed itself
-- is never mutated.

create table if not exists house_project.project_item_txns (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id      uuid not null references house_project.project_items(id) on delete cascade,
  emma_txn_id  text,            -- Emma feed row ID (or a synthesized stable key)
  merchant     text,            -- snapshot label for display
  txn_date     text,            -- Emma date string, snapshot
  amount       numeric not null default 0,  -- absolute £ outflow, snapshot
  created_at   timestamptz not null default now()
);

-- a given transaction links to at most one line item (re-link = move via upsert)
create unique index if not exists idx_hp_pit_txn
  on house_project.project_item_txns(household_id, emma_txn_id);
create index if not exists idx_hp_pit_item
  on house_project.project_item_txns(item_id);

grant all on house_project.project_item_txns to authenticated;

alter table house_project.project_item_txns enable row level security;
drop policy if exists hp_rw on house_project.project_item_txns;
create policy hp_rw on house_project.project_item_txns
  using (household_id in (select house_project.my_household_ids()))
  with check (household_id in (select house_project.my_household_ids()));
