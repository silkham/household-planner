// ============================================================================
//  reconcile.tests.js — unit tests for current-month reconciliation.
//  Import-free by design: run.sh concatenates js/reconcile.js (imports dropped,
//  `export` stripped) ahead of this file, so reconcileMonth is a global.
//  Runs under node OR osascript (JavaScriptCore) — see tests/run.sh.
// ============================================================================

let PASS = 0, FAIL = 0;
const log = (s) => (typeof console !== "undefined" ? console.log(s) : null);
function ok(cond, name) {
  if (cond) { PASS++; log("  ok   " + name); }
  else { FAIL++; log("  FAIL " + name); }
}
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- fixtures --------------------------------------------------------------
const di = (y, m, d) => y * 10000 + m * 100 + d;
const tx = (name, amount, dateInt, category) => ({ customName: name, amount, dateInt, category });
const MONTH = "2026-08";
const gExp = (res, name) => res.expense.find((g) => g.name === name);
const gInc = (res, name) => res.income.find((g) => g.name === name);
const catOf = (g, name) => g && g.categories.find((c) => c.name === name);

// ---- 1. bill group: expected from flow, actual from txn, landed ------------
{
  const txns = [
    tx("BigBank Mortgage", -1200, di(2026, 8, 3), "Mortgage"),
    tx("Council", -180, di(2026, 8, 5), "Council Tax"),
  ];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [
      { id: "f1", name: "Mortgage", kind: "expense", amount: 1200, emma_match_key: "BigBank Mortgage" },
      { id: "f2", name: "Council tax", kind: "expense", amount: 200, emma_match_key: "Council" },
    ],
    categories: [
      { name: "Mortgage", forecast_group: "Housing" },
      { name: "Council Tax", forecast_group: "Housing" },
    ],
  });
  const g = gExp(res, "Housing");
  ok(!!g, "Housing group built");
  if (g) {
    eq(g.expected, 1400, "Housing expected = sum of flows");
    eq(g.actual, 1380, "Housing actual = sum of txns");
    eq(g.pendingExpected, 0, "both bills landed → nothing pending");
    eq(g.over, false, "actual under expected → not over");
    eq(g.categories.length, 2, "two categories under Housing");
    const c = catOf(g, "Mortgage");
    eq(c.flows[0].landed, true, "mortgage flow landed (txn present)");
    eq(c.txns.length, 1, "mortgage category has its txn");
  }
}

// ---- 2. income group: salary NOT landed → pending --------------------------
{
  const res = reconcileMonth({
    month: MONTH, txns: [],   // nothing has landed yet this month
    recurring_flows: [
      { id: "s1", name: "Lachlan Salary", kind: "income", amount: 3200, emma_match_key: "ASAHI UK LTD, 88005366" },
    ],
    categories: [],
  });
  const g = gInc(res, "Lachlan Salary");
  ok(!!g, "income group built even with no txns");
  if (g) {
    eq(g.expected, 3200, "salary expected");
    eq(g.actual, 0, "salary not landed → actual 0");
    eq(g.pendingExpected, 3200, "unlanded salary is pending");
    eq(g.categories[0].flows[0].landed, false, "flow flagged not landed");
  }
}

// ---- 3. budget group: expected = budget, over when spend exceeds -----------
{
  const txns = [
    tx("Tesco", -300, di(2026, 8, 2), "Food"),
    tx("Deliveroo", -120, di(2026, 8, 4), "Eating out"),
    tx("ASOS", -90, di(2026, 8, 6), "Clothes"),
  ];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [],
    categories: [
      { name: "Food", forecast_group: "General Expenses" },
      { name: "Eating out", forecast_group: "General Expenses" },
      { name: "Clothes", forecast_group: "General Expenses" },
    ],
    budgets: { "General Expenses": 400 },
  });
  const g = gExp(res, "General Expenses");
  ok(!!g, "budget group built");
  if (g) {
    eq(g.isBudget, true, "flagged as budget group");
    eq(g.expected, 400, "expected = the budget, not a flow sum");
    eq(g.actual, 510, "actual = all discretionary spend");
    eq(g.over, true, "spend > budget → over");
    eq(g.categories.length, 3, "folds the three categories in");
  }
}

// ---- 4. excluded (non-counting) categories are skipped ---------------------
{
  const txns = [
    tx("Transfer to savings", -8884, di(2026, 8, 10), "Transfers"),
    tx("Tesco", -50, di(2026, 8, 11), "Food"),
  ];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [],
    categories: [{ name: "Food", forecast_group: "General Expenses" }],
    budgets: { "General Expenses": 400 },
    excluded: new Set(["Transfers", "Excluded"]),
  });
  const g = gExp(res, "General Expenses");
  eq(g.actual, 50, "transfer excluded from spend actual");
  ok(!res.expense.some((x) => x.name === "Transfers"), "no Transfers group created");
}

// ---- 5. category with no forecast_group is its own line --------------------
{
  const txns = [tx("Vet", -240, di(2026, 8, 8), "Pets")];
  const res = reconcileMonth({
    month: MONTH, txns, recurring_flows: [], categories: [],
  });
  const g = gExp(res, "Pets");
  ok(!!g, "ungrouped category becomes its own group line");
  if (g) eq(g.actual, 240, "own-line actual");
}

// ---- 6. only-this-month + only-active flows are considered -----------------
{
  const txns = [
    tx("Gym", -40, di(2026, 7, 15), "Fitness"),  // last month — ignored
    tx("Gym", -40, di(2026, 8, 15), "Fitness"),  // this month
  ];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [
      { id: "old", name: "Old sub", kind: "expense", amount: 99, end_month: "2026-06", emma_match_key: "Old" },
    ],
    categories: [],
  });
  const g = gExp(res, "Fitness");
  eq(g.actual, 40, "only this-month txn counts");
  ok(!res.expense.some((x) => x.name === "Old sub" || x.name === "Old"), "ended flow excluded");
}

// ---- summary ---------------------------------------------------------------
log(`\nreconcile: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { if (typeof process !== "undefined") process.exit(1); throw new Error(`${FAIL} failing`); }
