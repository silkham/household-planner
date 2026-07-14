// ============================================================================
//  reports.js — the Reports / Budgeting tab (V2 step 4).
//  The backward-looking "where does the money go, and what could we cut" view.
//  Two things: category trends over a rolling window (with month-on-month
//  change + sparklines) and a cost-to-kill list of annualised recurring
//  commitments. Reads the SAME memoised Emma feed as Spending/Merchants and
//  re-uses the shared category logic + the Spending categorise sheet.
//
//  `reportCategories` + `annualCost` are PURE, import-free cores (bundled by
//  tests/run.sh) — they replicate effectiveCategory inline for the same reason
//  reconcile/recurring/merchants do (the JavaScriptCore runner can't resolve
//  ES imports).
// ============================================================================
import { state, subscribe } from "./store.js";
import { fetchEmma, cachedEmmaTxns } from "./emma.js";
import { fmtGBP } from "./sheet.js";
import { buildExcludedSet } from "./categories.js";
import { categorise } from "./spending.js";
import { rankMerchants, merchantDetailHtml } from "./merchants.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ordLabel = (o) => `${MON[o % 12]} '${String(Math.floor(o / 12)).slice(2)}`;

// ---- PURE aggregation core -------------------------------------------------
// Spend by EFFECTIVE CATEGORY per month within a rolling window, compared to
// the prior equal-length window. Import-free so tests/run.sh can bundle it.
//   opts.rules      Map<match_key, category>
//   opts.excluded   Set of non-counting category names
//   opts.monthsBack window length in months (null = all history, no comparison)
//   opts.endInt     yyyymmdd of the feed's newest txn (window anchor)
// → { months:[ord…], rows:[{category,total,count,avg,prev,delta,deltaPct,byMonth}],
//     monthlyTotals:{ord:£}, grandTotal }
export function reportCategories(txns = [], opts = {}) {
  const { rules = new Map(), excluded = new Set(["Excluded", "Transfers"]),
          monthsBack = null, endInt = null } = opts;

  const passThrough = (c) => {
    const l = (c || "").toLowerCase();
    if (l === "excluded") return "Excluded";
    if (l === "transfer" || l === "transfers") return "Transfers";
    return null;
  };
  const ruleCat = (t) =>
    (t.customName && rules.get(t.customName)) ||
    (t.merchant && rules.get(t.merchant)) ||
    (t.counterparty && rules.get(t.counterparty)) || null;
  const effCat = (t) => ruleCat(t) || passThrough(t.category) || "Uncategorised";
  const ordOf = (di) => {
    if (!di) return null;
    return Math.floor(di / 10000) * 12 + (Math.floor((di % 10000) / 100) - 1);
  };

  let endOrd = ordOf(endInt);
  if (endOrd == null)
    for (const t of txns) { const o = ordOf(t.dateInt); if (o != null && (endOrd == null || o > endOrd)) endOrd = o; }

  const hasWin = !!monthsBack && endOrd != null;
  const curStart = hasWin ? endOrd - monthsBack + 1 : -Infinity;
  const prevStart = hasWin ? endOrd - 2 * monthsBack + 1 : null;
  const prevEnd = hasWin ? endOrd - monthsBack : null;

  const months = [];
  if (hasWin) for (let o = curStart; o <= endOrd; o++) months.push(o);

  const rows = new Map();
  const monthlyTotals = {};
  const allOrds = new Set();
  for (const t of txns) {
    if (t.amount >= 0) continue;                 // spend = outflow only
    const cat = effCat(t);
    if (excluded.has(cat)) continue;
    const o = ordOf(t.dateInt);
    if (o == null) continue;
    allOrds.add(o);
    const inCur = hasWin ? (o >= curStart && o <= endOrd) : true;
    const inPrev = hasWin && o >= prevStart && o <= prevEnd;
    if (!inCur && !inPrev) continue;
    const amt = -t.amount;
    let r = rows.get(cat);
    if (!r) { r = { category: cat, total: 0, count: 0, prev: 0, byMonth: {} }; rows.set(cat, r); }
    if (inCur) { r.total += amt; r.count += 1; r.byMonth[o] = (r.byMonth[o] || 0) + amt; monthlyTotals[o] = (monthlyTotals[o] || 0) + amt; }
    if (inPrev) r.prev += amt;
  }

  const nMonths = hasWin ? months.length : (allOrds.size || 1);

  const out = [...rows.values()]
    .filter((r) => r.total > 0)
    .map((r) => ({ ...r, avg: r.total / (nMonths || 1),
                   delta: r.total - r.prev,
                   deltaPct: r.prev > 0 ? (r.total - r.prev) / r.prev : null }))
    .sort((a, b) => b.total - a.total);

  const grandTotal = out.reduce((s, r) => s + r.total, 0);
  return { months, rows: out, monthlyTotals, grandTotal };
}

// annualised £ of a recurring flow, honouring frequency/interval_n. Pure.
//   monthly → amount × 12/n · weekly → amount × 52/n · yearly → amount × 1/n
export function annualCost(flow = {}) {
  const amt = Number(flow.amount) || 0;
  const n = Math.max(1, Number(flow.interval_n) || 1);
  const freq = flow.frequency || "monthly";
  const perYear = freq === "weekly" ? 52 / n : freq === "yearly" ? 1 / n : 12 / n;
  return amt * perYear;
}

// ---- module state ----------------------------------------------------------
let txns = null;          // cached feed (null = not loaded)
let loading = false;
let loadErr = null;
let monthsBack = 6;       // null = all history
let sortMode = "total";   // "total" | "mover"
let selCat = null;        // drill-down category (null = list)
let selMerchant = null;   // drill-down merchant within a category (null = category list)

const PERIODS = [[3, "3m"], [6, "6m"], [12, "12m"], [null, "All"]];

// ---- helpers ---------------------------------------------------------------
const rulesMap = () => new Map(state.category_rules.map((r) => [r.match_key, r.category]));
const feedEndInt = () => (txns || []).reduce((m, t) => (t.dateInt && t.dateInt > m ? t.dateInt : m), 0) || null;
const enc = (s) => encodeURIComponent(s);

async function load(force = false) {
  if (loading || (txns && !force)) return;
  loading = true; loadErr = null; render();
  try { txns = (await fetchEmma(force)).txns || []; }
  catch (e) { loadErr = e.message || String(e); }
  finally { loading = false; render(); }
}

function spark(byMonth, months) {
  const ms = months.length ? months : Object.keys(byMonth).map(Number).sort((a, b) => a - b);
  if (ms.length < 2) return `<span class="mc-spark-empty"></span>`;
  const vals = ms.map((o) => byMonth[o] || 0);
  const max = Math.max(...vals, 1);
  const W = 64, H = 22, step = W / (ms.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 3) - 1).toFixed(1)}`).join(" ");
  return `<svg class="mc-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

function deltaChip(r) {
  if (monthsBack == null) return "";
  if (r.prev <= 0) return `<span class="mc-delta new">new</span>`;
  const up = r.delta > 0;
  const label = r.deltaPct != null ? `${Math.abs(Math.round(r.deltaPct * 100))}%` : fmtGBP(Math.abs(r.delta));
  return `<span class="mc-delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${label}</span>`;
}

// ---- monthly-total bar chart ----------------------------------------------
function totalsChart(months, monthlyTotals) {
  if (months.length < 2) return "";
  const max = Math.max(1, ...months.map((o) => monthlyTotals[o] || 0));
  const bars = months.map((o) => {
    const v = monthlyTotals[o] || 0;
    return `<div class="rp-bar" title="${ordLabel(o)} · ${fmtGBP(v)}">
      <div class="rp-bar-fill" style="height:${Math.max(3, (v / max) * 100)}%"></div>
      <span class="rp-bar-lbl">${MON[o % 12]}</span></div>`;
  }).join("");
  return `<div class="rp-chart glass">${bars}</div>`;
}

// ---- cost-to-kill (annualised recurring commitments) -----------------------
function costToKill() {
  // Fixed commitments still on the table — those marked Keep drop off.
  const flows = state.recurring_flows
    .filter((f) => f.kind === "expense" && f.decision !== "keep")
    .map((f) => ({ f, yr: annualCost(f) }))
    .filter((x) => x.yr > 0)
    .sort((a, b) => b.yr - a.yr);
  if (!flows.length) return "";
  const totYr = flows.reduce((s, x) => s + x.yr, 0);
  const rows = flows.slice(0, 12).map(({ f, yr }) => {
    const d = f.decision;
    const chip = d === "kill" ? `<span class="rp-kill-chip kill">kill</span>`
      : d === "review" ? `<span class="rp-kill-chip review">review</span>` : "";
    return `<div class="rp-kill-row">
      <span class="rp-kill-name">${f.name}${chip}</span>
      <span class="rp-kill-cat">${f.category || ""}</span>
      <span class="rp-kill-mo">${fmtGBP(yr / 12)}/mo</span>
      <span class="rp-kill-yr">${fmtGBP(yr)}/yr</span>
    </div>`;
  }).join("");
  return `<div class="rp-sec">
    <div class="rp-sec-head"><h2>Cost to kill</h2>
      <span class="rp-sec-sub">Not-kept commitments · ${fmtGBP(totYr)}/yr total</span></div>
    <p class="muted rp-kill-note">Fixed commitments you haven't marked Keep, biggest per-year first. Tag Keep/Review/Kill on a flow in Finances, then work them in <a href="#/analysis" class="rp-link">Analysis</a>.</p>
    <div class="rp-kill">${rows}</div>
  </div>`;
}

// ---- category drill-down ---------------------------------------------------
function catDetail(cat, rules, excluded) {
  const { months, rows } = rankMerchants(txns, { rules, excluded, monthsBack, endInt: feedEndInt() });
  const mine = rows.filter((r) => r.category === cat);
  const total = mine.reduce((s, r) => s + r.total, 0);
  const list = mine.map((r) => `<button class="mc-row rp-mrow" data-mkey="${enc(r.key)}" data-mcat="${enc(r.category)}">
    <span class="mc-name">${r.key}</span>
    ${spark(r.byMonth, months)}
    ${deltaChip(r)}
    <span class="mc-total">${fmtGBP(r.total)}</span>
    <span class="mc-count">${r.count}×</span>
  </button>`).join("");
  return `<button class="mc-back" data-back><i data-lucide="arrow-left"></i>All categories</button>
    <div class="mc-dhead"><div><h2 class="mc-dname">${cat}</h2>
      <p class="sec-sub">${mine.length} merchant${mine.length === 1 ? "" : "s"} · ${fmtGBP(total)}${monthsBack ? ` in ${monthsBack}m` : ""}</p></div></div>
    ${mine.length ? `<div class="mc-list">${list}</div>` : `<div class="sec-empty">No merchants in this category.</div>`}`;
}

// ---- category-trends list --------------------------------------------------
function trendsBody() {
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);
  if (selMerchant) return merchantDetailHtml(txns, selMerchant, rules, { backLabel: selCat || "All categories" });
  if (selCat) return catDetail(selCat, rules, excluded);

  const { months, rows, monthlyTotals, grandTotal } =
    reportCategories(txns, { rules, excluded, monthsBack, endInt: feedEndInt() });

  const controls = `<div class="mc-controls">
    <div class="mc-seg" data-seg="period">
      ${PERIODS.map(([v, l]) => `<button data-period="${v == null ? "" : v}" class="${monthsBack === v ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <div class="mc-seg" data-seg="sort">
      ${[["total", "Biggest"], ["mover", "Movers"]].map(([v, l]) =>
        `<button data-sort="${v}" class="${sortMode === v ? "on" : ""}">${l}</button>`).join("")}
    </div>
  </div>`;

  if (!rows.length) return controls + `<div class="sec-empty">No spending in this window.</div>`;

  const sorted = sortMode === "mover"
    ? [...rows].sort((a, b) => b.delta - a.delta)     // biggest risers first
    : rows;

  const perMo = monthsBack ? ` · ${fmtGBP(grandTotal / months.length)}/mo` : "";
  const summary = `<div class="mc-summary">${rows.length} categories · ${fmtGBP(grandTotal)}${monthsBack ? ` in ${monthsBack}m` : ""}${perMo}</div>`;

  const list = sorted.map((r) => `<button class="mc-row rp-catrow" data-catkey="${enc(r.category)}">
    <span class="mc-name">${r.category}</span>
    ${spark(r.byMonth, months)}
    ${deltaChip(r)}
    <span class="mc-total">${fmtGBP(r.total)}</span>
    <span class="rp-avg">${fmtGBP(r.avg)}/mo</span>
  </button>`).join("");

  return controls + totalsChart(months, monthlyTotals) + summary + `<div class="mc-list">${list}</div>` + costToKill();
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("reports-root");
  if (!root) return;

  const head = `<div class="mc-top">
    <div><div class="eyebrow">Reports</div>
      <p class="sec-sub">Where the money goes, and what to cut.</p></div>
    <button class="sec-sync" data-refresh ${loading ? "disabled" : ""}>
      <i data-lucide="refresh-cw"></i>${loading ? "Loading…" : "Refresh"}</button>
  </div>`;

  let body;
  if (loadErr) body = `<div class="sec-empty">Couldn't load Emma: ${loadErr}<br><button class="sp-load" data-refresh>Try again</button></div>`;
  else if (txns == null) body = `<div class="sec-empty">${loading ? "Loading spending…" : `<button class="sp-load" data-refresh>Load from Emma</button>`}</div>`;
  else body = trendsBody();

  root.innerHTML = head + body;

  root.querySelectorAll("[data-refresh]").forEach((b) => b.onclick = () => load(true));
  root.querySelectorAll("[data-period]").forEach((b) => b.onclick = () => {
    monthsBack = b.dataset.period === "" ? null : +b.dataset.period; render();
  });
  root.querySelectorAll("[data-sort]").forEach((b) => b.onclick = () => { sortMode = b.dataset.sort; render(); });
  root.querySelectorAll(".rp-catrow").forEach((b) => b.onclick = () => { selCat = decodeURIComponent(b.dataset.catkey); render(); });
  // back: from merchant → category, else from category → list
  root.querySelectorAll("[data-back]").forEach((b) => b.onclick = () => {
    if (selMerchant) selMerchant = null; else selCat = null;
    render();
  });
  // merchant rows inside a category drill-down → merchant detail (bars + txns)
  root.querySelectorAll(".mc-row[data-mkey]").forEach((b) => b.onclick = () => { selMerchant = decodeURIComponent(b.dataset.mkey); render(); });
  // re-file from the merchant detail (.mc-tx rows + the .mc-refile button)
  root.querySelectorAll(".mc-tx, .mc-refile").forEach((b) => b.onclick = () =>
    categorise(decodeURIComponent(b.dataset.key), decodeURIComponent(b.dataset.cat), cachedEmmaTxns(), render));

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountReports() {
  subscribe(render);
  render();
  load();
}
