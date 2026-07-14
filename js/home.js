// ============================================================================
//  home.js — the Home dashboard. The app's front door.
//  A "This month" strip (actual-vs-forecast, live from Emma) sits above three
//  EQUAL pillars — Forecast, Spending, Projects — each a glanceable summary
//  that taps through to its own area. When there are unmapped merchants a
//  "needs a category" action card surfaces with one-tap accept chips.
//  Forecast + Projects are synchronous (engine + state); anything Emma-derived
//  (the strip, Spending pillar, uncategorised card) fills in when the feed lands.
// ============================================================================
import { state, subscribe, currentForecast, saveCategoryRule } from "./store.js";
import { fmtGBP, fmtMonth } from "./sheet.js";
import { fetchEmma } from "./emma.js";
import { buildExcludedSet, effectiveCategory, txnKey, categoryNames, guessCategory } from "./categories.js";
import { reconcileMonth } from "./reconcile.js";

// ---- Emma feed (lazy, shared memoised fetch) -------------------------------
let emmaTxns = null, emmaErr = null, emmaLoading = false;
async function loadEmma() {
  if (emmaLoading || emmaTxns) return;
  emmaLoading = true;
  render();                       // paint the loading state immediately (no flash)
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
const emmaConfigured = () => !!(state.settings && state.settings.emma_sheet_id);

// Derived estimate/actual for a project (sum of line items when it has them).
function derived(p) {
  const items = state.project_items.filter((i) => i.project_id === p.id);
  if (!items.length) return { est: Number(p.estimated_cost) || 0, act: Number(p.actual_cost) || 0 };
  return {
    est: items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0),
    act: items.reduce((s, i) => s + (i.actual_cost == null ? 0 : Number(i.actual_cost)), 0),
  };
}

// ---- "This month" strip — actual-vs-forecast -------------------------------
// Fuses the forecast net (engine, months[0]) with what's actually landed this
// month (reconcileMonth over the live feed). Before the feed lands it shows a
// forecast-only line so there's no empty state. Taps through to the Forecast tab
// where the full reconciliation card lives.
function reconcileNow() {
  if (!emmaTxns) return null;
  return reconcileMonth({
    month: thisMonth(),
    txns: emmaTxns,
    recurring_flows: state.recurring_flows,
    bonuses: state.bonuses,
    category_rules: state.category_rules,
    budgets: (state.settings && state.settings.forecast_budgets) || {},
    excluded: buildExcludedSet(state.categories),
    projectKeys: new Set(state.project_item_txns.map((l) => l.emma_txn_id)),
  });
}
// The "This month" card headlines DISCRETIONARY spend — General Expenses (every
// counting outflow that ISN'T a known bill, from reconcileMonth) vs the monthly
// budget. Known bills are carved out via emma_match_key, so this is the number
// the household actually steers month to month. Net-so-far was dropped: early in
// the month it compares partial actuals (no salary yet) to a full forecast and
// always reads misleadingly negative.
function monthStrip() {
  const fc = currentForecast();
  if (!(fc.months || [])[0]) return "";
  const month = thisMonth();
  const budgets = (state.settings && state.settings.forecast_budgets) || {};
  const budget = Number(budgets["General Expenses"]) || 0;
  const r = reconcileNow();

  let big, tag = "", sub;
  if (!r) {
    // Feed not loaded — show the budget as context, no misleading actuals.
    big = budget ? `${fmtGBP(budget)} <span class="of">budget</span>` : "—";
    sub = emmaLoading ? "Syncing this month's spend…" : "General spending vs budget";
  } else {
    const gen = r.expense.find((g) => g.name === "General Expenses");
    const actual = gen ? gen.actual : 0;
    const over = !!(gen && gen.over);
    const top = gen && gen.categories && gen.categories[0];
    const topTxt = top ? ` · biggest: ${top.name} ${fmtGBP(top.actual)}` : "";
    big = budget
      ? `<span class="${over ? "neg" : "pos"}">${fmtGBP(actual)}</span> <span class="of">/ ${fmtGBP(budget)}</span>`
      : `<span class="pos">${fmtGBP(actual)}</span>`;
    if (budget) tag = over
      ? `<span class="hp-ms-tag coral">over</span>`
      : `<span class="hp-ms-tag mint">within</span>`;
    sub = !budget ? `discretionary spent${topTxt}`
      : over ? `${fmtGBP(actual - budget)} over budget${topTxt}`
      : `${fmtGBP(Math.max(0, budget - actual))} left${topTxt}`;
  }
  return `<div class="glass hp-ms" data-goto="forecast">
    <div class="hp-ms-top">
      <span class="eyebrow">This month · ${fmtMonth(month)} · general</span>
      <span class="hp-meta">${tag}<i data-lucide="chevron-right"></i></span>
    </div>
    <div class="hp-ms-big">${big}</div>
    <div class="hp-ms-sub">${sub}</div>
  </div>`;
}

// ---- "needs a category" action card ----------------------------------------
// Same detection as spending.js: unmapped counting outflows (effective category
// = Uncategorised). Top 3 by spend get an inline one-tap accept-guess chip;
// "See all" routes to Spending where the full prompt lives.
function uncatCard() {
  if (!emmaTxns) return "";
  const excluded = buildExcludedSet(state.categories);
  const rules = rulesMap();
  const agg = new Map();
  for (const t of emmaTxns) {
    if (t.amount >= 0) continue;
    if (excluded.has(effectiveCategory(t, rules))) continue;
    if (effectiveCategory(t, rules) !== "Uncategorised") continue;
    const k = txnKey(t);
    const a = agg.get(k) || { key: k, count: 0, total: 0, sample: t };
    a.count += 1; a.total += -t.amount; agg.set(k, a);
  }
  if (!agg.size) return "";
  const list = [...agg.values()].sort((a, b) => b.total - a.total);
  const total = list.reduce((s, x) => s + x.total, 0);
  const known = categoryNames(state.categories, emmaTxns, rules);
  const rows = list.slice(0, 3).map((x) => {
    const guess = guessCategory(x.sample, known);
    const accept = guess
      ? `<button class="hp-uc-accept" data-uc-key="${encodeURIComponent(x.key)}" data-uc-cat="${encodeURIComponent(guess)}" title="File as ${guess}">
           <i data-lucide="check"></i><span>${guess}</span></button>`
      : "";
    return `<div class="hp-uc-row">
      <button class="hp-uc-open" data-uc-open="${encodeURIComponent(x.key)}">
        <span class="hp-uc-name">${x.key}</span>
        <span class="hp-uc-meta">${x.count}× · ${fmtGBP(x.total)}</span>
      </button>${accept}</div>`;
  }).join("");
  return `<div class="glass hp-uc">
    <div class="hp-uc-head">
      <div>
        <div class="hp-uc-title">${list.length} merchant${list.length === 1 ? "" : "s"} need a category</div>
        <div class="hp-uc-sub">${fmtGBP(total)} unsorted · accept a guess or file each</div>
      </div>
      <span class="hp-uc-badge">${list.length}</span>
    </div>
    ${rows}
    <button class="hp-uc-all" data-goto="spending">See all in Spending<i data-lucide="chevron-right"></i></button>
  </div>`;
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

// The Forecast tile answers one question: over the horizon, does cash dip below
// the safety buffer, and when? So it LEADS with the low point (not today's cash,
// which isn't the forecast) + a buffer verdict. Taps through to the full chart.
function forecastPillar() {
  const fc = currentForecast();
  const ms = fc.months || [];
  if (!ms.length)
    return pillar("forecast", "Forecast", "outlook", "—", "",
      "Add accounts and flows to see your forecast");
  let dip = ms[0];
  for (const m of ms) if (m.cash < dip.cash) dip = m;
  const buffer = Number(fc.buffer) || 0;
  const below = dip.cash < buffer;
  const big = `<span class="${below ? "neg" : ""}">${fmtGBP(dip.cash)}</span> <span class="of">lowest</span>`;
  const sub = below
    ? `<span class="neg">Dips below your ${fmtGBP(buffer)} buffer in ${fmtMonth(dip.month)}</span>`
    : `Stays above your ${fmtGBP(buffer)} buffer · ${fmtMonth(dip.month)}`;
  return pillar("forecast", "Forecast", `next ${ms.length} mo`, big, sparkSvg(ms), sub);
}

// ---- Spending pillar -------------------------------------------------------
function spendingPillar() {
  if (emmaTxns === null) {
    const sub = emmaLoading ? "Loading this month…"
      : emmaErr ? "Couldn't load Emma"
      : emmaConfigured() ? "Tap to view spending"
      : "Connect Emma to see spending";
    const meta = emmaLoading ? `<span class="hp-load">syncing…</span>` : "this month";
    return pillar("spending", "Spending", meta, "—", "", sub);
  }
  const ym = thisMonth();
  const excluded = buildExcludedSet(state.categories);
  const rules = rulesMap();
  let spent = 0;
  const byCat = {};
  for (const t of emmaTxns) {
    if (t.amount >= 0) continue;
    if (monthOf(t.dateInt) !== ym) continue;   // dateInt is the yyyymmdd int; t.date is the raw string
    const cat = effectiveCategory(t, rules);
    if (excluded.has(cat)) continue;
    const amt = -t.amount;
    spent += amt;
    byCat[cat] = (byCat[cat] || 0) + amt;
  }
  const big = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  const bigTxt = big ? `biggest: ${big[0]} ${fmtGBP(big[1])}` : "nothing counted yet";
  // Total counting spend this month (bills + discretionary). No budget bar —
  // discretionary-vs-budget is the "This month" card's job; total spend vs the
  // General budget would be apples-to-oranges.
  return pillar("spending", "Spending", "this month", fmtGBP(spent), "", bigTxt);
}

// ---- Projects pillar -------------------------------------------------------
function projectsPillar() {
  // active = still has money left to spend (there's no project status now).
  const active = state.projects.filter((p) => {
    const d = derived(p);
    return d.est - d.act > 0.005;
  });
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
    ${monthStrip()}
    ${uncatCard()}
    ${forecastPillar()}
    ${spendingPillar()}
    ${projectsPillar()}`;

  root.querySelectorAll("[data-goto]").forEach((el) =>
    el.onclick = () => { location.hash = "#/" + el.dataset.goto; });

  // Inline accept-guess: file the merchant under the guessed category, no sheet.
  root.querySelectorAll(".hp-uc-accept").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    await saveCategoryRule(
      decodeURIComponent(b.dataset.ucKey),
      decodeURIComponent(b.dataset.ucCat));
    // saveCategoryRule → loadAll → subscribers re-render; the merchant drops out.
  });
  // Tapping the merchant name opens Spending (full sheet incl. project link).
  root.querySelectorAll("[data-uc-open]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    location.hash = "#/spending";
  });

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountHome() {
  subscribe(render);
  render();
  loadEmma();
}
