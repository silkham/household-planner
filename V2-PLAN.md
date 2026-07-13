# HouseholdOS Planner — V2 Plan

> Living planning doc for V2. V1 is feature-complete + live (1.20.1). This
> captures scope, the navigation/IA rethink, the Projects rework, and build
> sequencing. Update as decisions land; move shipped items into `CLAUDE.md` as
> as-built notes.

## Scope (locked, Session 16)

**In:**
- **Navigation + layout rethink** — 5 flat tabs won't scale to 7+ pages.
- **Home dashboard** — new app landing; a cross-cutting glance across forecast,
  spending, and projects that links into each. Shifts the landing from Forecast
  to Home. Home does NOT replace Forecast (which stays the deep money view) —
  it's the front door with glanceable summary cards. **Forecast, Spending, and
  Projects are three EQUAL pillars** — same card size + treatment, no one
  louder than the others (don't over-weight Projects just because it's the
  current build focus). Design approved via the V2 mockup (Session 16).
- **Projects rework** — the big one. Projects become **pages, not pop-ups**:
  - Clicking a project opens its own **detail dashboard** (a destination worth
    living in), not a bottom-sheet. Spend vs budget, affordability, a schedule
    of what's happening when, line items, and linked payments.
  - The **Projects tab is itself a dashboard** (summary up top), not a flat
    list.
  - **Line items get dates** so the detail page can show a real timeline (new
    `project_items` date column — see below).
  - Line-item *edits* stay quick bottom-sheets; the *project* is a full page.
- **New page: Budgeting / Reports** — analyse expenses to find costs to kill;
  categories over months, trends, savings surfacing.
- **New page: Merchants** — biggest spends + changes over time, and the home
  for all-transaction browsing (filter + sort). Replaces the search-only
  escape hatch in Spending.
- **What-if project-date slider** — drag a project's start month, watch the
  cashflow ripple live. Engine's already pure; Forecast/Projects UI work.
- **Household "add people" function** — just the mechanism to add a person; do
  NOT wire up Christine's account yet. Lives in Settings.

**Killed:** Trading 212 sync · Open Banking · Fifi McGee import · photos per
project.

## Information architecture

Group pages by **mental mode**. Home is the landing.

| Group | Pages | Notes |
|---|---|---|
| **Home** | Dashboard | Cross-cutting glance; links into everything (new landing). |
| **Plan** (forward) | Forecast · Projects → *(project detail pages)* | What-if slider lives *inside* these as a mode. Tasks folds into the fleshed-out Projects area as a sub-view. |
| **Spend** (backward / analysis) | Spending · Reports · Merchants | Spending = monthly pots (current). Reports = trends + cost-cutting (new). Merchants = biggest spends + all-txn filter/sort (new). |
| **Set up** (the data) | Finances · Settings | Accounts / recurring / income / life events / financing. "Add people" in Settings. |

Group names `Plan / Spend / Set up` are placeholders.

## Navigation mechanics (locked)

- **Desktop — persistent left sidebar** with the 3 group headers + Home at top.
  Always shows the full map + where you are. (Desktop nav largely works today;
  this is a regroup, not a rebuild.)
- **Mobile — bottom nav (5) + "More".**
  - Bottom bar: **Home · Forecast · Spending · Projects · More**. The three
    equal pillars (Forecast, Spending, Projects) each get a permanent slot;
    Home is the landing.
  - **"More" opens a drawer that IS the grouped menu** — same `Plan / Spend /
    Set up` list as the desktop sidebar. The drawer lists the FULL map (incl.
    Forecast/Spending/Projects so it's complete) plus Reports, Merchants,
    Finances, Settings. Not a pure top-left burger: keeps core one-tap +
    thumb-reachable, houses the full grouped map behind More.
- **Project detail = a route, not a sheet.** Introduces the app's first
  lightweight **client-side routing** primitive (click in → project view →
  back). Build it properly once; Merchants/Reports drill-downs reuse it.
- Keep the existing mint/violet aurora design system — only the **chrome**
  (sidebar / bottom-nav / routing) changes, not the visual language.

## Projects detail dashboard — contents

Most of this re-presents V1 data (budget, spent, remaining, affordability,
line items + actuals, linked Emma payments already exist). New pieces marked ★.

- **Header**: name · category · start + duration · status pill · back.
- **Stat tiles**: Budget · Spent · Remaining · Affordability (fits / tight /
  negative — from the engine).
- **Progress**: spend-vs-budget bar + over/under callout.
- **★ Schedule / timeline**: line items placed on a time axis — needs
  `project_items` dates.
- **Spend across the build**: month-by-month actual vs planned (derivable from
  the project's cost spread + linked payments).
- **Line items list**: each row budget/actual/status → tap opens the quick
  edit sheet.
- **Recent payments**: linked Emma transactions hitting this project.

## Home dashboard — contents (approved mockup, Session 16)

Three EQUAL pillar cards (same glass card, same size/treatment, each with a
headline number, a supporting line, and a tap-to-open chevron → its area):

- **Forecast** — cash available now + sparkline + next-dip/below-buffer warning.
- **Spending** — this month spent vs budget (progress bar) + a supporting line
  (£ left, biggest category).
- **Projects** — committed vs spent (progress bar) + next project spend.

Greeting header above. No standalone alert strip that would tip weight to
Forecast — the dip warning lives inside the Forecast card.

## Data model change

- **`project_items` gains a date.** Add a `due_month` (or `due_date`) column so
  line items can sit on the project timeline. Granularity (month vs full date)
  = build-time decision; month is consistent with the rest of the app's
  'YYYY-MM' convention, a full date gives a finer Gantt. Migration via the
  Management API (no Docker), paged reads already handle the table.

## Build sequencing (multi-session)

1. ~~**Nav / IA refactor + routing primitive + Home shell**~~ — **SHIPPED
   v1.21.0** (commit `9838dae`, on main, not yet pushed/deployed). One NAV def
   drives sidebar + bottom-nav + More drawer; hash router with back support +
   sub-route slot for project detail; Home dashboard with three equal pillars;
   Reports/Merchants stubs. Tasks temporarily under Plan. Needs live-Pages
   verification (browser preview blocked in sandbox).
2. **Projects rework** — project detail pages, `project_items` dates +
   timeline, Projects-tab-as-dashboard, fold in Tasks. Highest user value.
3. **Merchants page** — reuses the Emma feed + existing txn/category logic.
4. **Reports / Budgeting page** — category trends over months + cost-to-kill
   surfacing. Keep aggregations pure + testable.
5. **What-if slider** — Forecast/Projects UI over the already-pure engine.
6. **Add-people function** — small, in Settings.

## Resolved decisions

- IA grouping: `Home + Plan / Spend / Set up` ✓
- Mobile pattern: bottom nav (5) `Home · Forecast · Spending · Projects · More`
  + grouped drawer ✓
- Home dashboard: in, as the landing; three EQUAL pillars ✓
- Projects: detail pages + tab-as-dashboard ✓
- Line items get dates (for the timeline) ✓
- Visual design approved via the Session 16 mockup (Home, Projects dashboard,
  Project detail, More drawer) in the app's real dark/aurora skin ✓

## Reference

- Roadmap memory `roadmap-reprioritised-accuracy-first`: accuracy/Emma FIRST
  (done through V1), what-if slider + advisor LAST.
- Current tabs (to be regrouped): Forecast, Projects, Finances, Tasks, Spending
  (mounted in `js/app.js`). Edits today = bottom-sheets (`js/sheet.js`).
