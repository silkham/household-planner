-- Session 4: priority becomes a single manually-set 1–5 field.
-- The derived impact/urgency/effort score + settings.priority_weights are
-- retired in the UI/engine but the columns are LEFT IN PLACE (non-destructive).
-- Applied via the Supabase Management API query endpoint (no Docker locally).

alter table house_project.projects
  add column if not exists priority int not null default 3;

-- Backfill the seed projects with varied priorities so the sort is meaningful.
update house_project.projects set priority =
  case
    when name ilike '%kitchen%' then 5
    when name ilike 'Garage%'  then 4
    when name ilike 'Shed%'    then 3
    when name ilike 'Hallway%' then 2
    else priority
  end;
