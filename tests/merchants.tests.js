// ============================================================================
//  merchants.tests.js — unit tests for the Merchants ranking core.
//  Import-free by design: run.sh concatenates js/merchants.js (imports dropped,
//  `export` stripped) ahead of this file, so rankMerchants is a global.
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
const tx = (name, amount, dateInt, category = "Groceries") =>
  ({ customName: name, amount, dateInt, category });
const find = (rows, key) => rows.find((r) => r.key === key);
const END = di(2026, 8, 20);   // feed's newest txn: mid-Aug 2026

// ---- 1. ranking + spend = outflows only ------------------------------------
{
  const txns = [
    tx("Tesco", -50, di(2026, 8, 5)),
    tx("Tesco", -30, di(2026, 8, 18)),
    tx("Shell", -70, di(2026, 8, 10), "Transport"),
    tx("Refund Co", +40, di(2026, 8, 12)),   // inflow → ignored
  ];
  const { rows } = rankMerchants(txns, { monthsBack: 3, endInt: END });
  eq(rows.length, 2, "inflow excluded, two merchants ranked");
  eq(rows[0].key, "Tesco", "ranked by spend desc (Tesco £80 first)");
  eq(rows[0].total, 80, "Tesco total summed");
  eq(rows[0].count, 2, "Tesco txn count");
  eq(find(rows, "Refund Co"), undefined, "inflow-only merchant not ranked");
}

// ---- 2. excluded categories don't count ------------------------------------
{
  const txns = [
    tx("Tesco", -50, di(2026, 8, 5)),
    tx("Card Payment", -500, di(2026, 8, 6), "Transfers"),
    tx("Fee", -3, di(2026, 8, 7), "Excluded"),
  ];
  const { rows } = rankMerchants(txns, { monthsBack: 3, endInt: END });
  eq(rows.length, 1, "Transfers + Excluded skipped");
  eq(rows[0].key, "Tesco", "only counting merchant survives");
}

// ---- 3. rules override the category (multi-field) --------------------------
{
  const rules = new Map([["AMZN Mktp", "Shopping"]]);
  const txns = [
    { customName: "AMZN Mktp", merchant: "Amazon", amount: -25, dateInt: di(2026, 8, 3), category: "Uncategorised" },
  ];
  const { rows } = rankMerchants(txns, { rules, monthsBack: 3, endInt: END });
  eq(rows[0].category, "Shopping", "rule overrides Emma category");
  // and a rule mapping to a non-counting bucket removes it from spend
  const off = rankMerchants(txns, { rules: new Map([["AMZN Mktp", "Transfers"]]), monthsBack: 3, endInt: END });
  eq(off.rows.length, 0, "rule → Transfers drops merchant from spend");
}

// ---- 4. window + prior-period change ---------------------------------------
{
  // Rising Ltd: £100 in the current 3m window, £40 in the prior 3m window.
  const txns = [
    tx("Rising", -100, di(2026, 8, 1)),   // current window (Jun–Aug)
    tx("Rising", -40, di(2026, 4, 1)),    // prior window   (Mar–May)
  ];
  const { rows } = rankMerchants(txns, { monthsBack: 3, endInt: END });
  const r = find(rows, "Rising");
  eq(r.total, 100, "current-window total");
  eq(r.prev, 40, "prior-window total");
  eq(r.delta, 60, "delta = current − prior");
  ok(Math.abs(r.deltaPct - 1.5) < 1e-9, "deltaPct = 150%");
}

// ---- 5. a brand-new merchant has no prior (deltaPct null) -------------------
{
  const txns = [tx("Newco", -20, di(2026, 8, 2))];
  const { rows } = rankMerchants(txns, { monthsBack: 3, endInt: END });
  const r = find(rows, "Newco");
  eq(r.prev, 0, "no prior-window spend");
  eq(r.deltaPct, null, "deltaPct null when prior is zero");
}

// ---- 6. window boundary: outside the current window is excluded -------------
{
  const txns = [
    tx("Old", -99, di(2026, 1, 15)),   // Jan 2026, far outside a 3m Aug window
    tx("New", -10, di(2026, 8, 15)),
  ];
  const { rows } = rankMerchants(txns, { monthsBack: 3, endInt: END });
  eq(find(rows, "Old"), undefined, "txn before the window excluded");
  eq(rows.length, 1, "only in-window merchant ranked");
}

// ---- 7. monthsBack=null → all history, no comparison ------------------------
{
  const txns = [
    tx("Old", -99, di(2025, 1, 15)),
    tx("New", -10, di(2026, 8, 15)),
  ];
  const { rows, months } = rankMerchants(txns, { monthsBack: null, endInt: END });
  eq(rows.length, 2, "all history included when monthsBack null");
  eq(months.length, 0, "no window months when all-history");
  eq(find(rows, "Old").prev, 0, "no prior comparison in all-history mode");
}

// ---- 8. byMonth series keyed by month ordinal ------------------------------
{
  const txns = [
    tx("Tesco", -50, di(2026, 8, 5)),
    tx("Tesco", -30, di(2026, 7, 5)),
  ];
  const { rows } = rankMerchants(txns, { monthsBack: 3, endInt: END });
  const r = find(rows, "Tesco");
  const augOrd = 2026 * 12 + 7;   // Aug = month index 7
  const julOrd = 2026 * 12 + 6;
  eq(r.byMonth[augOrd], 50, "Aug bucket");
  eq(r.byMonth[julOrd], 30, "Jul bucket");
}

// ---- summary ---------------------------------------------------------------
log(`\nmerchants: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0 && typeof process !== "undefined") process.exit(1);
