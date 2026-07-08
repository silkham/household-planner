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
const lineOf = (g, name) => g && g.lines.find((l) => l.name === name);
const catOf = (g, name) => g && g.categories.find((c) => c.name === name);

// ---- 1. income group: one salary in (green), one not (red) -----------------
{
  const txns = [tx("ASAHI UK LTD, 88005366", 2900, di(2026, 8, 28), "Salary")];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [
      { id: "l", name: "Lachlan Salary", kind: "income", amount: 2900, category: "Salary", emma_match_key: "ASAHI UK LTD, 88005366" },
      { id: "c", name: "Christine Salary", kind: "income", amount: 3200, category: "Salary", emma_match_key: "MACFARLANES LLP, ." },
    ],
  });
  const g = gInc(res, "Income");
  ok(!!g, "single Income group built");
  if (g) {
    eq(g.expected, 6100, "Income expected = both salaries");
    eq(g.actual, 2900, "Income actual = the salary that landed");
    eq(g.pendingExpected, 3200, "Christine's salary is still pending");
    eq(g.lines.length, 2, "two salary lines");
    eq(lineOf(g, "Lachlan Salary").received, true, "Lachlan received (green)");
    eq(lineOf(g, "Christine Salary").received, false, "Christine not received (red)");
    eq(lineOf(g, "Lachlan Salary").actual, 2900, "received line shows actual");
  }
}

// ---- 2. expense bills grouped by flow category, paid vs due ----------------
{
  const txns = [tx("BigBank Mortgage", -1200, di(2026, 8, 3), "Mortgage")];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [
      { id: "m", name: "Mortgage", kind: "expense", amount: 1200, category: "Housing", emma_match_key: "BigBank Mortgage" },
      { id: "ct", name: "Council tax", kind: "expense", amount: 200, category: "Housing", emma_match_key: "Council" },
      { id: "car", name: "PCP", kind: "expense", amount: 350, category: "Vehicle", emma_match_key: "VW Finance" },
    ],
  });
  const h = gExp(res, "Housing");
  ok(!!h, "Housing group built from flow.category");
  if (h) {
    eq(h.expected, 1400, "Housing expected = both bills");
    eq(h.actual, 1200, "Housing actual = mortgage paid");
    eq(h.pendingExpected, 200, "council tax still due");
    eq(lineOf(h, "Mortgage").received, true, "mortgage paid");
    eq(lineOf(h, "Council tax").received, false, "council tax due");
  }
  ok(!!gExp(res, "Vehicle"), "separate Vehicle group for the PCP");
}

// ---- 3. General = counting outflows NOT matched to a known bill ------------
{
  const txns = [
    tx("BigBank Mortgage", -1200, di(2026, 8, 3), "Mortgage"),   // known bill → NOT general
    tx("Deliveroo", -40, di(2026, 8, 4), "Eating out"),
    tx("Amazon", -60, di(2026, 8, 6), "Shopping"),
    tx("Amazon", -25, di(2026, 8, 9), "Shopping"),
  ];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [
      { id: "m", name: "Mortgage", kind: "expense", amount: 1200, category: "Housing", emma_match_key: "BigBank Mortgage" },
    ],
    // rules give the breakdown its labels; unmapped merchants roll into Uncategorised
    category_rules: [{ match_key: "Amazon", category: "Amazon" }],
    budgets: { "General Expenses": 400 },
  });
  const g = gExp(res, "General Expenses");
  ok(!!g, "General Expenses group built");
  if (g) {
    eq(g.type, "budget", "General is the budget group");
    eq(g.expected, 400, "expected = the budget");
    eq(g.actual, 125, "actual = discretionary spend only (mortgage excluded)");
    eq(g.over, false, "125 < 400 → not over");
    eq(catOf(g, "Amazon").actual, 85, "Amazon (ruled) rolled into its category");
    eq(catOf(g, "Amazon").txns.length, 2, "category keeps its transactions");
    eq(catOf(g, "Uncategorised").actual, 40, "unmapped Deliveroo → Uncategorised, not Emma's 'Eating out'");
  }
  ok(res.expense[res.expense.length - 1].name === "General Expenses", "General sits last");
}

// ---- 4. General over budget flags red --------------------------------------
{
  const res = reconcileMonth({
    month: MONTH,
    txns: [tx("Tesco", -520, di(2026, 8, 2), "Food")],
    recurring_flows: [],
    budgets: { "General Expenses": 400 },
  });
  eq(gExp(res, "General Expenses").over, true, "spend > budget → over");
}

// ---- 5. excluded (non-counting) categories skipped everywhere --------------
{
  const txns = [
    tx("Transfer", -8884, di(2026, 8, 10), "Transfers"),
    tx("Tesco", -50, di(2026, 8, 11), "Food"),
  ];
  const res = reconcileMonth({
    month: MONTH, txns, recurring_flows: [],
    budgets: { "General Expenses": 400 },
    excluded: new Set(["Transfers", "Excluded"]),
  });
  eq(gExp(res, "General Expenses").actual, 50, "transfer excluded from General");
}

// ---- 6. flow without a match key → never received (red) --------------------
{
  const res = reconcileMonth({
    month: MONTH, txns: [], recurring_flows: [
      { id: "x", name: "Gym", kind: "expense", amount: 40, category: "Other" },
    ],
  });
  eq(lineOf(gExp(res, "Other"), "Gym").received, false, "unlinked flow shows due");
}

// ---- 7. only this-month + active flows/txns are considered -----------------
{
  const txns = [
    tx("Netflix", -11, di(2026, 7, 15), "Subscriptions"),  // last month — ignored
    tx("Netflix", -11, di(2026, 8, 15), "Subscriptions"),  // this month
  ];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [
      { id: "old", name: "Old sub", kind: "expense", amount: 99, category: "Other", end_month: "2026-06", emma_match_key: "Old" },
    ],
    budgets: { "General Expenses": 100 },
  });
  eq(gExp(res, "General Expenses").actual, 11, "only this-month txn counts in General");
  ok(!res.expense.some((g) => g.name === "Other"), "ended flow excluded (no Other group)");
}

// ---- 8. a rule matches ANY identity field (cross-month name variance) ------
{
  // two "Amazon" txns with DIFFERENT customNames but the same merchant
  const txns = [
    { customName: "Amazon", merchant: "Amazon", amount: -30, dateInt: di(2026, 8, 3), category: "Shopping" },
    { customName: "AMZNMktplace*A1B2", merchant: "Amazon", amount: -45, dateInt: di(2026, 8, 7), category: "Shopping" },
  ];
  const res = reconcileMonth({
    month: MONTH, txns, recurring_flows: [],
    category_rules: [{ match_key: "Amazon", category: "Amazon" }],  // keyed on merchant name
    budgets: { "General Expenses": 200 },
  });
  const g = gExp(res, "General Expenses");
  eq(catOf(g, "Amazon").actual, 75, "rule keyed on merchant catches both name variants");
  ok(!catOf(g, "Shopping"), "neither variant left under the old Emma category");
}

// ---- 9. a flow matches a txn via its merchant field too --------------------
{
  const txns = [{ customName: "SALARY PYMT REF9", merchant: "ASAHI UK LTD", amount: 2900, dateInt: di(2026, 8, 28), category: "Salary" }];
  const res = reconcileMonth({
    month: MONTH, txns,
    recurring_flows: [{ id: "l", name: "Lachlan Salary", kind: "income", amount: 2900, category: "Salary", emma_match_key: "ASAHI UK LTD" }],
  });
  eq(lineOf(gInc(res, "Income"), "Lachlan Salary").received, true, "flow matched via merchant field");
}

// ---- summary ---------------------------------------------------------------
log(`\nreconcile: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { if (typeof process !== "undefined") process.exit(1); throw new Error(`${FAIL} failing`); }
