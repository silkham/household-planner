// ============================================================================
//  home.js — the Home dashboard. The app's front door.
//  Three EQUAL pillars — Forecast, Spending, Projects — each a glanceable
//  summary that taps through to its own area. No pillar is louder than the
//  others. Forecast + Projects are synchronous (engine + state); Spending
//  lazily pulls the Emma feed and fills in when it's ready.
// ============================================================================
import { state, subscribe, currentForecast } from "./store.js";
import { fmtGBP, fmtMonth } from "./sheet.js";
import { fetchEmma } from "./emma.js";
import { buildExcludedSet, effectiveCategory } from "./categories.js";

// ---- Emma feed (lazy, shared memoised fetch) -------------------------------
let emmaTxns = null, emmaErr = null, emmaLoading = false;
async function loadEmma() {
  if (emmaLoading || emmaTxns) return;
  emmaLoading = true;
  try {
    const res = await fetchEmma();
    emmaTxns = res.txns || [];
  } catch (e) {
    emmaErr = e.message || String(e);
  } finally {
    emmaLoading = false;
    render();
  }
}

function rulesMap() {
  const m = new Map();
  for (const r of state.category_rules) m.set(r.match_key, r.category);
  return m;
}
const monthOf = (dateInt) => {
  if (!dateInt) return null;
  const y = Math.floor(dateInt / 10000);
  const mo = Math.floor((dateInt % 10000) / 100);
  return `${y}-${String(mo).padStart(2, "0")}`;
};
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Derived estimate/actual for a project (sum of line items when it has them).
function derived(p) {
  const items = state.project_items.filter((i) => i.project_id === p.id);
  if (!items.length) return { est: Number(p.estimated_cost) || 0, act: Number(p.actual_cost) || 0 };
  return {
    est: items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0),
    act: items.reduce((s, i) => s + (i.actual_cost == null ? 0 : Number(i.actual_cost)), 0),
  };
}

// ---- pillar shell ----------------------------------------------------------
function pillar(id, label, meta, big, mid, sub) {
  return `<div class="glass hp-pillar" data-goto="${id}">
    <div class="hp-head"><span class="eyebrow">${label}</span>
      <span class="hp-meta">${meta}<i data-lucide="chevron-right"></i></span></div>
    <div class="hp-big">${big}</div>
    ${mid || ""}
    <div class="hp-sub">${sub}</div>
  </div>`;
}

// ---- Forecast pillar -------------------------------------------------------
function sparkSvg(ms) {
  if (ms.length < 2) return "";
  const cs = ms.map((m) => m.cash);
  const min = Math.min(...cs), max = Math.max(...cs), span = (max - min) || 1;
  const W = 260, H = 40, pad = 4;
  const px = (i) => (i / (cs.length - 1)) * W;
  const py = (c) => H - pad - ((c - min) / span) * (H - pad * 2);
  const pts = cs.map((c, i) => `${px(i).toFixed(1)},${py(c).toFixed(1)}`).join(" ");
  const mi = cs.indexOf(min);
  return `<svg class="hp-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="var(--mint)" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${px(mi).toFixed(1)}" cy="${py(min).toFixed(1)}" r="3.5" fill="var(--coral)"/></svg>`;
}

function forecastPillar() {
  const fc = currentForecast();
  const ms = fc.months || [];
  const now = state.accounts
    .filter((a) => a.available_for_projects)
    .reduce((s, a) => s + (Number(a.balance) || 0), 0);
  let dip = null;
  for (const m of ms) if (dip === null || m.cash < dip.cash) dip = m;
  const buffer = Number(fc.buffer) || 0;
  let sub;
  if (!ms.length) sub = "Add accounts and flows to see your forecast";
  else if (dip && dip.cash < buffer)
    sub = `<span class="neg">Dips to ${fmtGBP(dip.cash)}</span> — below buffer in ${fmtMonth(dip.month)}`;
  else if (dip)
    sub = `Low point ${fmtGBP(dip.cash)} in ${fmtMonth(dip.month)}`;
  else sub = "";
  return pillar("forecast", "Forecast", "cash now", fmtGBP(now), sparkSvg(ms), sub);
}

// ---- Spending pillar -------------------------------------------------------
function spendingPillar() {
  if (emmaTxns === null) {
    const sub = emmaLoading ? "Loading this month…" : emmaErr ? "Couldn't load Emma" : "Tap to view spending";
    return pillar("spending", "Spending", "this month", "—", "", sub);
  }
  const ym = thisMonth();
  const excluded = buildExcludedSet(state.categories);
  const rules = rulesMap();
  let spent = 0;
  const byCat = {};
  for (const t of emmaTxns) {
    if (t.amount >= 0) continue;
    if (monthOf(t.date) !== ym) continue;
    const cat = effectiveCategory(t, rules);
    if (excluded.has(cat)) continue;
    const amt = -t.amount;
    spent += amt;
    byCat[cat] = (byCat[cat] || 0) + amt;
  }
  const budgets = (state.settings && state.settings.forecast_budgets) || {};
  const budget = Number(budgets["General Expenses"]) || 0;
  const big = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  const bigTxt = big ? `biggest: ${big[0]} ${fmtGBP(big[1])}` : "nothing counted yet";
  const bigNum = budget
    ? `${fmtGBP(spent)} <span class="of">/ ${fmtGBP(budget)}</span>`
    : fmtGBP(spent);
  const mid = budget
    ? `<div class="hp-bar"><i style="width:${Math.min(100, budget ? (spent / budget) * 100 : 0).toFixed(0)}%"></i></div>`
    : "";
  const sub = budget ? `${fmtGBP(Math.max(0, budget - spent))} left · ${bigTxt}` : bigTxt;
  return pillar("spending", "Spending", "this month", bigNum, mid, sub);
}

// ---- Projects pillar -------------------------------------------------------
function projectsPillar() {
  const active = state.projects.filter((p) =>
    ["Planned", "Quoted", "In Progress"].includes(p.status));
  if (!active.length)
    return pillar("projects", "Projects", "none active", "—", "", "Add a project to start planning");
  let committed = 0, spent = 0;
  for (const p of active) { const d = derived(p); committed += d.est; spent += d.act; }
  // Next upcoming spend: earliest project starting this month or later.
  const ym = thisMonth();
  const upcoming = active
    .filter((p) => p.target_start_month && p.target_start_month >= ym)
    .sort((a, b) => a.target_start_month.localeCompare(b.target_start_month))[0];
  const nextTxt = upcoming
    ? `Next: ${upcoming.name} · ${fmtGBP(derived(upcoming).est)} in ${fmtMonth(upcoming.target_start_month)}`
    : `${active.length} active · ${active.map((p) => p.name).slice(0, 3).join(", ")}`;
  const mid = committed
    ? `<div class="hp-bar blue"><i style="width:${Math.min(100, (spent / committed) * 100).toFixed(0)}%"></i></div>`
    : "";
  return pillar("projects", "Projects", `${active.length} active`,
    `${fmtGBP(spent)} <span class="of">/ ${fmtGBP(committed)}</span>`, mid, nextTxt);
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("home-root");
  if (!root) return;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  root.innerHTML = `
    <div class="hp-greet">${greet}</div>
    ${forecastPillar()}
    ${spendingPillar()}
    ${projectsPillar()}`;
  root.querySelectorAll("[data-goto]").forEach((el) =>
    el.onclick = () => { location.hash = "#/" + el.dataset.goto; });
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountHome() {
  subscribe(render);
  render();
  loadEmma();
}
