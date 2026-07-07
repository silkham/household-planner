// ============================================================================
//  reconcile.js — current-month reconciliation (pure core).
//  Fuses the FORWARD-looking recurring flows with the BACKWARD-looking Emma feed
//  for the CURRENT month, so overspend / a missing salary is visible mid-month
//  rather than after the fact. `reconcileMonth` is pure & deterministic (see
//  tests/reconcile.tests.js) — the Forecast tab renders whatever it returns.
//
//  Model (the household's mental model): everything is a KNOWN recurring flow
//  except one discretionary pot.
//   • Income group — the salary/income flows; each line is green (received) or
//     red (not received yet), matched on emma_match_key landing in this month.
//   • Expense groups — the known bills, grouped by the flow's own category
//     (Housing, Vehicle, Utilities…); each line paid vs due.
//   • General Expenses — the ONE non-known line: a user-set budget vs actual,
//     where actual = every counting outflow this month that ISN'T a known bill,
//     broken down by Emma category (Eating out, Amazon…) → transactions.
// ============================================================================

// A transaction's merchant/display key (matches spending.js / recurring.js).
export const txKey = (t) => t.customName || t.merchant || t.counterparty || "Unknown";

// The reserved discretionary group that carries the editable monthly budget.
export const GENERAL = "General Expenses";

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
//   recurring_flows state.recurring_flows (name, kind, amount, category, emma_match_key, start/end_month)
//   category_rules  state.category_rules (match_key → category) override
//   budgets         settings.forecast_budgets — { "General Expenses": 2500 }
//   excluded        Set of non-counting category names (from buildExcludedSet)
// Returns { income: [group], expense: [group] } — General is appended last on
// the expense side. Flow groups carry `lines`; the budget group carries `categories`.
export function reconcileMonth(opts = {}) {
  const month = opts.month;
  const txns = opts.txns || [];
  const flows = opts.recurring_flows || [];
  const budgets = opts.budgets || {};
  const excluded = opts.excluded || new Set();
  const rules = opts.rules instanceof Map
    ? opts.rules
    : new Map((opts.category_rules || []).map((r) => [r.match_key, r.category]));

  const effCat = (t) => rules.get(txKey(t)) || t.category || "Uncategorised";

  // This month's counting transactions (both directions).
  const monthTxns = txns.filter((t) => t.dateInt && monthOf(t.dateInt) === month
    && !excluded.has(effCat(t)));

  const activeFlows = flows.filter((f) => flowActive(f, month));
  // Every known bill's merchant key — used to carve known spend out of General.
  const knownKeys = new Set(activeFlows.map((f) => f.emma_match_key).filter(Boolean));

  // txns this month that match a specific flow (by key + direction)
  const flowTxns = (f, wantExpense) => f.emma_match_key
    ? monthTxns.filter((t) => txKey(t) === f.emma_match_key && (t.amount < 0) === wantExpense)
    : [];

  // Build the known-figure groups for one direction. Income collapses into a
  // single "Income" group; expenses group by the flow's own category.
  function knownGroups(kind) {
    const wantExpense = kind === "expense";
    const groups = new Map();
    for (const f of activeFlows) {
      if ((f.kind === "expense") !== wantExpense) continue;
      const gname = wantExpense ? (f.category || "Other") : "Income";
      if (!groups.has(gname))
        groups.set(gname, { name: gname, kind, type: "flows",
          expected: 0, actual: 0, pendingExpected: 0, over: false, lines: [] });
      const g = groups.get(gname);
      const expected = round2(Number(f.amount) || 0);
      const matched = flowTxns(f, wantExpense);
      const received = matched.length > 0;
      const actual = round2(matched.reduce((s, t) => s + Math.abs(t.amount), 0));
      matched.sort((a, b) => (b.dateInt || 0) - (a.dateInt || 0));
      g.lines.push({ id: f.id, name: f.name, expected, actual, received, txns: matched });
      g.expected = round2(g.expected + expected);
      g.actual = round2(g.actual + actual);
      if (!received) g.pendingExpected = round2(g.pendingExpected + expected);
    }
    const out = [...groups.values()];
    out.forEach((g) => {
      g.over = wantExpense && g.expected > 0 && g.actual > g.expected + 0.005;
      g.lines.sort((a, b) => b.expected - a.expected);
    });
    out.sort((a, b) => b.expected - a.expected);
    return out;
  }

  const income = knownGroups("income");
  const expense = knownGroups("expense");

  // ---- General Expenses: counting outflows NOT tied to a known bill --------
  const genTxns = monthTxns.filter((t) => t.amount < 0 && !knownKeys.has(txKey(t)));
  const catMap = new Map();
  for (const t of genTxns) {
    const c = effCat(t);
    if (!catMap.has(c)) catMap.set(c, { name: c, actual: 0, txns: [] });
    const node = catMap.get(c);
    node.actual = round2(node.actual + Math.abs(t.amount));
    node.txns.push(t);
  }
  const categories = [...catMap.values()];
  categories.forEach((c) => c.txns.sort((a, b) => (b.dateInt || 0) - (a.dateInt || 0)));
  categories.sort((a, b) => b.actual - a.actual);

  const budget = budgets[GENERAL] != null ? Number(budgets[GENERAL]) : 0;
  const genActual = round2(categories.reduce((s, c) => s + c.actual, 0));
  if (categories.length || budget > 0) {
    expense.push({
      name: GENERAL, kind: "expense", type: "budget",
      budget, expected: budget, actual: genActual,
      over: budget > 0 && genActual > budget + 0.005,
      categories,
    });
  }

  return { income, expense };
}
