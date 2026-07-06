-- HouseholdOS — Project & Financial Planner
-- Initial schema. Lives in a dedicated `house_project` schema inside the shared
-- `household` Supabase DB so it stays isolated from the meal/workout apps in `public`.
-- RLS is gated on public.household_memberships, so the planner shares through the
-- same household row as the other apps (no separate invite flow needed).

create schema if not exists house_project;

-- ---------------------------------------------------------------------------
-- Helper: household ids the current auth user belongs to.
-- SECURITY DEFINER so policies don't depend on RLS/grants of household_memberships.
-- ---------------------------------------------------------------------------
create or replace function house_project.my_household_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select household_id
  from public.household_memberships
  where user_id = auth.uid()
$$;

revoke all on function house_project.my_household_ids() from public;
grant execute on function house_project.my_household_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- projects -------------------------------------------------------------------
create table if not exists house_project.projects (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households(id) on delete cascade,
  name               text not null,
  category           text,        -- Structural / Cosmetic / Repair / Garden / Energy / Furniture
  status             text not null default 'Idea',   -- Idea / Planned / Quoted / In Progress / On Hold / Done
  impact             int  default 3 check (impact between 1 and 5),
  urgency            int  default 3 check (urgency between 1 and 5),
  effort             int  default 3 check (effort between 1 and 5),
  priority_score     int  default 0,     -- 0-100, recomputed client-side from weights
  estimated_cost     numeric default 0,  -- derived = SUM(items.estimated_cost) when items exist
  actual_cost        numeric default 0,  -- derived = SUM(items.actual_cost) when items exist
  budget_status      text not null default 'estimate', -- estimate / budgeted / tracking / closed
  target_start_month text,        -- 'YYYY-MM'
  duration_months    int  not null default 1 check (duration_months >= 1),
  cost_spread        jsonb,       -- optional { 'YYYY-MM': amount } override
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- project_items --------------------------------------------------------------
create table if not exists house_project.project_items (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households(id) on delete cascade,
  project_id     uuid not null references house_project.projects(id) on delete cascade,
  name           text not null,
  estimated_cost numeric default 0,
  actual_cost    numeric,          -- null = not yet spent
  status         text not null default 'todo',  -- todo / quoted / done
  sort_order     int  not null default 0,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- recurring_flows ------------------------------------------------------------
create table if not exists house_project.recurring_flows (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references public.households(id) on delete cascade,
  name              text not null,
  kind              text not null check (kind in ('income','expense')),
  amount            numeric not null default 0,   -- monthly £, positive; sign inferred from kind
  start_month       text,        -- 'YYYY-MM'
  end_month         text,        -- 'YYYY-MM' nullable = indefinite
  category          text,        -- Salary / Housing / Childcare / Vehicle / Utilities / Groceries / Loan / Other
  annual_uplift_pct numeric,     -- e.g. 0.03; null = flat
  uplift_month      int  default 4 check (uplift_month between 1 and 12),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- salary_changes -------------------------------------------------------------
create table if not exists house_project.salary_changes (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  flow_id         uuid not null references house_project.recurring_flows(id) on delete cascade,
  effective_month text not null,  -- 'YYYY-MM'
  new_amount      numeric not null,
  confidence      text not null default 'likely' check (confidence in ('confirmed','likely','speculative')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- life_events ----------------------------------------------------------------
create table if not exists house_project.life_events (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  name            text not null,
  event_type      text not null default 'expense_change'
                    check (event_type in ('income_change','expense_change','lump_sum','decision_point')),
  effective_month text,           -- 'YYYY-MM'
  duration_months int,            -- null = permanent from that month
  monthly_impact  numeric default 0,  -- £ change vs baseline (negative = worse)
  linked_flow_id  uuid references house_project.recurring_flows(id) on delete set null,
  notes           text,
  resolved        boolean not null default false,  -- for decision_point
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- accounts -------------------------------------------------------------------
create table if not exists house_project.accounts (
  id                     uuid primary key default gen_random_uuid(),
  household_id           uuid not null references public.households(id) on delete cascade,
  name                   text not null,
  kind                   text not null default 'current'
                           check (kind in ('current','savings','emergency','investment','other')),
  balance                numeric not null default 0,
  available_for_projects boolean not null default true,
  notes                  text,
  balance_updated_at     timestamptz default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- bonuses --------------------------------------------------------------------
create table if not exists house_project.bonuses (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  name            text not null,
  expected_month  text,           -- 'YYYY-MM'
  gross_amount    numeric default 0,
  net_amount      numeric default 0,  -- feeds the cashflow
  confidence      text not null default 'likely' check (confidence in ('confirmed','likely','speculative')),
  recurs_annually boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- financing_options ----------------------------------------------------------
create table if not exists house_project.financing_options (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references public.households(id) on delete cascade,
  name              text not null,
  principal         numeric default 0,
  apr               numeric default 0,   -- annual rate, e.g. 0.065
  term_months       int default 12,
  start_month       text,                -- 'YYYY-MM' drawdown
  linked_project_id uuid references house_project.projects(id) on delete set null,
  status            text not null default 'considering'
                      check (status in ('considering','active','declined','repaid')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- settings (singleton per household) ----------------------------------------
create table if not exists house_project.settings (
  household_id        uuid primary key references public.households(id) on delete cascade,
  cash_buffer         numeric not null default 5000,
  priority_weights    jsonb not null default '{"impact":0.35,"urgency":0.30,"effort":0.15,"cost":0.20}'::jsonb,
  horizon_months      int not null default 24,
  forecast_confidence text not null default 'realistic'
                        check (forecast_confidence in ('conservative','realistic','optimistic')),
  t212_enabled        boolean not null default false,
  emma_sheet_url      text,
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (household_id lookups + FK joins)
-- ---------------------------------------------------------------------------
create index if not exists idx_hp_projects_household     on house_project.projects(household_id);
create index if not exists idx_hp_items_household         on house_project.project_items(household_id);
create index if not exists idx_hp_items_project           on house_project.project_items(project_id);
create index if not exists idx_hp_flows_household         on house_project.recurring_flows(household_id);
create index if not exists idx_hp_salchg_household        on house_project.salary_changes(household_id);
create index if not exists idx_hp_salchg_flow            on house_project.salary_changes(flow_id);
create index if not exists idx_hp_life_household          on house_project.life_events(household_id);
create index if not exists idx_hp_accounts_household      on house_project.accounts(household_id);
create index if not exists idx_hp_bonuses_household       on house_project.bonuses(household_id);
create index if not exists idx_hp_financing_household     on house_project.financing_options(household_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function house_project.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'projects','project_items','recurring_flows','salary_changes',
    'life_events','accounts','bonuses','financing_options','settings'
  ] loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on house_project.%1$s;
       create trigger trg_touch_%1$s before update on house_project.%1$s
       for each row execute function house_project.touch_updated_at();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants + RLS
-- PostgREST (supabase-js) connects as `authenticated` for signed-in users.
-- ---------------------------------------------------------------------------
grant usage on schema house_project to authenticated, anon;
grant all on all tables in schema house_project to authenticated;
alter default privileges in schema house_project grant all on tables to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'projects','project_items','recurring_flows','salary_changes',
    'life_events','accounts','bonuses','financing_options','settings'
  ] loop
    execute format('alter table house_project.%I enable row level security;', t);
    execute format('drop policy if exists hp_rw on house_project.%I;', t);
    -- one policy for all commands: row must belong to a household the user is in
    execute format($f$
      create policy hp_rw on house_project.%I
        using (household_id in (select house_project.my_household_ids()))
        with check (household_id in (select house_project.my_household_ids()));
    $f$, t);
  end loop;
end $$;
