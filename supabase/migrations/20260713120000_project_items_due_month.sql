-- project_items gains a due_month so line items can sit on the project detail
-- page's timeline. 'YYYY-MM' text to match the rest of the app's month model
-- (target_start_month, recurring_flows.start_month, life_events.effective_month
-- etc.). Nullable — an item with no date falls back to the project's active
-- months on the timeline. Additive; the engine never reads it.
alter table house_project.project_items
  add column if not exists due_month text;
