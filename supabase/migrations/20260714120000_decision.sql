-- V2 step 4 (Reports/Analysis): a Keep / Kill / Review decision per fixed
-- commitment (recurring_flows) and per variable-spend bucket (categories).
-- null = undecided. Feeds the Analysis screen + the Reports cost-to-kill list.
-- Applied live via the Management API query endpoint.
alter table house_project.recurring_flows add column if not exists decision text;
alter table house_project.categories       add column if not exists decision text;
