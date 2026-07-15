// ============================================================================
//  lifeos.js — LifeOS publish adapter.
//  Pushes a small set of "signals" into the shared `lifeos.signals` table so the
//  LifeOS hub can show this app's headline numbers + to-dos without reaching into
//  the planner's own schema. Fire-and-forget; never blocks or breaks the app.
//
//  "This month" is now a spend-vs-budget PROGRESS tile: discretionary spend so
//  far (General Expenses, from the Emma feed via reconcileMonth) against the
//  monthly budget, coloured by pace. "Projected cash" stays forecast-derived.
// ============================================================================
import { supa, state, resolveHousehold, currentForecast } from "./store.js";
import { fetchEmma } from "./emma.js";
import { reconcileMonth, GENERAL } from "./reconcile.js";
import { buildExcludedSet } from "./categories.js";

const LO  = supa.schema("lifeos");
const APP = "household";
const HUB = "https://silkham.github.io/household-planner/#/forecast";  // deep link

const gbp = (n) => {
  const v = Number(n) || 0, neg = v < 0, a = Math.abs(v);
  const s = a >= 1000 ? "£" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k" : "£" + a.toFixed(0);
  return (neg ? "−" : "") + s;
};

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Discretionary spend so far vs the monthly budget. `actual` = every counting
// outflow this month that isn't a known bill (reconcileMonth's General Expenses
// group); `budget` = settings.forecast_budgets[GENERAL]. State is PACE-aware:
// past budget → bad, ahead of a straight-line pace → warn, else good. Returns
// { actual, budget, state, detail } — actual is null when the feed can't load.
async function spendVsBudget() {
  const budget = Number((state.settings && state.settings.forecast_budgets || {})[GENERAL]) || 0;
  let actual = null;
  try {
    const res = await fetchEmma();
    const txns = (res && res.txns) || [];
    if (txns.length) {
      const r = reconcileMonth({
        month: thisMonth(), txns,
        recurring_flows: state.recurring_flows, bonuses: state.bonuses,
        category_rules: state.category_rules,
        budgets: (state.settings && state.settings.forecast_budgets) || {},
        excluded: buildExcludedSet(state.categories),
        projectKeys: new Set(state.project_item_txns.map((l) => l.emma_txn_id)),
      });
      const gen = r.expense.find((g) => g.name === GENERAL);
      actual = gen ? gen.actual : 0;
    }
  } catch (e) { /* feed unavailable → budget-only tile */ }

  const d = new Date();
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const expected = budget * (d.getDate() / dim);      // straight-line pace to date
  const st = actual == null ? "good"
    : budget > 0 && actual > budget ? "bad"
    : budget > 0 && actual > expected ? "warn" : "good";
  const detail = actual == null ? (budget ? `budget ${gbp(budget)}` : "syncing…")
    : !budget ? "no budget set"
    : actual > budget ? `${gbp(actual - budget)} over budget`
    : `${gbp(budget - actual)} left`;
  return { actual, budget, state: st, detail };
}

export async function publishToLifeOS() {
  try {
    const hid = await resolveHousehold();
    if (!hid) return;
    const fc = currentForecast();
    const m = fc.months && fc.months[0];
    if (!m) return;

    const spend = await spendVsBudget();

    const rows = [
      {
        // "This month" is a spend-vs-budget progress tile. LifeOS reads `value`
        // as spend-so-far and `trend` as the budget to draw the bar (this tile
        // opts out of the up/down arrow — direction is conveyed by `state`).
        household_id: hid, app: APP, key: "month-net", kind: "metric",
        title: "This month", value: Math.round(spend.actual ?? 0), unit: "gbp",
        trend: spend.budget || null, detail: spend.detail,
        state: spend.state, cta_url: HUB, cta_label: "Forecast", sort_order: 30,
      },
      {
        household_id: hid, app: APP, key: "cash", kind: "metric",
        title: "Projected cash", value: Math.round(m.cash), unit: "gbp",
        detail: `buffer ${gbp(fc.buffer)}`,
        state: m.cash < fc.buffer ? "warn" : "good",
        cta_url: HUB, cta_label: "Forecast", sort_order: 31,
      },
    ];

    await LO.from("signals").upsert(rows, { onConflict: "household_id,app,key" });
  } catch (e) {
    console.warn("LifeOS publish skipped:", e?.message || e);
  }
}
