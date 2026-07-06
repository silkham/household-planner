// ============================================================================
//  engine.js — cashflow forecast. THE beating heart of the app.
//  Pure, side-effect-free, deterministic (pass `startMonth` for tests).
//  Consumes one number per project (`estimated_cost`) — never reads
//  project_items; line items are a UI/tracking concern (see CLAUDE.md).
// ============================================================================

// ---- month helpers ---------------------------------------------------------
// Months are 'YYYY-MM' strings throughout — no Date objects, no timezone pain.
export const monthIndex = (ym) => {
  if (!ym) return null;
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
};
export const fromIndex = (idx) => {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
};
export const addMonths = (ym, n) => fromIndex(monthIndex(ym) + n);
export const monthOfYear = (ym) => Number(ym.split("-")[1]); // 1–12
export const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// ---- amortisation ----------------------------------------------------------
// Standard formula; guards the 0% case (0% credit-card financing).
export function monthlyPayment({ principal = 0, apr = 0, term_months = 0 }) {
  const P = Number(principal) || 0;
  const n = Number(term_months) || 0;
  if (P <= 0 || n <= 0) return 0;
  const r = (Number(apr) || 0) / 12;
  if (r === 0) return P / n;
  const g = Math.pow(1 + r, n);
  return (P * (r * g)) / (g - 1);
}

// ---- scenario confidence filter --------------------------------------------
// conservative → confirmed only · realistic → confirmed+likely · optimistic → all
export function confidencePasses(confidence, scenario) {
  if (scenario === "optimistic") return true;
  if (scenario === "conservative") return confidence === "confirmed";
  return confidence !== "speculative"; // realistic (default)
}

// ---- flow activity + effective amount --------------------------------------
const activeInMonth = (startYm, endYm, mIdx) => {
  const s = monthIndex(startYm);
  if (s != null && mIdx < s) return false;
  const e = monthIndex(endYm);
  if (e != null && mIdx > e) return false;
  return true;
};

// effective_amount(flow, month): base → compounded annual uplift → salary_change
// override (latest one that passes the confidence filter). A step-change wins
// over uplift for that month (it sets a fresh net figure).
export function effectiveAmount(flow, mIdx, salaryChanges, scenario) {
  let amount = Number(flow.amount) || 0;

  // compounded annual uplift: one bump per uplift_month anniversary strictly
  // after start_month and up to & including the current month.
  const pct = flow.annual_uplift_pct;
  const startIdx = monthIndex(flow.start_month);
  if (pct && startIdx != null) {
    const upMonth = Number(flow.uplift_month) || 4; // default April
    let bumps = 0;
    const startYear = Math.floor(startIdx / 12);
    const curYear = Math.floor(mIdx / 12);
    for (let y = startYear; y <= curYear; y++) {
      const anniv = y * 12 + (upMonth - 1);
      if (anniv > startIdx && anniv <= mIdx) bumps++;
    }
    if (bumps) amount *= Math.pow(1 + Number(pct), bumps);
  }

  // latest applicable salary_change overrides the amount for this month
  const changes = (salaryChanges || [])
    .filter((c) => c.flow_id === flow.id)
    .filter((c) => monthIndex(c.effective_month) != null && monthIndex(c.effective_month) <= mIdx)
    .filter((c) => confidencePasses(c.confidence, scenario))
    .sort((a, b) => monthIndex(a.effective_month) - monthIndex(b.effective_month));
  if (changes.length) amount = Number(changes[changes.length - 1].new_amount) || 0;

  return amount;
}

// ---- project spend ---------------------------------------------------------
const PROJECT_ACTIVE_STATUSES = new Set(["Planned", "Quoted", "In Progress"]);

// project_cost_in_month: if a cost_spread override exists it is AUTHORITATIVE
// (months absent from it contribute 0 — no even-split fallthrough, or the total
// would exceed estimated_cost). Otherwise split evenly over the duration.
export function projectCostInMonth(p, mIdx) {
  const spread = p.cost_spread;
  if (spread && typeof spread === "object" && Object.keys(spread).length) {
    return Number(spread[fromIndex(mIdx)]) || 0;
  }
  const startIdx = monthIndex(p.target_start_month);
  if (startIdx == null) return 0;
  const dur = Math.max(1, Number(p.duration_months) || 1);
  if (mIdx >= startIdx && mIdx < startIdx + dur) {
    return (Number(p.estimated_cost) || 0) / dur;
  }
  return 0;
}

// ---- bonuses ---------------------------------------------------------------
// hits_month: exact month match, or (if recurs_annually) same month-of-year in
// any year at or after the first expected year.
export function bonusHitsMonth(b, mIdx) {
  const eIdx = monthIndex(b.expected_month);
  if (eIdx == null) return false;
  if (!b.recurs_annually) return eIdx === mIdx;
  if (mIdx < eIdx) return false;
  return monthOfYear(fromIndex(mIdx)) === monthOfYear(b.expected_month);
}

// ---- life events -----------------------------------------------------------
// SIGN CONVENTION (matches the sheet's "− = worse" input): monthly_impact is a
// signed delta to NET — negative always means worse for cashflow, for BOTH
// income_change and expense_change. So income adjustments add directly to
// income, and expense adjustments are folded into expenses as −monthly_impact
// (a −£300 nursery becomes +£300 of expense). Net drops by £300 either way.
const lifeEventActive = (e, mIdx) => {
  const eIdx = monthIndex(e.effective_month);
  if (eIdx == null || mIdx < eIdx) return false;
  const dur = e.duration_months;
  if (dur != null && mIdx >= eIdx + Number(dur)) return false;
  return true;
};

// ---- the forecast ----------------------------------------------------------
export function computeForecast(input) {
  const {
    accounts = [], recurring_flows = [], salary_changes = [], life_events = [],
    bonuses = [], projects = [], financing_options = [], settings = {},
    scenario = settings.forecast_confidence || "realistic",
    startMonth = currentMonth(),
  } = input || {};

  const horizon = Number(settings.horizon_months) || 24;
  const buffer = Number(settings.cash_buffer) || 0;
  const start = monthIndex(startMonth);

  const opening = accounts
    .filter((a) => a.available_for_projects)
    .reduce((s, a) => s + (Number(a.balance) || 0), 0);

  const activeLoans = financing_options.filter((f) => f.status === "active");
  const months = [];
  let cash = opening;

  for (let i = 0; i < horizon; i++) {
    const mIdx = start + i;
    const month = fromIndex(mIdx);
    const bd = { income: [], expenses: [] }; // breakdown line items

    // ---- INCOME ----
    let income = 0;
    for (const f of recurring_flows) {
      if (f.kind !== "income" || !activeInMonth(f.start_month, f.end_month, mIdx)) continue;
      const amt = effectiveAmount(f, mIdx, salary_changes, scenario);
      income += amt;
      bd.income.push({ name: f.name, amount: amt, source: "salary" });
    }
    for (const b of bonuses) {
      if (!bonusHitsMonth(b, mIdx) || !confidencePasses(b.confidence, scenario)) continue;
      const amt = Number(b.net_amount) || 0;
      income += amt;
      bd.income.push({ name: b.name, amount: amt, source: "bonus" });
    }
    for (const f of activeLoans) {
      if (monthIndex(f.start_month) === mIdx) {
        const amt = Number(f.principal) || 0;
        income += amt;
        bd.income.push({ name: f.name + " drawdown", amount: amt, source: "financing" });
      }
    }
    for (const e of life_events) {
      if (!lifeEventActive(e, mIdx)) continue;
      if (e.event_type === "income_change") {
        const amt = Number(e.monthly_impact) || 0;
        income += amt;
        bd.income.push({ name: e.name, amount: amt, source: "life_event" });
      } else if (e.event_type === "lump_sum" && monthIndex(e.effective_month) === mIdx) {
        const amt = Number(e.monthly_impact) || 0;
        income += amt;
        bd.income.push({ name: e.name, amount: amt, source: "life_event" });
      }
    }

    // ---- EXPENSES ----
    let expenses = 0;
    for (const f of recurring_flows) {
      if (f.kind !== "expense" || !activeInMonth(f.start_month, f.end_month, mIdx)) continue;
      const amt = effectiveAmount(f, mIdx, salary_changes, scenario);
      expenses += amt;
      bd.expenses.push({ name: f.name, amount: amt, source: "recurring" });
    }
    for (const f of activeLoans) {
      const sIdx = monthIndex(f.start_month);
      if (sIdx != null && mIdx >= sIdx && mIdx < sIdx + (Number(f.term_months) || 0)) {
        const amt = monthlyPayment(f);
        expenses += amt;
        bd.expenses.push({ name: f.name + " payment", amount: amt, source: "loan" });
      }
    }
    for (const e of life_events) {
      if (e.event_type !== "expense_change" || !lifeEventActive(e, mIdx)) continue;
      const amt = -(Number(e.monthly_impact) || 0); // −impact: worse (−) → more expense
      expenses += amt;
      bd.expenses.push({ name: e.name, amount: amt, source: "life_event" });
    }
    let projectSpend = 0;
    for (const p of projects) {
      if (!PROJECT_ACTIVE_STATUSES.has(p.status)) continue;
      const amt = projectCostInMonth(p, mIdx);
      if (amt) {
        projectSpend += amt;
        expenses += amt;
        bd.expenses.push({ name: p.name, amount: amt, source: "project", project_id: p.id });
      }
    }

    // ---- NET & CASH ----
    const net = income - expenses;
    const prevCash = cash;
    cash = prevCash + net;

    // ---- FLAGS ----
    const flags = [];
    if (cash < 0) flags.push("negative");
    if (cash < buffer) flags.push("below_buffer");
    for (const p of projects) {
      if (PROJECT_ACTIVE_STATUSES.has(p.status) && monthIndex(p.target_start_month) === mIdx) {
        if (cash - prevCash < -0.5 * (Number(p.estimated_cost) || 0)) {
          flags.push("project_spike");
          break;
        }
      }
    }

    months.push({ month, income, expenses, project_spend: projectSpend, net, cash, flags, breakdown: bd });
  }

  return { months, opening_cash: opening, buffer, scenario };
}

// ---- affordability per project ---------------------------------------------
// Full-forecast, project's active months: red if cash goes negative in any of
// the project's active months, amber if it dips below buffer, else green.
export function projectAffordability(project, forecast) {
  const start = monthIndex(project.target_start_month);
  if (start == null || !PROJECT_ACTIVE_STATUSES.has(project.status)) return "none";
  const dur = Math.max(1, Number(project.duration_months) || 1);
  const spreadKeys = project.cost_spread ? Object.keys(project.cost_spread).map(monthIndex) : [];
  const inActive = (mIdx) =>
    (mIdx >= start && mIdx < start + dur) || spreadKeys.includes(mIdx);

  let worst = "green";
  for (const m of forecast.months) {
    if (!inActive(monthIndex(m.month))) continue;
    if (m.flags.includes("negative")) return "red";
    if (m.flags.includes("below_buffer")) worst = "amber";
  }
  return worst;
}
