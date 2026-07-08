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

Everything gated on `household_id` matching an active membership. Standard pattern from HouseholdOS — reuse the policies. **Correction (as-built, Session 1):** the real membership table is `public.household_memberships(user_id, household_id, member_id)` — **not** `household_members(…, role)` as this doc originally guessed. There is no `role` column.

---

## Build Infrastructure (as-built — read before touching the DB or dev server)

Locked in Session 1. These are the non-obvious facts that will bite a fresh session.

**Supabase — shared DB, dedicated schema.**
- We do **not** have our own Supabase project. We share the existing **`household`** project (ref **`dgbbyijhabjozqrkokrq`**, eu-west-1) with the meal/workout/Peloton apps. Its `public` schema already has ~20 unrelated tables, including a `settings` table that would collide with ours.
- Therefore **all planner tables live in a dedicated `house_project` Postgres schema**, not `public`. The schema is exposed to PostgREST (`db_schema = public,graphql_public,house_project`).
- **The client must use `supabase.schema('house_project')`** for every read/write. In `index.html` this is the exported `HP` handle (`export const HP = supa.schema('house_project')`). `supa.from(...)` would hit `public` and fail.
- RLS on every table via `using/with check (household_id in (select house_project.my_household_ids()))`, where `my_household_ids()` is a `SECURITY DEFINER` helper reading `public.household_memberships`. Grants go to `authenticated` only — `anon` is intentionally denied (verified).
- We reuse the existing household row **"Our household"** (id `13b5e642-3f21-403c-8336-56976f177269`); members are Christine (slot `a`) + Lachlan (slot `b`). No separate invite flow needed.

**Auth = email + password** (not magic link). Matches the existing shared account `lachlanmclean1990@gmail.com` (provider `email`, password set). The spec's "magic link or Google" line is superseded.

**Applying SQL without Docker.** `supabase db dump`/local dev need Docker (not available). Apply migrations via the **Management API query endpoint**: `POST https://api.supabase.com/v1/projects/<ref>/database/query`. Get the token from the macOS keychain: `security find-generic-password -s "Supabase CLI" -w`. **Use `curl`, not python `urllib`** — Cloudflare 403s urllib's signature. Migrations are saved in `supabase/migrations/` for the record even though they're applied via API.

**Dev-server landmine (this harness only).** The preview sandbox blocks the `getcwd` syscall *and* reading files under the project dir, so `python3 -m http.server` and Ruby WEBrick both fail here. Workaround used in-session: copy `index.html`/`manifest` into the scratchpad and serve with a tiny getcwd-free Ruby socket server from there. **On a normal machine `python3 -m http.server 5173` in the project root is fine** — this is purely a sandbox quirk, not a real constraint. The committed `.claude/launch.json` uses the plain python server.

**Anon key** is embedded in `index.html` — that's correct (it's the public client key; RLS is the real gate). The service-role/secret keys are never in client code.

**File layout (as-built, through Session 4).** The app is **no longer single-file** — it's `index.html` (shell + all CSS) plus **`js/*.js` ES modules**, loaded via `<script type="module" src="js/app.js">`. Still **no build step** (browser-native ESM; imports from esm.sh). Modules: `store.js` (Supabase `HP` handle, household resolution, state cache, generic `saveRow`/`deleteRow`, **`saveSettings`** for the household_id-keyed settings singleton, **`currentForecast()`** shared live forecast that feeds the engine derived line-item costs, idempotent client-side seed), `sheet.js` (reusable bottom-sheet form driven by per-entity field schemas — supports an `extra(box, draft)` content hook, `emptyNull` money fields, and **`cfg.save` / `cfg.saveLabel`** overrides for non-id-keyed writes), `engine.js` (cashflow — real `computeForecast`, plus `monthlyPayment`, `projectAffordability`, `linkedFlowDelta`, month helpers), `finances.js` (Finances tab), `projects.js` (Projects tab; exports `editItem`/`syncTotals` reused by Tasks), `forecast.js` (Forecast tab — bespoke SVG chart + scenario control + alerts + expandable monthly table), `tasks.js` (Tasks tab — project_items roll-up), `settings.js` (gear sheet incl. the Salaries editor + About/version), `emma.js` (Emma fetch + balance sync — Session 5; `fetchEmma` now memoises the feed, `force=true` to refresh), `spending.js` (Spending tab — Session 6), `recurring.js` (Emma recurring-payment detector — Session 7; pure `detectRecurring` + a self-managed Finances section), `categories.js` (Session 7; managed spend categories — pure `buildExcludedSet`/`categoryNames` + the Spending-tab category manager), `version.js` (APP_VERSION/BUILD_DATE, single source), `app.js` (boot/nav/theme/auth/SW). Keep new features as modules under `js/`; don't collapse back into one file. Note the multi-file layout means the dev server must serve the `js/` subtree (the scratchpad Ruby workaround copies it too).

**Cash-in convention (as-built, Session 4).** Salaries are ordinary `recurring_flows(kind=income, category=Salary)` — the engine sums them; there are no salary columns in `settings`. The **Settings sheet** (gear) has a focused "Salaries (net)" editor for them (net = after tax/pension). A **life event linked to a salary** (`linked_flow_id`) models mat leave / pay drops: `engine.linkedFlowDelta` folds its `monthly_impact` into that flow's effective amount (income flow `+= impact`, expense flow `−= impact`, keeping the "− = worse for net" convention), and the engine **skips linked events in the standalone net path** so they're never double-counted. Unlinked events stay flat net deltas.

**Priority (as-built, Session 4).** Priority is **a single manually-set 1–5 field** (`projects.priority int`, default 3). The derived impact/urgency/effort/cost × `priority_weights` score and the three sheet controls are gone; the old columns + `priority_weights` remain in the DB but unused (non-destructive). Card shows a `P{n}` badge; sort-by-priority uses the field. No Settings weight-sliders — do not resurrect the multi-factor model.

**PWA (as-built, Session 4; cache-bust added Session 6).** `sw.js` is **network-first** (never serves stale code in dev; never caches Supabase/cross-origin), `icon.svg` is the app icon, `manifest.webmanifest` has icons+scope, registered in `app.js`. The SW cache is now version-busted — see "Versioning + PWA cache-bust" below. **Deployed to GitHub Pages** (remote `origin` = `github.com/silkham/household-planner`, `main` auto-builds; live at `https://silkham.github.io/household-planner/`). Push, wait ~1 min, confirm via `gh api repos/silkham/household-planner/pages/builds/latest` and by curling `js/version.js`.

**Cashflow engine (as-built, Session 3).** `computeForecast` is pure/deterministic (pass `startMonth` for tests). Two decisions that diverge from the spec pseudocode: (1) **`cost_spread` is authoritative** — when a project has a `cost_spread`, months absent from it contribute **0** (no even-split fallthrough), otherwise the total would exceed `estimated_cost`. (2) **`life_events.monthly_impact` is a signed delta to NET where negative = worse, uniformly for both `income_change` and `expense_change`** (matches the sheet's "− = worse" input); expense events fold in as `−monthly_impact`. The engine reads `projects.estimated_cost`, never `project_items` — `projects.js` keeps that field synced to the derived line-item sum on every item change.

**Engine tests.** `tests/engine.tests.js` (65 assertions) + `tests/run.sh`. **No Node on this machine** (or the user's), so the runner strips `export`/`import` and runs the bundle under **`osascript -l JavaScript` (JavaScriptCore)**, falling back to `node` if ever present. Run with `./tests/run.sh`. Any engine change must keep these green.

**Seed landmine.** The spec's placeholder "Christine → Partner uplift" `salary_changes` row is **not seeded** — `salary_changes.flow_id` is `NOT NULL` and we intentionally don't seed a fake salary flow. The Salary changes section shows an empty-state hint instead; the row becomes creatable once a real income flow exists.

**PostgREST bulk-insert union-NULL landmine (verified live, Session 3).** A multi-row `insert([...])` sends the **union of keys across all rows**; any row missing a key is sent `NULL`, *not* the column default. Bit the `life_events` seed — only the `decision_point` row carried `resolved`, so the other two were sent `resolved = null` and the whole batch was rejected (`resolved` is `NOT NULL`), seeding zero life events. Fix: every row in a batch must carry the same keys with non-null values for NOT-NULL columns. Applies to any future multi-row seed/insert.

**Emma integration — phase 1a (as-built, Session 5).** The forward-looking planner is now anchored to Emma (the money app) as the source of *current cash*. Key facts:
- **Emma's Google-Sheet export is a TRANSACTION FEED with NO current balances.** Live-synced accounts only carry ~12 months of history (start ~Apr 2025), and there is no per-row running balance and no opening-balance anchor for them. So **summing an account's transactions does NOT give its balance** — it gives net flow over the export window. (Only *manual* accounts — house, mortgage, Marcus, T212 — have a single "Initial Balance" row, in the **Counterparty** column.) This was verified live and is the whole reason for the hybrid design below.
- **Hybrid anchor balances.** New `accounts` columns `anchor_balance` + `anchor_date` + `emma_account`. A live balance is derived as `balance = anchor_balance + SUM(Emma txns for emma_account dated strictly AFTER anchor_date)`. The user enters a real balance once (the anchor); Emma's feed increments it; re-anchor by editing the balance (the `accounts` sheet `derive` re-stamps `anchor_balance`/`anchor_date` = today on every save). The engine + Finances keep reading `accounts.balance` untouched — the Emma sync just recomputes it (`js/emma.js` → `syncBalancesFromEmma`, writes `balance`+`balance_updated_at`, then `loadAll`).
- **Read path = a service-account Edge Function, not a public CSV.** The sheet is *privately shared* (not "published to web") to a Google **service account**; the `emma-sheet` Edge Function (Deno, Web-Crypto RS256 JWT → Google token → Sheets API) reads it server-side and returns parsed rows. The SA key lives ONLY in the Supabase secret **`GOOGLE_SA_KEY_B64`** (base64 of the JSON key). Never in client JS or the repo. Deploy: `supabase functions deploy emma-sheet --project-ref dgbbyijhabjozqrkokrq` (no Docker). ⚠️ Set the secret from an explicit newest-file path, not a glob — a glob grabbed the *old* rotated key once and Google returned `invalid_grant: Invalid JWT Signature`. ⚠️ **Never `@`-attach the SA key to the assistant** — it leaked the key into a transcript once and had to be rotated.
- **Sheet shape:** tab **`Mclean Household`** (~3,666 rows), 16 cols: `ID, Date, Amount, Account, Bank, Currency, Category, Subcategory, Type, Tags, Counterparty, Custom Name, Merchant, Additional details, Notes, Linked transaction ID`. **Amount is signed** (− = outflow). **Date is US `M/D/YYYY`.** For future category rules, match on **`Custom Name`** (Emma's cleaned merchant, e.g. "Specsavers") — `Counterparty` carries varying refs. Emma's `Category` is the source-of-truth category (`Excluded` = don't count in spend). Sheet id + tab live in `settings.emma_sheet_id` / `settings.emma_tab` (non-secret).
- **PRIVACY: the GitHub repo is PUBLIC.** Real balances / account names with real figures must **never** be committed. The 7 real accounts + anchors were written to the **live DB only** via the Management API; the committed seed in `store.js` stays generic placeholders. Opening spendable cash = sum of the three current accounts (Natwest + Santander + Wise); Marcus ×2 / T212 / Vanguard ring-fenced by choice. (Actual figures live in the DB only — never in this repo.)
- **Function hardening — DONE (Session 6).** `emma-sheet` now gates every call through `requireMember(req)`: it resolves the bearer token to a real user via `${SUPABASE_URL}/auth/v1/user` (the public anon key carries `role=anon` and resolves to no user → 401) and confirms household membership via the service role against `public.household_memberships` (→ 403 if not a member). The client already sends the user JWT through `supa.functions.invoke` when signed in. Verified live: an anon-key call that previously returned 3666 rows now returns `{"error":"unauthorized"}` 401. Uses the auto-injected `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` env vars.
- **Emma sync is mapping-driven and scoped to spendable accounts (Session 6).** Only accounts with a non-null `emma_account` are recomputed by `syncBalancesFromEmma`. The 4 ring-fenced accounts (Marcus ×2, Trading212, Vanguard — `available_for_projects = false`) had their `emma_account` cleared in the **live DB** so they're purely manual (they're manual inside Emma too — only an "Initial Balance" row, no txn feed, so a Emma-derived balance would always be anchor + £0). The 3 current accounts (Natwest/Santander/Wise) stay synced. Re-link later by setting `emma_account` in the account edit sheet.

**Emma integration — phase 1b: Spending tab (as-built, Session 6).** A 5th nav tab (`js/spending.js`, mounted in `app.js` after Forecast) — the backward-looking twin of Forecast. Reads the same Emma feed via `fetchEmma()` and shows actual **outflows by month × category**: a monthly-spend SVG bar chart (tap a bar to select a month), a category breakdown for the selected month (sorted, proportion bar), expandable to the underlying transactions. Decisions baked in: **spend = outflows only (`amount < 0`)**; Emma categories **`Excluded` and `Transfers` are skipped** (internal moves / card payments don't inflate spend or double-count); refunds are **not** netted (v1 simplicity). Categorisation: **Emma's `Category` is the default; a `house_project.category_rules` row overrides it, keyed on the merchant's `Custom Name`** (one rule per merchant re-buckets every past & future txn). Re-categorise = tap a transaction → writes/updates the rule (delete the rule to revert to Emma's category). The Emma feed itself is never mutated; nothing here feeds the cashflow engine. Fetch is lazy + non-blocking on mount with a Refresh button. New table + RLS in migration `20260707120000_category_rules.sql` (applied live); `category_rules` is in `store.js` `TABLES`/`state`.

**Emma integration — phase 1c: recurring detection → one-tap link (as-built, Session 7).** `js/recurring.js` turns the repeating parts of the Emma feed into forward-looking `recurring_flows` — **the only Emma-derived thing that feeds the cashflow engine** (Spending 1b does not). `detectRecurring(txns, {existingKeys, dismissed, rules, maxDate})` is **pure/testable** (`tests/recurring.tests.js`, 21 assertions, wired into `tests/run.sh` which now bundles both engine + recurring). Detection rules: group by `Custom Name` + sign; keep groups with ≥3 charges across ≥3 distinct months, median inter-charge gap **20–45 days** (monthly-ish — naturally drops groceries/Amazon which fire many times/month), occurrences ≤ months×1.6, and a last charge within **45 days** of the feed's newest txn (else treated as cancelled). `Excluded`/`Transfers` (after `category_rules` override) are skipped, same as Spending. The UI is a **self-managed section at the top of the Finances tab** (`#recurring-detect`, rendered by `finances.render()` which calls `mountDetected(openRecurringSheet)`); it lazily `fetchEmma()`s once and hides itself entirely when Emma is unconfigured or nothing is detected. **One-tap "Add"** opens the normal `recurring_flows` sheet pre-filled (via exported `finances.openRecurringSheet`), so the live cashflow-impact preview IS the confirm step. Suppression is two-layer: a created flow persists **`recurring_flows.emma_match_key`** (new nullable column, migration `20260707150000_recurring_match_key.sql`, applied live — cross-device "already added") written through a new **`"hidden"` sheet field type**; a per-device **localStorage `hp-recurring-dismissed`** set holds "not recurring" dismissals. `fetchEmma()` is now **memoised** so Spending + detection + balance-sync share one Edge Function call (`syncBalancesFromEmma` and Spending's Refresh pass `force=true`).

**Emma integration — phase 1d: managed categories (as-built, Session 7).** "Counts as spend" is now a **per-category flag the household controls**, replacing the old hardcoded `{Excluded, Transfers}` skip set (which lived duplicated in `spending.js` + `recurring.js`). New table **`house_project.categories`** `(name, counts_as_spend bool default true, sort_order)` — migration `20260707170000_categories.sql`, applied live; wired into `store.js` `TABLES`/`state` and **seeded idempotently with `Transfers` + `Excluded` as `counts_as_spend=false`** (the two safety defaults). `js/categories.js` holds the pure, shared helpers — **`buildExcludedSet(categories)`** (Set of non-counting names; `Transfers`/`Excluded` default-excluded unless a row flips them) and **`categoryNames(categories, txns, ruleCats)`** (the dropdown's union of managed + Emma-feed + rule categories, so nothing goes missing before it's "managed"). `detectRecurring` stays pure: it takes **`opts.excluded`** (a Set), defaulting to `{Excluded,Transfers}`; `computeSuggestions` passes `buildExcludedSet(state.categories)`. `spending.js`: the categorise sheet is now a **`select` dropdown** (options marked "· not counted") **plus a `_newCat` text field** — a `cfg.save` override optionally creates the category then upserts the rule. The **category manager** is a section at the **bottom of the Spending tab** (`categoryManagerHtml`/`wireCategoryManager`): every category (union) with a **counts-as-spend `.toggle`**, delete (managed rows only), and add — toggling an unmanaged Emma category creates a managed row on the fly. Mark a bucket non-counting once → it drops out of Spending totals AND recurring detection everywhere. (Balance sync still counts transfers — they really move an account balance.) `tests/recurring.tests.js` gained an `opts.excluded` case (23 assertions; 88 total green).

**Current-month reconciliation — phase 2 (as-built, Session 8; v1.5.1).** The Forecast tab's **current month** is now a live **expected-vs-actual** panel ("This month" card, between the alert strip and the monthly table) that fuses the forward-looking recurring flows with the backward-looking Emma feed, so overspend / a missing salary shows *mid-month*. `js/reconcile.js` holds the **pure** `reconcileMonth({month, txns, recurring_flows, category_rules, budgets, excluded})` → `{income:[group], expense:[group]}` (see `tests/reconcile.tests.js`, 28 assertions, wired into `run.sh`; 116 total green). **Household mental model (LOCKED — a v1.5.0 rework):** everything is a **known recurring flow** except one discretionary pot. Two group `type`s: **`flows`** groups list the known flows individually as `lines` — **income collapses into a single "Income" group**; expenses group by **the flow's own `category`** (Housing, Vehicle, Utilities…). Each line is **green (received/paid) or red (not-in/due)**, matched on `recurring_flows.emma_match_key` landing in *this* month's feed (NOT date logic); a received line shows **actual + expected**, unreceived rolls up as the group's `pendingExpected`. The **`budget`** group is the reserved **`General Expenses`**: `expected` = a user-set monthly budget, `actual` = **every counting outflow this month that ISN'T a known bill** (i.e. `amount<0`, category counts, and merchant key not in any active flow's `emma_match_key`), broken down into `categories` → transactions. So known bills are carved out of General automatically — zero per-category setup. The budget lives in **`settings.forecast_budgets jsonb`** (group-name → £/mo). ⚠️ The earlier `categories.forecast_group` column (migration `20260708100000_forecast_group.sql`) is **now UNUSED** — the model moved from per-category grouping to flow-category grouping; the column stays for non-destructiveness (like the old priority columns). The category manager (bottom of Spending) keeps only the **counts-as-spend toggle + a General Expenses budget field** (placeholder = avg discretionary spend/mo, auto-computed from unmatched outflows). Forecast lazily `fetchEmma()`s (memoised); a line's pencil opens `finances.openRecurringSheet(flow, render)`. Read-only overlay — never mutates the feed or the cashflow engine. Flows **without** an `emma_match_key` always read "due/not-in" (can't confirm) — nudge to link them via the phase-1c detector.

**Category management — merge/delete + multi-field matching (as-built, Session 8; v1.6.0).** Two linked fixes to the Emma category mess. (1) **Rule matching is now multi-field.** `category_rules` still key on a merchant string, but a rule matches a txn if that key equals **any** of `Custom Name / Merchant / Counterparty` (not just the first non-empty one). This is why a single re-tag now sticks across *every* month — Emma's `Custom Name` varies per charge for some merchants (Amazon, refunds), but `Merchant` is usually stable. The shared helpers live in **`js/categories.js`**: `txnKey(t)`, `ruleCategory(t, rulesMap)`, `effectiveCategory(t, rulesMap)` — imported by `spending.js`; **replicated inline** in the *pure* `reconcile.js` / `recurring.js` cores (they must stay import-free for the osascript test runner). Flow↔txn matching in `reconcile.js` is likewise multi-field (`matchesKey`). (2) **Category merge/delete tool.** Every row in the Spending category manager has a **move button** (`folder-input`) → a sheet that re-buckets the category's merchants to a target (existing / new / **Uncategorised**) in **one bulk upsert** (`store.bulkReassignRules(rules, deleteCategoryId?)`, `onConflict household_id,match_key`) and deletes the source managed row. Enumerates every distinct merchant currently resolving to that category **across the whole feed**, so all months move at once — the only reliable way to "delete" an Emma category (you can't delete it at source; it's stamped per-txn). **`categoryNames(categories, txns, rulesMap)`** now unions on the **effective** category (rules applied) + rule targets, so a fully-moved category actually disappears from the list. The old per-row hard-delete (which looked like it "did nothing" because the raw Emma category reappeared) is gone. `tests/reconcile.tests.js` gained multi-field cases (31 assertions; 119 total green).

**Housekeeping batch (as-built, Session 8; v1.7.0).** Five tidy-ups: (1) **The `General Expenses` budget now feeds the forecast engine** — `computeForecast` adds `settings.forecast_budgets["General Expenses"]` as a **flat monthly expense** every month (breakdown line "General expenses", `source:"budget"`), so the cash line reflects discretionary spend, not just fixed bills (the forecast was otherwise over-optimistic). (2) **Month fields are now `<select>`s, not `<input type="month">`** — WebKit/Safari (incl. the installed PWA) renders `type=month` as a bare text box; `sheet.js` `renderField` "month" case builds a select of 'YYYY-MM' options (−24…+48 months, blank first, current value injected if out of range). (3) The **Conservative/Realistic/Optimistic scenario toggle was removed** from the Forecast tab (unused — no confidence-tagged salary_changes/bonuses in play); the engine still defaults `scenario:"realistic"`, and `settings.forecast_confidence` is untouched, so it can be re-surfaced later. (4) **Recurring-flow cards are compact** (`.fcard.compact` single dense line: name · category · amount, end-month/uplift as small meta) — the Finances tab was getting crowded. (5) **Chart low-point label** now sits below the point (centred + edge-clamped) instead of overlapping the rising line. `tests/engine.tests.js` gained a general-budget case (68 assertions; 122 total green).

**Category-dropdown unification (as-built, Session 9; v1.7.1).** The `recurring_flows` category `<select>` is no longer a hardcoded 8-bucket list — `finances.js` `flowCatOptions()` unions the base buckets (Salary/Housing/Childcare/Vehicle/Utilities/Groceries/Loan/Other) with `categories.categoryNames(state.categories, cachedEmmaTxns(), rules)`, so managed + Emma-feed + rule-target categories appear when categorising a flow (keeps the Forecast "This month" flow-category grouping coherent). New `emma.js` **`cachedEmmaTxns()`** = a synchronous peek at the memoised feed for option lists (empty until `fetchEmma` runs, so Emma-derived names only fill in once the Finances tab's detector has fetched). Also hardened `sheet.js` `select` renderer to **inject an out-of-range current value** as an option so an untouched legacy category is never silently blanked on save. ⚠️ Two separate category systems still exist and are decoupled by default: `recurring_flows.category` (forward/forecast bucket) vs `category_rules` (backward/Spending, merchant-keyed) — this change only aligned the *lists*, not the data.

**Category bulk-mover + flow→rule sync (as-built, Session 9; v1.8.0).** Two linked category fixes for re-tagging many transactions. (1) **The category "Move/merge" sheet (folder-input, bottom of Spending) is now a per-merchant multi-select** — `js/categories.js` `merchantAgg(sourceName, txns, rules)` lists every merchant whose *effective* category is the source (name · txn count · £total, spend-desc; rule-only merchants with no txn in the window shown as "rule only"). All ticked by default with a Select all/none toggle; **Move** re-buckets only the ticked merchants to a target (existing / new / **Uncategorised**) via `store.bulkReassignRules`, and **deletes the source managed row only when the WHOLE category moved out** (`movedAll`). Leaving it untouched = the old whole-category behaviour. New `.pick-*` CSS in `index.html`. (2) **An Emma-linked `recurring_flows` save now syncs the Spending side** — `SCHEMAS.recurring_flows.save` (wired through both `edit()` and `openRecurringSheet()`) `saveRow`s the flow then, if `emma_match_key` is set, upserts a `category_rules` row (that merchant → the flow's `category`), so setting a recurring payment's category re-buckets its past & future transactions in Spending. This is the deliberate coupling of the two otherwise-decoupled category systems (`recurring_flows.category` ↔ `category_rules`), but only for flows Emma actually matched. Still NOT supported: per-transaction split of one merchant across categories (rules are merchant-keyed), and bulk re-tag of a merchant whose identity fields ALL vary per charge (multi-field matching can't catch it) — both flagged as bigger changes, build only on demand.

**Strict categorisation + "needs a category" prompt (as-built, Session 9; v1.9.0).** The household took manual control of spend categories (bulk merchant→category mapping via an exported worksheet), so the app **no longer trusts Emma's category for an unmapped merchant**. `categories.js` `effectiveCategory` changed from `rule || t.category || "Uncategorised"` to `rule || passThroughCategory(t.category) || "Uncategorised"`: only Emma's **internal-money signals pass through** — `passThroughCategory` normalises Emma's `Excluded`→`Excluded` and `Transfer`/`Transfers`→`Transfers` (Emma writes "Transfer" singular; the managed non-counting name is "Transfers" — the normalise is what keeps the £-huge Initial Balance + card payments out of spend). **Every other unmapped merchant → `Uncategorised`** (which counts as spend, so nothing is hidden). The same passthrough is **replicated inline** in the import-free pure cores `reconcile.js` (`effCat`) and `recurring.js` (the excluded-check `cat`) — keep all three in sync. Consequence: **excluding by Emma's raw category name no longer works for unmapped txns** — non-counting must come from a rule mapping to Transfers/Excluded (or the passthrough). A new **Spending-tab prompt** (`spending.js` `uncategorisedHtml`, `.sp-uncat` CSS, amber) lists every unmapped counting merchant (biggest £ first, top 25) — one tap opens the existing categorise sheet. Hides when none. ⚠️ Until the bulk merchant-rule import lands, most of the feed reads `Uncategorised` (only ~51 rules pre-existed) — strict mode is meant to debut alongside that import. `tests/reconcile.tests.js` + `tests/recurring.tests.js` updated (rule-based exclusion; Emma-`Transfer` passthrough case) — 124 total green (68 engine + 24 recurring + 32 reconcile).

**Category-driven recurring candidates (as-built, Session 9; v1.10.0).** A merchant the household mapped to a **`Recurring - *`** category is a human-verified recurring payment — stronger than cadence detection — so it now surfaces in the Finances "Recurring payments" section regardless of cadence (catches annual bills / irregular subs the monthly-window detector drops). New **pure** `recurring.js` `recurringByCategory(txns, {rules, recurringCats, existingKeys, dismissed, maxDate})` — groups merchants whose effective category (rule-first, same internal-money passthrough as `reconcile`/`categories`) is in `recurringCats`, computes amount (median charge) / count / last-seen, and flags **`stale`** when the last charge predates the feed end by > `STALE_DAYS` (45) so "was recurring but no longer" is obvious. `computeSuggestions` **unions** it with `detectRecurring` (the mapped/tagged candidate wins on dupes; non-stale sorted first). Both suggestion shapes now carry `source` (`"category"`/`"cadence"`) + `stale`; the card shows the category + a coral "not seen since …" marker (`.rd-stale`, `.rd-card.stale`), and `recordFrom` keeps a category-source flow's **Recurring-\* bucket as its `recurring_flows.category`** (Spending↔forecast aligned) while a cadence guess still maps through `toFlowCat`. `recurringCats` = managed categories whose name matches `/^recurring/i`. `tests/recurring.tests.js` +9 (133 total green: 68 engine / 33 recurring / 32 reconcile). Context: the Session-9 bulk merchant→category import (346 `category_rules`, 18 managed categories, ~£54k real 2026 counting spend after stripping ~£770k transfers) is what populates the Recurring-\* tags this reads.

**Shared-DB security note (Session 9).** The Peloton app's `public` tables (`peloton_classes`, `program_classes`, `program_index`, `programs`) had RLS **off** with full anon CRUD/TRUNCATE grants (Supabase advisor `rls_disabled_in_public`). Fixed live: RLS enabled + read-only SELECT policy for anon/authenticated, write grants revoked from anon/authenticated (service_role still writes). **Not our tables** — none of the 12 `house_project` tables were affected (all RLS-on). No repo change; the Peloton app is a separate Claude Code project.

**Session 10 batch (as-built; v1.11.0 → v1.11.4).** Forecast + Spending UX polish, no schema changes:
- **This-month Projects group** — the Forecast reconcile ("This month") card shows a `projectGroup(fc)` built from the engine's `currentForecast().months[0].breakdown.expenses` (`source:"project"` lines), tagged amber "planned", so the current month mirrors the future-month rows.
- **Transaction search (Spending)** — `spending.js` `searchResults()` + `#sp-search` box searches ALL txns (any category incl. non-counting Transfers/Excluded, both directions) by merchant/category/date/amount; tap a hit → the categorise sheet. This is the "see the mortgage that got swept into Transfers" escape hatch (the month "pots" view still hides non-counting).
- **Chart position callout** — the old native SVG `<title>` tooltip **did nothing on touch** (no hover). Replaced with a tap/hover callout (`calloutMarkup(i)`, month·cash·net, violet ring) that **defaults to the current month** (`selPoint=0`). ⚠️ Hover must repaint **only** the `.cf-co-slot` group (geometry cached in module `coPts`/`coBounds`) — a full `render()` on hover replays the `sparkDraw` line animation every hover (was a reported bug).
- **Month breakdown grouped by category** — engine `computeForecast` breakdown **expense** items now carry a **`category`** (recurring→`f.category`, budget→"General Expenses", loan→"Loan", life_event→"Life events", project→"Projects"); `forecast.js` `expenseGroups(m)` groups the expanded month row's "Out" list into collapsible per-category dropdowns (income stays flat). `expandedCat` Set keyed `month::category`.
- **Bonuses in the This-month card** — `reconcile.js` `reconcileMonth` now takes **`opts.bonuses`** and folds bonuses hitting the month (confirmed/likely, incl. `recurs_annually` month-of-year match, `net_amount>0`) into the **Income** group as `isBonus` lines (amber "bonus", always "to come" — no `emma_match_key` to confirm). Keeps the card's Income total in step with the forecast. `flowLine` hides the edit pencil for `isBonus` lines. Tests: reconcile 32→37 (138 total green).

**Category-rules ground truth (Session 10) — LANDMINE.** The on-disk `~/Downloads/merchant-mapping.xlsx` **`Map` tab is a STALE draft** (its category column disagrees with the household's reviewed mapping). Importing it in Session 10 overwrote ~142 good `category_rules`; repaired live from the user's **exported CSV** (335 reviewed merchants = 100% of spend by value) matched onto existing keys. **Do not re-import that xlsx's Map tab.** The xlsx **`Tail (auto)`** tab (330 tiny sub-£25 one-offs) is fine to best-guess (a keyword heuristic pass was applied: foreign-currency `(fee:)` → Holiday, food/pet/kids keywords). End state: **677 `category_rules`, 18 managed categories** (incl. `Transport`), DB-only (repo public). Under strict categorisation the feed still had a long **~390-merchant Uncategorised tail** beyond the reviewed set — **cleared in Session 11** (see the Session 11 batch below; now 1067 rules, 0 Uncategorised).

**Session 11 batch (as-built; v1.11.5 → v1.13.0).** The 4-task accuracy batch from the Session-10 handoff, all shipped + live:
- **Uncategorised tail cleared (DB-only).** The ~390-merchant strict-mode Uncategorised tail (£32k outflow) was best-guessed from the on-disk **`~/Downloads/Emma transactions - Mclean Household.csv`** (the full feed export — use it as the merchant source; no Edge Function auth needed). Heuristic: trust Emma's own `Category` when specific (Housing→House, Shopping, Transport, Holidays→Holiday, Eating Out, Entertainment, Groceries, Personal Care→Health, Business/Charity/Cash→Other, Bills→Recurring-Bills, Transaction Fee→Excluded); keyword-match the "General"/blank pile; fallback→Other. Keyed each merchant by `txnKey` (customName||merchant||counterparty), upserted on `household_id,match_key`. End state: **1067 `category_rules`, 0 Uncategorised counting merchants**. Scripts in the session scratchpad (`analyze.py`/`map_tail.py`/`build_upsert.py`).
- **Transfers visible in Spending "pots" (v1.11.5).** `spending.js` `categoryRows` now takes ALL month outflows and renders **non-counting buckets (Transfers/Excluded) below the counting ones**, under a divider, marked "not counted", expandable, but **excluded from the "£X spent" total and the proportion grand**. The bar chart + month total stay counting-only. CSS: `.sp-catrow.notcount`, `.sp-catoff`, `.sp-notcount-div`, `.sp-catbar.off`.
- **Transfer → Investment (v1.12.0).** An investment/savings account with no Emma feed of its own can now **"top up from" a non-counting category** via **`accounts.contrib_category`** (migration `20260708160000`). `emma.js syncBalancesFromEmma` gained a contrib pass: `balance = anchor_balance + SUM(−amount)` for txns whose `effectiveCategory === contrib_category` and dated after the anchor (a current-account outflow to the investment is `−£` in the feed, so `−amount` tops it up; a withdrawal nets back). Reuses `category_rules` + the managed-category non-counting flag — **no new merchant→account table**. `finances.js` accounts sheet got a "Tops up from category" select (non-counting cats only, `showIf !available_for_projects`). DB: `Transfer - Trading212/Vanguard/Marcus` categories + merchant rules created live; **Trading212 & Vanguard linked; Marcus category exists but UNLINKED** (two slots — user picks which). Only keeps the *displayed* balance current (investments are `available_for_projects=false`, so this never touches the projects-affordability number); tracks contributions, not market value (re-anchor to true up).
- **Recurring-flow frequencies (v1.13.0).** `recurring_flows` gained **`frequency` ('weekly'/'monthly'/'yearly') + `interval_n`** (migration `20260708170000`, applied live; defaults monthly/1 = old behaviour, fully backward-compatible). **`engine.js flowMonthFactor(flow, mIdx)`** spreads the per-occurrence `amount` into months: monthly hits every `interval_n` months from `start_month`; yearly lands on the start month-of-year every `interval_n` years; **weekly accrues `amount × (52/12) / interval_n` every active month** (approximate — no per-day schedule stored, user chose an interval dropdown). Both engine loops multiply by the factor with `if(!factor) continue`. **`reconcile.js`** mirrors this (`flowLandsInMonth` + `flowMonthlyExpected`, replicated import-free) so a yearly bill only shows in its month and weekly expected accrues. **`finances.js`** sheet: a `frequency` segmented control (set as the sheet's `typeField` so it reshapes fields live) + a unit-labelled interval `<select>` per frequency (three `showIf` fields sharing `interval_n`; the `save` override coerces the string to a number); per-period `impact` preview. **`recurring.js`** detector `recordFrom` infers cadence from the observed median gap. Tests: engine 68→84, reconcile 37→40 (**157 total green**).

**Versioning + PWA cache-bust (as-built, Session 6).** `js/version.js` is the **single source of truth** for `APP_VERSION` / `BUILD_DATE`, shown in **Settings ▸ About** and logged on boot. **No build step, so bump `version.js` BY HAND on every deploy** (minor = a shipped phase, patch = a fix). `app.js` registers the SW as **`sw.js?v=${APP_VERSION}`**, and `sw.js` derives its cache name (`hp-cache-v<version>`) from that query param — so a version bump = new SW URL = fresh cache = `activate` purges the old one. On a post-deploy SW takeover (`controllerchange`, when a prior controller existed) `app.js` **reloads once** so latest assets load hands-free. ⚠️ **The auto-reload only fires when `?v=` changes — i.e. only if you bumped `version.js`.** Forget the bump and the hands-free reload silently no-ops (network-first still serves fresh code on a manual reload). Version number == the SW cache key.

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
