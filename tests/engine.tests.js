// ============================================================================
//  engine.tests.js — unit tests for the cashflow engine.
//  Import-free by design: run.sh concatenates js/engine.js (with `export`
//  stripped) ahead of this file, so engine functions are in scope as globals.
//  Runs under node OR osascript (JavaScriptCore) — see tests/run.sh.
// ============================================================================

let PASS = 0, FAIL = 0;
const log = (s) => (typeof console !== "undefined" ? console.log(s) : null);

function ok(cond, name) {
  if (cond) { PASS++; log("  ok   " + name); }
  else { FAIL++; log("  FAIL " + name); }
}
const approx = (a, b, name, tol = 1e-6) => ok(Math.abs(a - b) < tol, `${name} (got ${a}, want ${b})`);
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (arr, v, name) => ok(arr.indexOf(v) !== -1, name);
const not = (arr, v, name) => ok(arr.indexOf(v) === -1, name);

// ---- month helpers ---------------------------------------------------------
eq(addMonths("2026-01", 3), "2026-04", "addMonths within year");
eq(addMonths("2026-11", 3), "2027-02", "addMonths across year");
eq(monthOfYear("2026-04"), 4, "monthOfYear");
eq(fromIndex(monthIndex("2027-09")), "2027-09", "monthIndex/fromIndex round-trip");

// ---- amortisation ----------------------------------------------------------
approx(monthlyPayment({ principal: 1200, apr: 0, term_months: 12 }), 100, "0% APR → principal/term");
// £10k over 12mo at 12% APR (1%/mo) → known amortised payment
approx(monthlyPayment({ principal: 10000, apr: 0.12, term_months: 12 }), 888.4878867834164, "amortised payment", 1e-6);
eq(monthlyPayment({ principal: 0, apr: 0.05, term_months: 12 }), 0, "zero principal → 0");

// ---- confidence filter -----------------------------------------------------
eq(confidencePasses("speculative", "conservative"), false, "conservative drops speculative");
eq(confidencePasses("confirmed", "conservative"), true, "conservative keeps confirmed");
eq(confidencePasses("likely", "realistic"), true, "realistic keeps likely");
eq(confidencePasses("speculative", "realistic"), false, "realistic drops speculative");
eq(confidencePasses("speculative", "optimistic"), true, "optimistic keeps all");

// ---- projectCostInMonth ----------------------------------------------------
const proj = { estimated_cost: 900, duration_months: 3, target_start_month: "2026-01", status: "Planned" };
approx(projectCostInMonth(proj, monthIndex("2026-01")), 300, "even split month 1");
approx(projectCostInMonth(proj, monthIndex("2026-03")), 300, "even split last month");
eq(projectCostInMonth(proj, monthIndex("2026-04")), 0, "outside window → 0");
const projSpread = { estimated_cost: 900, duration_months: 3, target_start_month: "2026-01", cost_spread: { "2026-01": 800, "2026-02": 100 } };
approx(projectCostInMonth(projSpread, monthIndex("2026-01")), 800, "cost_spread override");
approx(projectCostInMonth(projSpread, monthIndex("2026-02")), 100, "cost_spread override 2");
eq(projectCostInMonth(projSpread, monthIndex("2026-03")), 0, "cost_spread month absent → 0");
eq(projectCostInMonth({ estimated_cost: 500, target_start_month: null }, monthIndex("2026-01")), 0, "null start → 0");
// actuals already hit shrink the remaining plan (they're already in opening cash)
const projAct = { ...proj, actual_cost: 300 };  // a third of £900 spent
approx(projectCostInMonth(projAct, monthIndex("2026-01")), 200, "actual hit shrinks plan (300/mo → 200)");
approx(projectCostInMonth(projAct, monthIndex("2026-03")), 200, "actual scaling applies every month");
eq(projectCostInMonth({ ...proj, actual_cost: 900 }, monthIndex("2026-01")), 0, "fully spent → nothing left to forecast");
eq(projectCostInMonth({ ...proj, actual_cost: 1200 }, monthIndex("2026-01")), 0, "overspent → clamps to 0, not negative");
approx(projectCostInMonth({ ...projSpread, actual_cost: 450 }, monthIndex("2026-01")), 400, "actuals scale a cost_spread too (800×0.5)");

// ---- effectiveAmount: uplift + salary_change -------------------------------
const flow = { id: "f1", amount: 1000, start_month: "2026-01", annual_uplift_pct: 0.03, uplift_month: 4 };
approx(effectiveAmount(flow, monthIndex("2026-03"), [], "realistic"), 1000, "before uplift month → base");
approx(effectiveAmount(flow, monthIndex("2026-04"), [], "realistic"), 1030, "one uplift applied");
approx(effectiveAmount(flow, monthIndex("2027-04"), [], "realistic"), 1000 * 1.03 * 1.03, "two uplifts compound");
const changes = [{ flow_id: "f1", effective_month: "2026-06", new_amount: 2500, confidence: "speculative" }];
approx(effectiveAmount(flow, monthIndex("2026-07"), changes, "optimistic"), 2500, "salary_change overrides (optimistic)");
approx(effectiveAmount(flow, monthIndex("2026-07"), changes, "realistic"), 1030, "speculative change filtered (realistic keeps uplift)");
// latest applicable change wins
const two = [
  { flow_id: "f1", effective_month: "2026-06", new_amount: 2500, confidence: "confirmed" },
  { flow_id: "f1", effective_month: "2026-09", new_amount: 3000, confidence: "confirmed" },
];
approx(effectiveAmount(flow, monthIndex("2026-10"), two, "realistic"), 3000, "latest change wins");
approx(effectiveAmount(flow, monthIndex("2026-07"), two, "realistic"), 2500, "earlier change before later one");

// ---- bonusHitsMonth --------------------------------------------------------
eq(bonusHitsMonth({ expected_month: "2026-03", recurs_annually: false }, monthIndex("2026-03")), true, "one-off exact");
eq(bonusHitsMonth({ expected_month: "2026-03", recurs_annually: false }, monthIndex("2027-03")), false, "one-off not next year");
eq(bonusHitsMonth({ expected_month: "2026-03", recurs_annually: true }, monthIndex("2028-03")), true, "annual matches later year");
eq(bonusHitsMonth({ expected_month: "2026-03", recurs_annually: true }, monthIndex("2026-04")), false, "annual wrong month");
eq(bonusHitsMonth({ expected_month: "2026-03", recurs_annually: true }, monthIndex("2025-03")), false, "annual before first year");

// ---- computeForecast: opening cash + accumulation --------------------------
const base = {
  settings: { horizon_months: 3, cash_buffer: 1000, forecast_confidence: "realistic" },
  startMonth: "2026-01",
  accounts: [
    { balance: 5000, available_for_projects: true },
    { balance: 9999, available_for_projects: false }, // ring-fenced, ignored
  ],
  recurring_flows: [
    { id: "inc", kind: "income", amount: 2000, start_month: "2026-01" },
    { id: "exp", kind: "expense", amount: 500, start_month: "2026-01" },
  ],
};
const f1 = computeForecast(base);
eq(f1.opening_cash, 5000, "opening = available accounts only");
eq(f1.months.length, 3, "horizon_months months produced");
approx(f1.months[0].net, 1500, "month0 net");
approx(f1.months[0].cash, 6500, "month0 cash");
approx(f1.months[2].cash, 9500, "month2 cash accumulates");

// ---- project spend feeds expenses ------------------------------------------
const withProj = { ...base, projects: [{ id: "p", name: "Shed", estimated_cost: 900, duration_months: 3, target_start_month: "2026-01", status: "Planned" }] };
const f2 = computeForecast(withProj);
approx(f2.months[0].project_spend, 300, "project_spend surfaced");
approx(f2.months[0].expenses, 800, "project folds into expenses");
approx(f2.months[0].net, 1200, "net reflects project spend");
// Idea/On Hold/Done excluded
const idle = computeForecast({ ...base, projects: [{ id: "p", name: "X", estimated_cost: 900, duration_months: 3, target_start_month: "2026-01", status: "Idea" }] });
eq(idle.months[0].project_spend, 0, "Idea status excluded from spend");

// ---- life events: SIGN CONVENTION (− = worse) ------------------------------
// nursery: expense_change, monthly_impact −300 → expenses +300, net −300
const nursery = computeForecast({
  settings: { horizon_months: 2, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 1000, available_for_projects: true }],
  life_events: [{ event_type: "expense_change", monthly_impact: -300, effective_month: "2026-01", name: "Nursery" }],
});
approx(nursery.months[0].expenses, 300, "−impact expense event → +300 expense");
approx(nursery.months[0].net, -300, "net drops by 300");
// mat leave: income_change, monthly_impact −1400 → income −1400
const matLeave = computeForecast({
  settings: { horizon_months: 3, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 0, available_for_projects: true }],
  recurring_flows: [{ id: "s", kind: "income", amount: 2000, start_month: "2026-01" }],
  life_events: [{ event_type: "income_change", monthly_impact: -1400, effective_month: "2026-02", duration_months: 1, name: "Mat leave" }],
});
approx(matLeave.months[0].income, 2000, "before mat leave: full salary");
approx(matLeave.months[1].income, 600, "during mat leave: salary − 1400");
approx(matLeave.months[2].income, 2000, "after 1-month duration: back to full");
// ---- life events LINKED to a salary flow (linked_flow_id) ------------------
// mat leave linked to Christine's salary: statutory drop of −1400 for 2 months.
// Effect folds through the flow, and the event is NOT double-counted as a
// separate net delta. linkedFlowDelta signs by the flow's kind.
const linkedMat = computeForecast({
  settings: { horizon_months: 3, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 0, available_for_projects: true }],
  recurring_flows: [{ id: "chris", kind: "income", amount: 3000, start_month: "2026-01" }],
  life_events: [{ event_type: "income_change", monthly_impact: -1400, effective_month: "2026-02",
                  duration_months: 2, linked_flow_id: "chris", name: "Mat leave 2" }],
});
approx(linkedMat.months[0].income, 3000, "linked mat leave: full salary before");
approx(linkedMat.months[1].income, 1600, "linked mat leave: salary drops via flow (not doubled)");
approx(linkedMat.months[2].income, 1600, "linked mat leave: still reduced in month 2");
eq(linkedMat.months[1].breakdown.income.length, 1, "linked event does not add a second income line");
// linkedFlowDelta directly: income flow keeps sign, expense flow flips it
approx(linkedFlowDelta({ id: "chris", kind: "income" }, monthIndex("2026-02"),
  [{ event_type: "income_change", monthly_impact: -1400, effective_month: "2026-02", duration_months: 2, linked_flow_id: "chris" }]),
  -1400, "linkedFlowDelta income keeps sign");
approx(linkedFlowDelta({ id: "m", kind: "expense" }, monthIndex("2026-02"),
  [{ event_type: "expense_change", monthly_impact: -200, effective_month: "2026-02", duration_months: 2, linked_flow_id: "m" }]),
  200, "linkedFlowDelta expense flips sign (−impact → +expense)");
eq(linkedFlowDelta({ id: "chris", kind: "income" }, monthIndex("2026-01"),
  [{ event_type: "income_change", monthly_impact: -1400, effective_month: "2026-02", duration_months: 2, linked_flow_id: "chris" }]),
  0, "linkedFlowDelta 0 before the event starts");

// lump sum only in its month
const lump = computeForecast({
  settings: { horizon_months: 2, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 0, available_for_projects: true }],
  life_events: [{ event_type: "lump_sum", monthly_impact: 5000, effective_month: "2026-01", name: "Gift" }],
});
approx(lump.months[0].income, 5000, "lump sum in effective month");
approx(lump.months[1].income, 0, "lump sum not repeated");

// ---- flags -----------------------------------------------------------------
const dip = computeForecast({
  settings: { horizon_months: 2, cash_buffer: 2000 }, startMonth: "2026-01",
  accounts: [{ balance: 1000, available_for_projects: true }],
  recurring_flows: [{ id: "e", kind: "expense", amount: 1500, start_month: "2026-01" }],
});
has(dip.months[0].flags, "below_buffer", "below_buffer flagged (cash −500 < 2000)");
has(dip.months[0].flags, "negative", "negative flagged (cash −500)");

// ---- scenario filter on bonuses --------------------------------------------
const specBonus = {
  settings: { horizon_months: 1, cash_buffer: 0 }, startMonth: "2026-03",
  accounts: [{ balance: 0, available_for_projects: true }],
  bonuses: [{ name: "B", expected_month: "2026-03", net_amount: 4000, confidence: "speculative" }],
};
approx(computeForecast({ ...specBonus, scenario: "realistic" }).months[0].income, 0, "speculative bonus excluded (realistic)");
approx(computeForecast({ ...specBonus, scenario: "optimistic" }).months[0].income, 4000, "speculative bonus included (optimistic)");

// ---- financing: active draws + pays, considering does not ------------------
const fin = (status) => computeForecast({
  settings: { horizon_months: 2, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 0, available_for_projects: true }],
  financing_options: [{ name: "Loan", status, principal: 1200, apr: 0, term_months: 12, start_month: "2026-01" }],
});
approx(fin("active").months[0].income, 1200, "active loan draws principal in start month");
approx(fin("active").months[0].expenses, 100, "active loan pays 100/mo (0% over 12)");
eq(fin("considering").months[0].income, 0, "considering loan does not draw");
eq(fin("considering").months[0].expenses, 0, "considering loan does not pay");

// ---- project_spike flag ----------------------------------------------------
const spike = computeForecast({
  settings: { horizon_months: 2, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 20000, available_for_projects: true }],
  projects: [{ id: "k", name: "Kitchen", estimated_cost: 10000, duration_months: 1, target_start_month: "2026-01", status: "Quoted" }],
});
has(spike.months[0].flags, "project_spike", "project_spike when start-month drop > 50% of cost");

// ---- projectAffordability --------------------------------------------------
const affForecast = computeForecast({
  settings: { horizon_months: 3, cash_buffer: 2000 }, startMonth: "2026-01",
  accounts: [{ balance: 3000, available_for_projects: true }],
  recurring_flows: [{ id: "e", kind: "expense", amount: 1000, start_month: "2026-01" }],
  projects: [{ id: "a", name: "A", estimated_cost: 3000, duration_months: 1, target_start_month: "2026-03", status: "Planned" }],
});
// cash: m0 2000(buffer), m1 1000(below), m2 1000−3000=−2000(neg). Project active m2 → red.
eq(projectAffordability({ id: "a", name: "A", estimated_cost: 3000, duration_months: 1, target_start_month: "2026-03", status: "Planned" }, affForecast), "red", "affordability red when active month negative");
// a cheap project active only in a healthy month → green
const green = computeForecast({
  settings: { horizon_months: 3, cash_buffer: 500 }, startMonth: "2026-01",
  accounts: [{ balance: 5000, available_for_projects: true }],
  projects: [{ id: "g", name: "G", estimated_cost: 100, duration_months: 1, target_start_month: "2026-01", status: "Planned" }],
});
eq(projectAffordability({ id: "g", name: "G", estimated_cost: 100, duration_months: 1, target_start_month: "2026-01", status: "Planned" }, green), "green", "affordability green when comfortable");

// ---- General Expenses budget is a flat monthly forecast expense ------------
const gb = computeForecast({
  settings: { horizon_months: 2, cash_buffer: 0, forecast_budgets: { "General Expenses": 1500 } },
  startMonth: "2026-01",
  accounts: [{ balance: 10000, available_for_projects: true }],
});
eq(gb.months[0].expenses, 1500, "general budget counts as a monthly expense");
eq(gb.months[1].cash, 10000 - 1500 * 2, "general budget compounds down the cash line");
has(gb.months[0].breakdown.expenses.map((x) => x.name), "General expenses", "budget shows in the breakdown");

// ---- recurring-flow frequencies (flowMonthFactor + spread) -----------------
// legacy / monthly-1 flows: factor 1 every active month (backward-compatible)
approx(flowMonthFactor({ start_month: "2026-01" }, monthIndex("2026-05")), 1, "no frequency → monthly/1");
approx(flowMonthFactor({ frequency: "monthly", interval_n: 1, start_month: "2026-01" }, monthIndex("2026-07")), 1, "monthly/1 every month");
// quarterly (monthly interval 3): hits Jan, Apr, Jul…; 0 in between
approx(flowMonthFactor({ frequency: "monthly", interval_n: 3, start_month: "2026-01" }, monthIndex("2026-01")), 1, "quarterly hits start");
approx(flowMonthFactor({ frequency: "monthly", interval_n: 3, start_month: "2026-01" }, monthIndex("2026-02")), 0, "quarterly skips off-month");
approx(flowMonthFactor({ frequency: "monthly", interval_n: 3, start_month: "2026-01" }, monthIndex("2026-04")), 1, "quarterly hits +3");
// yearly: only the start month-of-year
approx(flowMonthFactor({ frequency: "yearly", interval_n: 1, start_month: "2026-03" }, monthIndex("2026-03")), 1, "yearly hits its month");
approx(flowMonthFactor({ frequency: "yearly", interval_n: 1, start_month: "2026-03" }, monthIndex("2026-04")), 0, "yearly skips other months");
approx(flowMonthFactor({ frequency: "yearly", interval_n: 1, start_month: "2026-03" }, monthIndex("2027-03")), 1, "yearly hits next year");
approx(flowMonthFactor({ frequency: "yearly", interval_n: 2, start_month: "2026-03" }, monthIndex("2027-03")), 0, "biennial skips the off-year");
// weekly: accrues amount×(52/12)/interval each month
approx(flowMonthFactor({ frequency: "weekly", interval_n: 1 }, 0), 52 / 12, "weekly accrual factor");
approx(flowMonthFactor({ frequency: "weekly", interval_n: 2 }, 0), 52 / 24, "fortnightly accrual factor");
// before start → 0
approx(flowMonthFactor({ frequency: "monthly", interval_n: 1, start_month: "2026-06" }, monthIndex("2026-01")), 0, "before start → 0");

// end-to-end spread through computeForecast
const yearlyBill = computeForecast({
  settings: { horizon_months: 15, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 0, available_for_projects: true }],
  recurring_flows: [{ id: "y", kind: "expense", amount: 1200, frequency: "yearly", interval_n: 1, start_month: "2026-03" }],
});
approx(yearlyBill.months[1].expenses, 0, "yearly bill: Feb has no charge");
approx(yearlyBill.months[2].expenses, 1200, "yearly bill: Mar takes the whole charge");
approx(yearlyBill.months[14].expenses, 1200, "yearly bill: next Mar charges again");
const weekly = computeForecast({
  settings: { horizon_months: 1, cash_buffer: 0 }, startMonth: "2026-01",
  accounts: [{ balance: 0, available_for_projects: true }],
  recurring_flows: [{ id: "w", kind: "expense", amount: 30, frequency: "weekly", interval_n: 1, start_month: "2026-01" }],
});
approx(weekly.months[0].expenses, 30 * 52 / 12, "weekly £30 accrues ~£130/mo");

// ---- summary ---------------------------------------------------------------
log("");
log(`${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) throw new Error(FAIL + " test(s) failed");
