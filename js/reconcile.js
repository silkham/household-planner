// ============================================================================
//  reconcile.js — current-month reconciliation (pure core).
//  Fuses the FORWARD-looking recurring flows with the BACKWARD-looking Emma feed
//  for the CURRENT month, so overspend / a missing salary is visible mid-month
//  rather than after the fact. `reconcileMonth` is pure & deterministic (see
//  tests/reconcile.tests.js) — the Forecast tab renders whatever it returns.
//
//  Model: groups → categories → transactions.
//   • Bill group (Housing, Salary): expected = the linked recurring flows; each
//     discrete line shows LANDED (a matching txn appeared this month) vs pending.
//   • Budget group (reserved "General Expenses"): one user-set monthly budget,
//     tracked as spent-so-far vs budget. Folds the discretionary categories in.
//  A group is a budget group iff a budget is set for its name.
// ============================================================================

// A transaction's merchant/display key (matches spending.js / recurring.js).
export const txKey = (t) => t.customName || t.merchant || t.counterparty || "Unknown";

// yyyymmdd int → 'YYYY-MM'
function monthOf(dateInt) {
  if (!dateInt) return null;
  const y = Math.floor(dateInt / 10000);
  const m = Math.floor((dateInt % 10000) / 100);
  return `${y}-${String(m).padStart(2, "0")}`;
}

// A recurring flow is active in `month` (inclusive 'YYYY-MM' string compare).
function flowActive(f, month) {
  if (f.start_month && f.start_month > month) return false;
  if (f.end_month && f.end_month < month) return false;
  return true;
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---- the reconciler (pure) -------------------------------------------------
// opts:
//   month           'YYYY-MM' being reconciled
//   txns            Emma feed rows { dateInt, amount(signed), category, customName... }
//   recurring_flows state.recurring_flows (name, kind, amount, emma_match_key, start/end_month)
//   categories      state.categories (name, counts_as_spend, forecast_group)
//   category_rules  state.category_rules (match_key → category) override
//   budgets         settings.forecast_budgets — { "General Expenses": 2500 }
//   excluded        Set of non-counting category names (from buildExcludedSet)
// Returns { income: [groupNode], expense: [groupNode] }, each sorted largest-first.
export function reconcileMonth(opts = {}) {
  const month = opts.month;
  const txns = opts.txns || [];
  const flows = opts.recurring_flows || [];
  const categories = opts.categories || [];
  const budgets = opts.budgets || {};
  const excluded = opts.excluded || new Set();

  const rules = opts.rules instanceof Map
    ? opts.rules
    : new Map((opts.category_rules || []).map((r) => [r.match_key, r.category]));

  // category name (lower) → managed row (for forecast_group lookup)
  const catMap = new Map();
  for (const c of categories) catMap.set(String(c.name).toLowerCase(), c);

  const effCat = (t) => rules.get(txKey(t)) || t.category || "Uncategorised";
  const groupOf = (catName) => {
    const row = catMap.get(String(catName).toLowerCase());
    return (row && row.forecast_group) ? row.forecast_group : catName;
  };
  const budgetFor = (groupName) =>
    (budgets && budgets[groupName] != null) ? Number(budgets[groupName]) : null;

  // Most-recent effective category per merchant across the WHOLE feed, so a flow
  // can be grouped even in a month where it hasn't landed yet.
  const merchantCat = new Map();
  const sorted = txns.slice().sort((a, b) => (a.dateInt || 0) - (b.dateInt || 0));
  for (const t of sorted) merchantCat.set(txKey(t), effCat(t)); // last write wins

  // A flow's Emma category (via its matched merchant), else its own name.
  const flowCatOf = (f) =>
    (f.emma_match_key && merchantCat.get(f.emma_match_key)) || f.name;

  // This month's txns, split by direction, skipping non-counting categories.
  const monthTxns = txns.filter((t) => t.dateInt && monthOf(t.dateInt) === month
    && !excluded.has(effCat(t)));
  const landedKeys = new Set(monthTxns.map(txKey));
  const flowLanded = (f) =>
    f.emma_match_key ? landedKeys.has(f.emma_match_key) : null;

  // Build one side (income or expense).
  function buildSide(dir) {
    const wantExpense = dir === "expense";
    const groups = new Map(); // groupName → node

    const group = (name) => {
      if (!groups.has(name)) {
        const budget = budgetFor(name);
        groups.set(name, {
          name, kind: dir, isBudget: budget != null, budget,
          expected: 0, actual: 0, over: false, pendingExpected: 0,
          _cats: new Map(),
        });
      }
      return groups.get(name);
    };
    const cat = (g, name) => {
      if (!g._cats.has(name))
        g._cats.set(name, { name, expected: 0, actual: 0, over: false, flows: [], txns: [] });
      return g._cats.get(name);
    };

    // actuals — this month's transactions
    for (const t of monthTxns) {
      const isExpense = t.amount < 0;
      if (isExpense !== wantExpense) continue;
      const cName = effCat(t);
      const g = group(groupOf(cName));
      const c = cat(g, cName);
      const mag = round2(Math.abs(t.amount));
      c.actual = round2(c.actual + mag);
      c.txns.push(t);
    }

    // expected — active recurring flows of this direction
    for (const f of flows) {
      if ((f.kind === "expense") !== wantExpense) continue;
      if (!flowActive(f, month)) continue;
      const cName = flowCatOf(f);
      const g = group(groupOf(cName));
      const amt = round2(Number(f.amount) || 0);
      const landed = flowLanded(f);
      if (!g.isBudget) {           // budget groups take expected from the budget, not flows
        const c = cat(g, cName);
        c.expected = round2(c.expected + amt);
        c.flows.push({ id: f.id, name: f.name, amount: amt, landed });
      }
      if (landed === false) g.pendingExpected = round2(g.pendingExpected + amt);
    }

    // roll up
    const out = [];
    for (const g of groups.values()) {
      const cats = [...g._cats.values()];
      const catExpected = cats.reduce((s, c) => s + c.expected, 0);
      g.expected = g.isBudget ? Number(g.budget) || 0 : round2(catExpected);
      g.actual = round2(cats.reduce((s, c) => s + c.actual, 0));
      g.over = wantExpense && g.expected > 0 && g.actual > g.expected + 0.005;
      cats.forEach((c) => { c.over = wantExpense && c.expected > 0 && c.actual > c.expected + 0.005; });
      // stable, useful ordering: transactions newest-first within a category
      cats.forEach((c) => c.txns.sort((a, b) => (b.dateInt || 0) - (a.dateInt || 0)));
      cats.sort((a, b) => (b.actual || b.expected) - (a.actual || a.expected));
      g.categories = cats;
      delete g._cats;
      out.push(g);
    }
    out.sort((a, b) => Math.max(b.actual, b.expected) - Math.max(a.actual, a.expected));
    return out;
  }

  return { income: buildSide("income"), expense: buildSide("expense") };
}
