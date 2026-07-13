# HouseholdOS Planner — V2 Plan

> Living planning doc for V2. V1 is feature-complete + live (1.20.1). This
> captures scope, the navigation/IA rethink, and build sequencing. Update as
> decisions land; move shipped items into `CLAUDE.md` as as-built notes.

## Scope (locked from Session 16 kick-off)

**In:**
- **What-if project-date slider** — drag a project's start month, watch the
  cashflow ripple live. Engine's already pure; mostly Forecast/Projects UI.
- **Household "add people" function** — just the mechanism to add a person;
  do NOT wire up Christine's account yet.
- **New page: Budgeting / Reports** — analyse expenses to find costs to kill;
  categories over months, trends, savings surfacing.
- **New page: Merchants** — biggest spends + changes over time, and the home
  for all-transaction browsing (filter + sort). Replaces the current
  search-only escape hatch in Spending.
- **Flesh out Projects** — currently feels basic (scope TBD — see open Q3).
- **Navigation + layout rethink** — 5 flat tabs won't scale to 7+ pages
  without clutter.

**Killed:** Trading 212 sync · Open Banking · Fifi McGee import · photos per
project.

## Information architecture

Group pages by **mental mode** rather than a flat tab row:

| Group | Pages | Notes |
|---|---|---|
| **Plan** (forward) | Forecast · Projects | What-if slider lives *inside* these as a mode, not its own page. Tasks folds into a richer Projects page as a sub-view (it's a cross-project roll-up, not a peer destination). |
| **Spend** (backward / analysis) | Spending · Reports · Merchants | Three backward-looking money views. Spending = monthly pots (current). Reports = trends + cost-cutting (new). Merchants = biggest spends + all-txn filter/sort (new). |
| **Set up** (the data) | Finances · Settings | Accounts / recurring / income / life events / financing. "Add people" goes in Settings. |

5 destinations + settings, grouped — fewer top-level things than a flat 7,
with room to grow. Group names `Plan / Spend / Set up` are placeholders.

## Menu mechanics (recommended)

- **Mobile — bottom nav (4) + "More", not a burger.** Keep the 3 most-used
  one-tap on the bar: Forecast · Spending · Projects · **More**. "More" opens a
  sheet with Reports, Merchants, Finances, Settings. Beats a burger:
  thumb-reachable, primary destinations always visible, matches banking-app
  convention; a pure burger hides everything behind one tap.
- **Desktop — persistent left sidebar with the 3 group headers, not hover
  dropdowns.** A sidebar always shows the full map + where you are; dropdowns
  hide structure. Fallback if horizontal space is precious: a top bar with 3
  dropdown groups.
- Keep the existing mint/violet aurora design system — only the **chrome**
  (sidebar / bottom-nav) changes, not the visual language.

## Suggested build sequencing (multi-session)

1. **Nav / IA refactor first** — new menu shell + regroup existing pages. Pure
   scaffolding; everything new slots into a clean structure. Low risk, high
   leverage.
2. **Merchants page** — reuses the Emma feed + existing txn/category logic.
   Medium.
3. **Reports / Budgeting page** — category trends over months + cost-to-kill
   surfacing. Medium-large (new pure aggregations; keep them testable).
4. **What-if slider** — engine already pure; Forecast/Projects UI work.
5. **Projects flesh-out** — after Q3 is answered.
6. **Add-people function** — small, in Settings.

Start with the nav refactor so new pages have somewhere to live.

## Open questions (needed before building step 1)

1. **IA grouping** — is `Plan / Spend / Set up` right, or regroup/rename?
   (Alt: collapse Spending + Reports + Merchants under one "Money" umbrella.)
2. **Mobile pattern** — bottom-nav-4-plus-More vs a burger?
3. **"Flesh out Projects" — what's missing?** The key unknown. Candidates to
   scope with the user: richer line-item tracking, timeline/Gantt view,
   per-project cashflow mini-chart, notes/photos, inter-project dependencies,
   better affordability detail.

## Reference

- Roadmap memory `roadmap-reprioritised-accuracy-first`: accuracy/Emma FIRST
  (done through V1), what-if slider + advisor LAST.
- Current tabs (to be regrouped): Forecast, Projects, Finances, Tasks, Spending
  (mounted in `js/app.js`).
