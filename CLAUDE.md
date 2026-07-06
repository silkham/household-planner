# HouseholdOS — Project & Financial Planner

> A single PWA that answers one question: **"Can we afford to start that project, given everything else going on in our life?"**

---

## The Problem

We've tried the Fifi McGee Home Renovation Budget Planner and it's the wrong shape. It's a **line-item cost catalogue** for one linear renovation — you list every job under a room, and it tallies estimate vs quote vs actual. That model breaks down for our reality:

1. **We have multiple parallel projects at different stages** — Garage finish, Shed + concrete base, Hallway flooring, Kitchen reno — not one big reno broken by room.
2. **Life-side financial events dominate the picture** — 2nd potential mat leave, PCP end on the second car, nursery costs starting — and they eat into what's available for projects.
3. **The interaction is the whole point.** Can we start the kitchen in September if mat leave is in March? Does deferring the shed by 3 months unlock the hallway floor? The Fifi sheet can't answer that.

The Excel prioritiser we built earlier was a good v0 for ranking projects, but this is the next step: **projects on top of a rolling household cashflow**.

---

## What This Is

A single-file HTML PWA — same stack as HouseholdOS, Partner Tracker, Strive/Stride, Lexie & Me:

- Vanilla JS, no build step
- Tailwind via CDN
- Supabase for storage + auth (multi-device, Lachlan + Christine both edit)
- Recharts via ESM CDN for the cashflow chart
- GitHub Pages hosting
- **"Living money-app" aesthetic** (see Design System) — dark + light, animated aurora backgrounds, glass/soft-shadow surfaces, a mint/violet/blue/amber/coral state system, and the Stride motion kit. Fraunces (headings) + Inter Tight (body) survive from the field-guide era. This replaces the old muted sage/clay/stone look after v1 mockup review (2026-07).

Multi-device sync matters here: Christine and I need to look at the same forecast and both edit projects. Supabase from v1 rather than localStorage-then-migrate.

---

## The Mental Model (this is the whole app)

Three connected things:

1. **Projects** — each has cost, priority, target start month, duration in months. Cost spreads across those months (evenly by default, overridable). A project can optionally be broken into **line items** that sum to its total (e.g. the kitchen = units + appliances + labour + …); the summed number is what sits on the cashflow. Line items also carry actuals, so you can track spend vs budget.
2. **Life financials** — recurring monthly income/expenses (mortgage, salaries, nursery, PCP payment), plus **one-off life events** with a start date and an effect on the cashflow ("Mat leave starts March 2027, salary drops to £X for 9 months").
3. **Cashflow forecast** — a 24-month rolling monthly view. Income − life expenses − project spend = net. Running cash position tracked against a user-set buffer.

The **join** is the killer feature: drag a project's start date and watch the cashflow ripple. That's what Fifi McGee cannot do and what makes this worth building.

---

## Data Model (Supabase)

Design tables around the mental model, not the UI. All tables carry `user_id` and `household_id` — the household is the sharing unit between Lachlan and Christine.

### `projects`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| name | text | "Kitchen reno", "Shed + concrete base" |
| category | text | Structural / Cosmetic / Repair / Garden / Energy / Furniture |
| status | text | Idea / Planned / Quoted / In Progress / On Hold / Done |
| priority_score | int | 0–100, auto-calculated from impact/urgency/effort/cost and the weights in `settings.priority_weights`. Surfaced on the Projects cards (no separate Priorities tab). |
| impact | int | 1–5 user input |
| urgency | int | 1–5 user input |
| effort | int | 1–5 user input (higher = easier) |
| estimated_cost | numeric | total £. **Derived = SUM(project_items.estimated_cost) when the project has line items**; manual entry only when it has none. Treat as read-only in the UI once items exist. |
| actual_cost | numeric | total actual £. Derived = SUM(project_items.actual_cost) when line items exist; manual otherwise. |
| budget_status | text | 'estimate' / 'budgeted' / 'tracking' / 'closed'. `estimate` = rough number; **`budgeted` = user pressed "Confirm budget"**, every line has a real quote and the total is trustworthy; `tracking` = actuals being logged; `closed` = done. Drives the confidence weighting below. |
| target_start_month | text | 'YYYY-MM' — treat months as strings, no timezone pain |
| duration_months | int | default 1 |
| cost_spread | jsonb | optional override: `{"2026-09": 8000, "2026-10": 15000, "2026-11": 5000}`. If null, split evenly. |
| notes | text | |
| created_at, updated_at | timestamptz | |

`budget_status` feeds the forecast the same way `confidence` does elsewhere: an `estimate` project is speculative money, a `budgeted` one is trustworthy. The scenario filter (conservative/realistic/optimistic) can lean on this so a loosely-estimated project doesn't masquerade as a firm commitment.

### `project_items`
Optional line-item breakdown of a project. Deliberately lightweight — **not** a quote-comparison catalogue (that's the Fifi McGee trap). The whole point is (a) letting a project's total be a sum you build up, and (b) tracking actual vs budget once work starts. These also populate the cross-project **Tasks** tab.
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| project_id | uuid FK → projects | |
| name | text | "Units & worktops", "Install labour", "Order concrete base" |
| estimated_cost | numeric | budgeted £ for this line |
| actual_cost | numeric nullable | filled as spend happens; null = not yet spent |
| status | text | 'todo' / 'quoted' / 'done' |
| sort_order | int | manual ordering within a project |
| notes | text | |
| created_at, updated_at | timestamptz | |

The cashflow engine never reads `project_items` directly — it only ever consumes the project's (derived) `estimated_cost`. Line items are a UI/tracking concern; the engine stays a function of one number per project.

### `recurring_flows`
Income and outgoings that repeat monthly (or with a defined cadence).
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| name | text | "Lachlan salary (net)", "Mortgage", "Nursery", "PCP payment" |
| kind | text | 'income' or 'expense' |
| amount | numeric | monthly £ (positive number, sign inferred from `kind`). For salaries, use net after tax/pension/salary sacrifice — the forecast doesn't do payroll. |
| start_month | text | 'YYYY-MM' |
| end_month | text | 'YYYY-MM' nullable — indefinite if null |
| category | text | Salary / Housing / Childcare / Vehicle / Utilities / Groceries / Loan / Other |
| annual_uplift_pct | numeric nullable | e.g. 0.03 for a 3% annual pay review. Applied every April by default (`uplift_month`). Nullable — flat if not set. |
| uplift_month | int | month of year uplift kicks in, 1–12. Default 4 (April). |
| notes | text | |

Uplifts apply in the cashflow engine, not as data mutations — the base `amount` stays as it was set. This way "what if my rise is only 2%?" is a settings tweak, not a data edit.

### `salary_changes`
Step changes to a salary that aren't just annual uplifts — promotion, job change, Christine's partnership jump.
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| flow_id | uuid FK → recurring_flows | which salary this changes |
| effective_month | text | 'YYYY-MM' |
| new_amount | numeric | new monthly net |
| confidence | text | 'confirmed' / 'likely' / 'speculative' — see Scenarios below |
| notes | text | "Partnership decision expected Q1 2027" |

### `life_events`
One-off or step-change events that modify the cashflow. These are the "big rocks" — mat leave, PCP end, nursery start.
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| name | text | "Christine mat leave 2", "Nursery starts", "PCP ends" |
| event_type | text | 'income_change' / 'expense_change' / 'lump_sum' / 'decision_point' |
| effective_month | text | 'YYYY-MM' |
| duration_months | int | nullable — null = permanent from that month |
| monthly_impact | numeric | £ change vs baseline (negative = worse for cashflow) |
| linked_flow_id | uuid nullable | if event modifies an existing recurring_flow (e.g. replaces salary during mat leave), point to it |
| notes | text | |
| resolved | boolean | for decision_point — has user made the call yet? |

Decision points (like "what to do about the 2nd car after PCP") sit here as flagged items with `resolved = false`, so the app can nag until a decision is made.

### `accounts`
Where money currently sits. Explicitly separate because "we have £60k" is misleading if £45k of it is in ISAs you don't want to sell for a shed.
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| name | text | "Joint current", "Emergency fund", "Trading 212 ISA", "Cash ISA" |
| kind | text | 'current' / 'savings' / 'emergency' / 'investment' / 'other' |
| balance | numeric | current £ balance (user updates periodically) |
| available_for_projects | boolean | is this fair game for reno spend? Emergency fund = false. Investments = false by default (avoid CGT / market-timing decisions surfacing as "you have money"). Current + savings = true. |
| notes | text | |
| balance_updated_at | timestamptz | so the app can nag if it's stale ("last updated 4 months ago") |

The forecast uses `SUM(balance WHERE available_for_projects = true)` as the opening cash position. Non-project accounts are shown on the Finances tab as context ("You also have £X in investments and £Y ring-fenced") but don't feed the projects-affordability calculation.

### `bonuses`
Lumpy annual-ish income that's partly guaranteed and partly not. Kept separate from `recurring_flows` because the confidence question dominates: banking on unconfirmed bonus money to fund a reno is how people end up regretting a reno.
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| name | text | "Lachlan annual bonus", "Christine performance bonus" |
| expected_month | text | 'YYYY-MM' (or repeating — see `recurs_annually`) |
| gross_amount | numeric | expected gross £ |
| net_amount | numeric | expected net £ after tax — this is what feeds the cashflow |
| confidence | text | 'confirmed' / 'likely' / 'speculative' |
| recurs_annually | boolean | if true, project forward at same month each year |
| notes | text | |

### `financing_options`
Loan / credit scenarios being considered. **Not automatically applied to the forecast** — each option has a `status` and only `active` options draw down. This lets you model "if we take the £30k kitchen loan" side by side with "if we don't."
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| household_id | uuid FK | |
| name | text | "NatWest kitchen loan", "0% credit card for shed" |
| principal | numeric | £ borrowed |
| apr | numeric | annual rate, e.g. 0.065 |
| term_months | int | e.g. 84 |
| start_month | text | 'YYYY-MM' when drawn down |
| linked_project_id | uuid nullable | which project this funds |
| status | text | 'considering' / 'active' / 'declined' / 'repaid' |
| notes | text | |

Monthly payment computed at read-time (standard amortisation formula, no need to store). When `status = 'active'`: adds principal to cash in `start_month`, adds monthly payment as an expense for `term_months`.

### `settings`
Singleton per household.
| column | type | notes |
|---|---|---|
| household_id | uuid PK | |
| cash_buffer | numeric | red-line the cashflow shouldn't dip below. Represents the emergency fund target. |
| priority_weights | jsonb | `{impact: 0.35, urgency: 0.30, effort: 0.15, cost: 0.20}` — from the Excel version. Priority is no longer a tab; these weights live in the Settings sheet (gear icon in the header). |
| horizon_months | int | default 24 |
| forecast_confidence | text | 'conservative' / 'realistic' / 'optimistic' — which scenario the forecast currently shows (see Scenarios) |
| t212_enabled | boolean | Trading 212 read-only sync toggle (v1.1 — see Finance Integrations). Key/secret are NOT stored here; they live server-side in the Edge Function. |
| emma_sheet_url | text nullable | published Google-Sheet CSV URL for Emma transaction import (v1.x — see Finance Integrations). Sensitive; treat like a secret. |

### RLS

Everything gated on `household_id` matching an active membership. Membership table = `household_members(household_id, user_id, role)`. Standard pattern from HouseholdOS — reuse the policies.

---

## The Cashflow Engine

The core computation — runs client-side on every data change. Pure function, no side effects. Write it as a testable module even in vanilla JS. This is the beating heart of the app; get it right, everything else is presentation.

Signature:
```
computeForecast({ accounts, recurring_flows, salary_changes, life_events,
                  bonuses, projects, financing_options, settings, scenario })
  → { months: [{month, income, expenses, project_spend, net, cash, flags, breakdown}] }
```

`scenario` is `'conservative' | 'realistic' | 'optimistic'` — filters which uncertain items are included:
- **conservative**: only `confidence = 'confirmed'` for salary_changes and bonuses
- **realistic** (default): `'confirmed'` + `'likely'`
- **optimistic**: all three

Per-month calculation:
```
opening_cash = sum(a.balance for a in accounts if a.available_for_projects)

for each month M in [now, now + settings.horizon_months]:

    # ---- INCOME ----
    salary_income = sum(
        effective_amount(flow, M) for flow in recurring_flows
        where flow.kind = 'income' and flow.active_in(M)
    )
    # effective_amount applies annual uplifts and salary_changes (filtered by scenario)

    bonus_income = sum(
        b.net_amount for b in bonuses
        if b.hits_month(M) and confidence_passes(b, scenario)
    )

    financing_drawdown = sum(
        f.principal for f in financing_options
        if f.status = 'active' and f.start_month = M
    )

    life_income_adj = sum(
        e.monthly_impact for e in life_events
        where e.event_type = 'income_change' and e.active_in(M)
    )

    income[M] = salary_income + bonus_income + financing_drawdown + life_income_adj

    # ---- EXPENSES ----
    recurring_expenses = sum(
        effective_amount(flow, M) for flow in recurring_flows
        where flow.kind = 'expense' and flow.active_in(M)
    )

    loan_payments = sum(
        monthly_payment(f) for f in financing_options
        if f.status = 'active' and M in [f.start_month, f.start_month + f.term_months)
    )

    life_expense_adj = sum(
        e.monthly_impact for e in life_events
        where e.event_type = 'expense_change' and e.active_in(M)
    )

    project_spend[M] = sum(
        project_cost_in_month(p, M) for p in projects
        where p.status in {'Planned', 'Quoted', 'In Progress'}
    )

    expenses[M] = recurring_expenses + loan_payments + life_expense_adj + project_spend[M]

    # ---- NET & CASH ----
    net[M] = income[M] - expenses[M]
    cash[M] = (M = first_month ? opening_cash : cash[M-1]) + net[M]

    # ---- FLAGS ----
    flags[M] = []
    if cash[M] < 0: flags.push('negative')
    if cash[M] < settings.cash_buffer: flags.push('below_buffer')
    if any project starts in M and (cash[M] - cash[M-1] < -0.5 * project.estimated_cost):
        flags.push('project_spike')
```

Helper functions:

**`effective_amount(flow, month)`** — takes annual uplifts and one-off salary_changes into account:
1. Start with `flow.amount`
2. Apply compounded annual uplift for each `uplift_month` between `flow.start_month` and `month` (if `annual_uplift_pct` is set)
3. Apply any `salary_changes` linked to this flow with `effective_month ≤ month`, taking the latest one that passes the confidence filter

**`project_cost_in_month(project, month)`**:
1. If `cost_spread` has an entry for `month` → return that value
2. Elif `month` in `[target_start_month, target_start_month + duration_months)` → return `estimated_cost / duration_months`
3. Else 0

**`monthly_payment(financing)`** — standard amortisation:
```
r = apr / 12
P = principal
n = term_months
payment = P * (r * (1+r)^n) / ((1+r)^n - 1)
```
Guard for `apr = 0` (0% credit card case): return `principal / term_months`.

**`hits_month(bonus, month)`** — if `recurs_annually`, matches on month-of-year and year ≥ `expected_month`'s year. Otherwise exact match.

**`breakdown`** per month — keep the individual line items so the UI can expand a month and show "here's why we go negative in April": which salary, which bonus, which project, which loan payment. Don't just return totals.

### Scenario switching

The forecast tab has a segmented control: `Conservative | Realistic | Optimistic`. Same underlying data, different filter. Users should see all three easily — the point of separating `confidence` on salary_changes and bonuses is that Christine's partnership jump and Lachlan's bonus shouldn't disappear from the app, they should just be flagged as "if this happens, here's the picture."

---

## Screens

Four tabs. Bottom nav on mobile, sidebar on desktop.

### Add/edit pattern (applies to every editable entity)
All CRUD — life events, recurring flows, salary changes, bonuses, financing options, accounts, projects, line items — happens in a **bottom-sheet form** reached by a "+" affordance (new, blank) or by tapping an existing item (edit, pre-filled). Conventions:
- Header row: Cancel · title · Save. Delete is a quiet destructive action at the foot of the sheet.
- A **`type` control reshapes the visible fields** where relevant (e.g. a life event's Income / Expense / Lump sum / Decision segmented control swaps which inputs show).
- **Live-impact preview** inside the sheet: as the user edits, run the values through `computeForecast` and show the ripple *before saving* ("cuts income £1,400/mo Mar–Nov 2027 → cash dips to £3.5k, below buffer"), with a jump to the forecast. This is the app's core "join" surfaced at edit time, not just on the Forecast tab.
- Fields map 1:1 to table columns; derived values (e.g. `monthly_impact` from new-amount vs replaced-amount) are computed in the sheet, not typed raw.

### 1. Forecast (default landing)
The money view. The reason to open the app.

- **Cashflow chart** at the top — Recharts area chart, 24 months, cash position over time. Buffer line dashed. Any month that dips below buffer highlighted red on the axis.
- **Alert strip** below the chart — "You'll dip below your £5k buffer in April 2027" — one line per issue, tap to jump to the month.
- **Monthly table** below — collapsible rows per month showing Income / Expenses / Project spend / Net / Running cash. Tap a month to expand and see which projects are drawing that month.
- **Scenario toggle** in the header — `Conservative | Realistic | Optimistic`, wired to the engine's confidence filter (this is real in v1, not a stub). The *what-if* controls (e.g. "what if the kitchen slips 3 months") are the separate v2 piece.
- **Settings** live behind a gear icon in the header, not a nav tab — cash buffer, priority weights, scenario default, and the Trading 212 / Emma import config.

### 2. Projects
The doing view.

- List of projects, sorted by priority score descending by default (toggle to: by target date, by cost, by status). Priority scoring lives here now (there's no Priorities tab) — the score badge on each card, with weights configured in Settings.
- Each row: name, priority score badge, status pill, £ cost, target start month, mini bar showing months of duration.
- **Affordability indicator** per project — green tick if it fits the forecast, amber if it pushes cash below buffer, red if it drives cash negative. This is the piece that ties projects to finances and is the actual point of this whole app.
- Tap a project → **detail sheet** with editable fields, including the cost spread override, plus:
  - **Line items** (`project_items`) — add/edit rows that sum to the project total. When items exist, the headline cost is the derived sum (read-only).
  - **"Confirm budget" button** — locks the project from `estimate` → `budgeted` when every line has a real quote. Shows a "Budget locked" state.
  - **Actuals + variance** — log actual cost per line; the sheet shows spend-vs-budget (e.g. "£24,400 of £45,000 · £400 over on units") with a progress bar.
- FAB to add.

### 3. Finances
Five sections, in this order (top to bottom on mobile, two-column on desktop):

- **Accounts** — cards showing each account with balance, kind, and an "available for projects?" toggle. Stale balances (>60 days since `balance_updated_at`) get a nudge. Total-available and total-ring-fenced shown at the top.
- **Recurring** — table of income and expenses, sortable, with columns for annual uplift where set. Add/edit/end.
- **Salary changes** — separate section under Recurring, showing scheduled step-changes with their confidence flag. This is where Christine's partnership jump lives.
- **Bonuses** — cards showing expected month, net amount, confidence. Confidence sets the badge colour.
- **Financing options** — cards per option (considering / active / declined / repaid). Each shows monthly payment, total interest, and a mini-cashflow preview of what activating it does. Activating an option is a deliberate action, not a background side effect.
- **Life events** — timeline view rather than a table. Chronological, chunky cards. Unresolved decision points highlighted with a "decide" CTA. This is where mat leave, PCP end, nursery start live.

**Data source:** all balances and recurring flows are **manual entry in v1** (the `balance_updated_at` staleness nudge exists precisely because it's manual). External sync (Trading 212, Emma) is layered in later — see Finance Integrations.

### 4. Tasks
The cross-project doing view. Aggregates every `project_items` row across all projects into one checklist, grouped by project.

- Grouped by project; each line shows name, £ estimate, actual (if logged), and status (`todo` / `quoted` / `done`).
- **Filters**: To do · Quoted · Over budget. "Over budget" surfaces any line where `actual_cost > estimated_cost`.
- Tick a line to mark `done`; log an actual inline. Editing here writes the same `project_items` rows the project detail sheet shows — one source of truth.
- This is the "what needs doing / buying next" companion to the Projects "planning" view. The per-project breakdown still lives in the project detail sheet; this tab is the roll-up across everything.

*(Priorities is no longer a tab. The scoring engine moved onto the Projects cards as a score badge + sort; the weight sliders — impact/urgency/effort/cost, must total 100% — moved to Settings. The affordability-vs-merit flag now lives on the project card and the priority sort.)*

---

## Finance Integrations (roadmap)

Confirmed after research on 2026-07. The affordability engine is agnostic about where a number came from, so integrations are additive and never block v1.

- **v1 — Manual.** Type balances and recurring flows. Staleness nudges keep them honest. Ships first.
- **v1.1 — Trading 212 (read-only).** T212 has a real public API (personal API key + secret; Invest / Stocks ISA only, not SIPP; read portfolio + account cash in real time). **The secret cannot live in client-side JS**, so it must be proxied through a **Supabase Edge Function** that holds the key and returns just the portfolio value. Low urgency because the T212 ISA is ring-fenced (`available_for_projects = false`) — it's context, not spendable-for-projects money.
- **v1.x — Emma via Google Sheets CSV.** Emma has **no usable official API** (a developer API is "on the roadmap" only). The community route — and what the `emma-transactions-mcp` project actually does — is to **export Emma transactions to a Google Sheet published as CSV**, then read that. A browser can fetch a published-CSV URL directly (CORS-friendly), so the PWA reads it with **no backend**. Store the sheet URL in `settings.emma_sheet_url`; treat it as sensitive (anyone with the URL can read it). Feeds recurring-payment detection and a spend view. Trade-off: manual/periodic export, not live. (An MCP server itself is for AI assistants and is not consumed by the PWA — we replicate the CSV approach, not "install the MCP".)
- **Later — Open Banking.** Live current-account balances + automatic recurring-payment detection via a licensed aggregator (GoCardless Bank Account Data / TrueLayer / Plaid). Needs regulated AISP access, an OAuth redirect flow, a backend (Edge Functions), and usually a cost above free tiers. Proper post-v1 milestone, not v1.

---

## Seed Data

Load these on first open of a fresh household (idempotent — don't re-seed if data exists).

### Projects
| Name | Category | Status | Est. Cost | Target Start | Duration |
|---|---|---|---|---|---|
| Garage finish (utility + storage) | Structural | In Progress | £1,500 | 2026-07 | 2 |
| Shed + concrete base | Garden | Planned | £5,500 | 2026-08 | 2 |
| Hallway flooring | Cosmetic | Planned | £2,000 | 2026-09 | 1 |
| Full kitchen reno | Structural | Quoted | £45,000 | 2027-02 | 4 |

Numbers are placeholders — user will overwrite. Kitchen cost estimated from prior context (NatWest loan work) but flag as `TBC`.

Seed the kitchen with placeholder **line items** (so the sum→total behaviour is visible on first open), all `status = 'quoted'`, `TBC` in notes: Units & worktops £18,000 · Appliances £6,000 · Install labour £9,000 · Electrics & plumbing £7,000 · Flooring & tiling £5,000 (sums to £45,000). Other seed projects get no line items — they demonstrate the single-number path.

### Life events (all placeholders — `TBC` in notes, monthly_impact = 0 until user fills in)
- Christine mat leave 2 — `income_change`, effective TBC, duration 9 months
- PCP ends on 2nd car — `decision_point`, effective TBC, unresolved (options to model: keep + buy out, replace with new PCP, replace with lease, drop to one car)
- Nursery starts — `expense_change`, effective TBC

### Recurring flows
Leave empty — user adds their own. Do NOT seed fake salaries.

### Accounts
Seed empty structure only (name + kind, balance = 0, `TBC` in notes) so user knows where to put what:
- Joint current — `current`, available
- Emergency fund — `emergency`, not available (buffer protects this)
- Trading 212 ISA — `investment`, not available
- Cash ISA — `savings`, available

### Bonuses
Placeholder cards (net_amount = 0, confidence = 'likely', `TBC` in notes):
- Lachlan annual bonus — expected March, recurs annually
- Christine annual bonus — expected March, recurs annually

### Salary changes
Placeholder for the partnership decision:
- Christine → Partner uplift — effective TBC, new_amount = TBC, confidence = `speculative`, note: "Partnership decision expected Q1 2027"

### Financing options
Placeholder for the kitchen loan question (user's context: NatWest £50k over 10 years already explored):
- NatWest kitchen loan — principal TBC, apr TBC, term TBC, linked to Kitchen project, status = `considering`

### Settings
- `cash_buffer`: 5000 (sensible default, editable)
- `horizon_months`: 24
- `priority_weights`: `{impact: 0.35, urgency: 0.30, effort: 0.15, cost: 0.20}`
- `forecast_confidence`: `realistic`

---

## Design System

"Living money-app" — dark-first with a full light counterpart, inspired by the finish of Stride (`../Fitness`). Depth and motion are the point: nothing should read flat. Locked after v1 mockup review (2026-07); replaces the old muted field-guide look.

### Fonts (kept)
Fraunces (headings, weight 500), Inter Tight (body/UI). Google Fonts.

### Both modes
Every colour must work in dark and light. Provide a `[data-theme]` (or `prefers-color-scheme`) switch. Design tokens as CSS variables.

**State / accent system** (semantic, consistent across all screens):
| Role | Dark | Light | Meaning |
|---|---|---|---|
| Mint / green | `#34E0A1` | `#12A66E` | good — fits budget, positive net, income |
| Coral | `#FF6B5A` | `#E5533D` | danger — below buffer, over budget, negative |
| Amber | `#FFA24B` | `#C9820F` | caution — tight, quoted-not-confirmed |
| Violet | `#7B5CFF` | `#6B4FE0` | decisions / priority accents |
| Blue | `#2B8BFF` | `#2472D6` | neutral-informational, secondary series |

**Surfaces**:
- Dark: base `#0A0D11`, translucent cards `rgba(20,27,34,.5)` with `inset 0 1px 0 rgba(255,255,255,.04)` top-highlight; frosted nav/pills via `backdrop-filter: blur(8px)`.
- Light: warm base `#F6F8F6`, white cards, soft shadow `0 2px 10px rgba(27,38,32,.05)`, hairline `#E4E7E3`.
- **Aurora background** — three large blurred blobs (mint/violet/blue) drifting on 16–22s loops behind the content. `mix-blend-mode: screen` + `opacity ~.32` on dark; pastel fills + `opacity ~.4`, no screen-blend, on light. A faint contour texture (`repeating-radial-gradient`) woven over. Scoped inside the app frame, `z-index:0`, `pointer-events:none`.

### Motion kit (from Stride — `../Fitness/styles.css`)
- Easing `cubic-bezier(.22,.6,.36,1)`; durations 180/240/360ms.
- **cardSettle** — content children fade-up (`translateY(9px)→0`) staggered ~60ms on view mount.
- **sparkDraw** — chart line draws itself in via `stroke-dashoffset` (~1.3s); set `pathLength="1000"` so it's length-independent.
- **areaFade** — chart area fill fades up after the line draws.
- Small flourishes: number/point pop-in, pulsing halo on the danger point, FAB scale-in, animated progress/weight bars (`scaleX`).
- Respect `prefers-reduced-motion`: disable aurora drift + draw-on, keep opacity fades.

### Chart
The spec lists Recharts, but the mockups use hand-built inline SVG (gradient area fill, glow filter on the line, dashed buffer redline, annotated event markers, circled low-point). **Prefer the bespoke SVG** — it carries the aesthetic and the draw-on animation Recharts won't. Only reach for Recharts if the bespoke SVG gets unwieldy.

### Misc
- Radius: 12–18px on cards, 8–12px on controls, pills where noted.
- Density: comfortable on mobile, tighter on desktop.
- **No emoji in UI chrome.** Icons from Lucide (mockups used Tabler as a stand-in — Lucide is the app's set).
- Person tints where dual-profile shows up: Lachlan indigo/blue, Christine coral.

---

## Suggested Session Plan

Break into 4 Claude Code sessions, each ~60–90 min. Each ends with a working commit.

**Session 1 — Foundation**
- Repo, Vite? (no — stick to single-file HTML pattern), Supabase project, tables, RLS policies, auth (magic link or Google, same as HouseholdOS), design tokens as CSS variables, tab shell with empty screens.

**Session 2 — Data layer + Finances tab**
- CRUD on all financial tables: `accounts`, `recurring_flows`, `salary_changes`, `bonuses`, `life_events`, `financing_options`. Seed the placeholders. Get all five Finances sections functional. This session is bigger than v1's original scope — expect it to run long or split into 2a/2b (2a = accounts + recurring + salary changes; 2b = bonuses + financing + life events).

**Session 3 — Projects tab + cashflow engine**
- CRUD on `projects` and `project_items` with seed data (derived sum→total, `budget_status` lock, actuals/variance). Build the pure cashflow function with unit tests (Node script, not in-browser) — this must handle scenarios, uplifts, bonuses by confidence, loan amortisation, life events. Wire it to the Projects list to show affordability indicators. The tests matter here more than anywhere else in the app.

**Session 4 — Forecast tab + Tasks tab + Settings**
- Bespoke SVG cashflow chart (draw-on animation) with scenario segmented control, monthly table with expandable breakdowns, alerts strip. Tasks tab (cross-project `project_items` roll-up, filters). Settings sheet behind the header gear (buffer, priority weights, scenario default, integration config). PWA manifest + service worker. Deploy to GitHub Pages.

Post-v1 backlog:
- Scenario mode (what-if slider on project dates)
- Trading 212 read-only sync (Edge Function proxy) — v1.1
- Emma transaction import via published Google-Sheet CSV — v1.x
- Open Banking (GoCardless / TrueLayer / Plaid) for live balances + recurring detection
- Christine + Lachlan household sharing (invite flow)
- Import from the old Fifi McGee sheet (one-shot mapping script)
- Photos per project

---

## Non-Goals for v1

- **Line-item breakdowns are now in scope** (added 2026-07) — but only the lightweight `project_items` version that rolls up to one cashflow number and tracks actuals. Still **out**: quote-comparison per line, multiple contractor quotes per item, room-by-room catalogues. That distinction is what keeps us out of the Fifi McGee trap.
- Contractor / quote comparison tooling
- Open Banking / live bank sync (post-v1 milestone — see Finance Integrations). Trading 212 read-only and Emma CSV import are v1.1/v1.x, not v1.
- Multi-currency
- Anything the Fifi McGee sheet has that we don't specifically want

---

## Working Preferences (Claude Code)

- Push back on architectural choices you think are wrong. Don't just build what I say if a better shape exists.
- Show the plan before writing code for anything non-trivial.
- Keep files under ~800 lines. If a file is getting bigger, propose a split.
- Commit at meaningful checkpoints with clear messages, not one giant "wip" at the end.
- Test the cashflow engine with a Node script before wiring it to the UI. Everything downstream depends on it being correct.
- If you find yourself writing the same thing twice, extract it. If you're generating 20 near-identical lines, use a loop or data-driven rendering.
