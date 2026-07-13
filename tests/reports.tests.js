// ============================================================================
//  reports.tests.js — unit tests for the Reports aggregation core.
//  Import-free by design: run.sh concatenates js/reports.js (imports dropped,
//  `export` stripped) ahead of this file, so reportCategories + annualCost are
//  globals. Runs under node OR osascript (JavaScriptCore) — see tests/run.sh.
// ============================================================================

let PASS = 0, FAIL = 0;
const log = (s) => (typeof console !== "undefined" ? console.log(s) : null);
function ok(cond, name) {
  if (cond) { PASS++; log("  ok   " + name); }
  else { FAIL++; log("  FAIL " + name); }
}
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, name) => ok(Math.abs(a - b) < 0.01, `${name} (got ${a}, want ${b})`);

// ---- fixtures --------------------------------------------------------------
const di = (y, m, d) => y * 10000 + m * 100 + d;
const tx = (name, amount, dateInt, category = "Groceries") =>
  ({ customName: name, amount, dateInt, category });
const find = (rows, cat) => rows.find((r) => r.category === cat);
const END = di(2026, 8, 20);   // feed's newest txn: mid-Aug 2026
// Strict categorisation: an unmapped merchant is "Uncategorised" (Emma's raw
// category is NOT trusted), so real grouping needs category_rules — as in prod.
const RULES = new Map([
  ["Tesco", "Groceries"], ["Aldi", "Groceries"], ["Shell", "Transport"],
  ["New Sub", "Subscriptions"], ["Refund Co", "Groceries"],
]);

// ---- 1. grouping by category + outflows only + ranked desc -----------------
{
  const txns = [
    tx("Tesco", -50, di(2026, 8, 5)),
    tx("Aldi", -30, di(2026, 8, 18)),
    tx("Shell", -70, di(2026, 8, 10)),
    tx("Refund Co", +40, di(2026, 8, 12)),   // inflow → ignored
  ];
  const { rows, grandTotal } = reportCategories(txns, { rules: RULES, monthsBack: 3, endInt: END });
  eq(rows.length, 2, "two categories");
  eq(rows[0].category, "Groceries", "Groceries first (£80 > Transport £70)");
  eq(rows[0].total, 80, "Groceries total = 50+30");
  eq(rows[0].count, 2, "Groceries txn count");
  eq(grandTotal, 150, "grand total = 80+70");
}

// ---- 2. excluded categories skipped ----------------------------------------
{
  const txns = [
    tx("Tesco", -50, di(2026, 8, 5), "Groceries"),
    tx("Bank", -900, di(2026, 8, 6), "Transfers"),   // non-counting
    tx("HMRC", -100, di(2026, 8, 7), "Excluded"),
  ];
  const { rows, grandTotal } = reportCategories(txns, { monthsBack: 3, endInt: END });
  eq(rows.length, 1, "only Groceries counts");
  eq(grandTotal, 50, "transfers/excluded not in grand total");
}

// ---- 3. window vs prior-window delta ---------------------------------------
{
  const txns = [
    tx("Tesco", -100, di(2026, 8, 10), "Groceries"),   // current 3m (Jun-Aug)
    tx("Tesco", -40, di(2026, 4, 10), "Groceries"),    // prior 3m (Mar-May)
    tx("Tesco", -999, di(2025, 1, 10), "Groceries"),   // outside both → ignored
  ];
  const { rows } = reportCategories(txns, { rules: RULES, monthsBack: 3, endInt: END });
  const g = find(rows, "Groceries");
  eq(g.total, 100, "current window total");
  eq(g.prev, 40, "prior window total");
  eq(g.delta, 60, "delta = 100-40");
  near(g.deltaPct, 1.5, "deltaPct = 60/40");
}

// ---- 4. deltaPct null / prev 0 when nothing prior --------------------------
{
  const txns = [tx("New Sub", -20, di(2026, 8, 10))];
  const { rows } = reportCategories(txns, { rules: RULES, monthsBack: 3, endInt: END });
  const s = find(rows, "Subscriptions");
  eq(s.prev, 0, "no prior spend");
  eq(s.deltaPct, null, "deltaPct null when prev 0");
}

// ---- 5. byMonth + monthlyTotals + avg over window --------------------------
{
  const txns = [
    tx("Tesco", -60, di(2026, 8, 10)),
    tx("Tesco", -30, di(2026, 7, 10)),
    tx("Shell", -30, di(2026, 8, 12)),
  ];
  const { rows, months, monthlyTotals } = reportCategories(txns, { rules: RULES, monthsBack: 3, endInt: END });
  eq(months.length, 3, "3-month window (Jun,Jul,Aug)");
  const g = find(rows, "Groceries");
  const augOrd = 2026 * 12 + 7, julOrd = 2026 * 12 + 6;
  eq(g.byMonth[augOrd], 60, "Groceries Aug bucket");
  eq(g.byMonth[julOrd], 30, "Groceries Jul bucket");
  near(g.avg, 90 / 3, "avg = total / window months");
  eq(monthlyTotals[augOrd], 90, "monthlyTotals Aug = 60+30");
  eq(monthlyTotals[julOrd], 30, "monthlyTotals Jul");
}

// ---- 6. multi-field rule override beats Emma category ----------------------
{
  const rules = new Map([["Amazon", "Shopping"]]);
  const txns = [
    // Emma category says Groceries, but a rule on Merchant re-buckets to Shopping
    { customName: "AMZN Mktp 8H2", merchant: "Amazon", amount: -25, dateInt: di(2026, 8, 9), category: "Groceries" },
  ];
  const { rows } = reportCategories(txns, { rules, monthsBack: 3, endInt: END });
  eq(rows[0].category, "Shopping", "rule on Merchant field wins");
}

// ---- 7. Emma 'Transfer' passthrough is treated as non-counting -------------
{
  const txns = [
    { customName: "Move", amount: -500, dateInt: di(2026, 8, 9), category: "Transfer" }, // singular
    tx("Tesco", -20, di(2026, 8, 9), "Groceries"),
  ];
  const { grandTotal } = reportCategories(txns, { monthsBack: 3, endInt: END });
  eq(grandTotal, 20, "Emma 'Transfer' passes through to non-counting Transfers");
}

// ---- 8. all-history (monthsBack null): no window, avg over distinct months --
{
  const txns = [
    tx("Tesco", -100, di(2026, 8, 10)),
    tx("Tesco", -50, di(2026, 3, 10)),
    tx("Tesco", -30, di(2025, 12, 10)),
  ];
  const { rows, months } = reportCategories(txns, { rules: RULES, monthsBack: null, endInt: END });
  eq(months.length, 0, "no month axis when all-history");
  const g = find(rows, "Groceries");
  eq(g.total, 180, "all txns counted");
  eq(g.prev, 0, "no prior comparison");
  near(g.avg, 180 / 3, "avg over 3 distinct months");
}

// ---- 9. annualCost cadences ------------------------------------------------
{
  near(annualCost({ amount: 10, frequency: "monthly", interval_n: 1 }), 120, "monthly ×12");
  near(annualCost({ amount: 10, frequency: "monthly", interval_n: 2 }), 60, "every-2-months ×6");
  near(annualCost({ amount: 5, frequency: "weekly", interval_n: 1 }), 260, "weekly ×52");
  near(annualCost({ amount: 5, frequency: "weekly", interval_n: 2 }), 130, "fortnightly ×26");
  near(annualCost({ amount: 120, frequency: "yearly", interval_n: 1 }), 120, "yearly ×1");
  near(annualCost({ amount: 240, frequency: "yearly", interval_n: 2 }), 120, "every-2-years ÷2");
  near(annualCost({ amount: 30 }), 360, "legacy (no freq) = monthly ×12");
}

// ---- summary ---------------------------------------------------------------
log(`\nreports: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { if (typeof process !== "undefined") process.exit(1); else throw new Error(`${FAIL} failed`); }
