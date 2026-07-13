// ============================================================================
//  merchants.js — the Merchants tab (V2 step 3).
//  Who you pay, ranked by spend, with change-over-time, plus the home for
//  all-transaction browsing (filter + sort). Reads the SAME memoised Emma feed
//  as Spending; re-uses the shared category logic and the Spending categorise
//  sheet, so nothing here duplicates txn/category behaviour.
//
//  `rankMerchants` is a PURE, import-free core (bundled by tests/run.sh) — it
//  replicates effectiveCategory inline for the same reason reconcile/recurring
//  do (the JavaScriptCore runner can't resolve ES imports).
// ============================================================================
import { state, subscribe } from "./store.js";
import { fetchEmma, cachedEmmaTxns } from "./emma.js";
import { fmtGBP } from "./sheet.js";
import { buildExcludedSet, categoryNames, effectiveCategory, txnKey } from "./categories.js";
import { categorise } from "./spending.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ordLabel = (o) => `${MON[o % 12]} '${String(Math.floor(o / 12)).slice(2)}`;

// ---- PURE aggregation core -------------------------------------------------
// Rank merchants by spend within a rolling window and compare to the prior
// equal-length window. Import-free so tests/run.sh can bundle it directly.
//   opts.rules      Map<match_key, category>
//   opts.excluded   Set of non-counting category names
//   opts.monthsBack window length in months (null = all history, no comparison)
//   opts.endInt     yyyymmdd of the feed's newest txn (window anchor)
// → { months:[ord…], rows:[{key,category,total,count,prev,delta,deltaPct,byMonth}] }
export function rankMerchants(txns = [], opts = {}) {
  const { rules = new Map(), excluded = new Set(["Excluded", "Transfers"]),
          monthsBack = null, endInt = null } = opts;

  const passThrough = (c) => {
    const l = (c || "").toLowerCase();
    if (l === "excluded") return "Excluded";
    if (l === "transfer" || l === "transfers") return "Transfers";
    return null;
  };
  const key = (t) => t.customName || t.merchant || t.counterparty || "Unknown";
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
  for (const t of txns) {
    if (t.amount >= 0) continue;                 // spend = outflow only
    const cat = effCat(t);
    if (excluded.has(cat)) continue;
    const o = ordOf(t.dateInt);
    if (o == null) continue;
    const inCur = hasWin ? (o >= curStart && o <= endOrd) : true;
    const inPrev = hasWin && o >= prevStart && o <= prevEnd;
    if (!inCur && !inPrev) continue;
    const k = key(t);
    let r = rows.get(k);
    if (!r) { r = { key: k, category: cat, total: 0, count: 0, prev: 0, byMonth: {} }; rows.set(k, r); }
    const amt = -t.amount;
    if (inCur) { r.total += amt; r.count += 1; r.category = cat; r.byMonth[o] = (r.byMonth[o] || 0) + amt; }
    if (inPrev) r.prev += amt;
  }

  const out = [...rows.values()]
    .filter((r) => r.total > 0)
    .map((r) => ({ ...r, delta: r.total - r.prev,
                   deltaPct: r.prev > 0 ? (r.total - r.prev) / r.prev : null }))
    .sort((a, b) => b.total - a.total);
  return { months, rows: out };
}

// ---- module state ----------------------------------------------------------
let txns = null;          // cached feed (null = not loaded)
let loading = false;
let loadErr = null;
let view = "merchants";   // "merchants" | "transactions"
let monthsBack = 6;       // null = all history
let catFilter = "";       // effective-category filter ('' = all)
let searchQ = "";
let sortTx = "date";      // date | amount | name (transactions view)
let selMerchant = null;   // drill-down merchant key (merchants view)

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

// tiny sparkline over the window months
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
  if (monthsBack == null) return "";           // no comparison window
  if (r.prev <= 0) return `<span class="mc-delta new">new</span>`;
  const up = r.delta > 0;
  const label = r.deltaPct != null ? `${Math.abs(Math.round(r.deltaPct * 100))}%` : fmtGBP(Math.abs(r.delta));
  return `<span class="mc-delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${label}</span>`;
}

// ---- merchants view --------------------------------------------------------
function merchantsBody() {
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);
  const { months, rows } = rankMerchants(txns, { rules, excluded, monthsBack, endInt: feedEndInt() });

  if (selMerchant) return merchantDetail(selMerchant, rules);

  const q = searchQ.trim().toLowerCase();
  const filtered = rows.filter((r) =>
    (!catFilter || r.category.toLowerCase() === catFilter.toLowerCase()) &&
    (!q || r.key.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)));

  const catOptions = categoryNames(state.categories, txns || [], rules)
    .filter((n) => !excluded.has(n))
    .map((n) => `<option value="${n}" ${catFilter === n ? "selected" : ""}>${n}</option>`).join("");

  const controls = `<div class="mc-controls">
    <div class="mc-seg" data-seg="period">
      ${PERIODS.map(([v, l]) => `<button data-period="${v == null ? "" : v}" class="${monthsBack === v ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <select class="field mc-catsel" id="mc-cat"><option value="">All categories</option>${catOptions}</select>
  </div>
  <div class="mc-search"><i data-lucide="search"></i>
    <input id="mc-search" type="text" placeholder="Search merchants…" value="${searchQ.replace(/"/g, "&quot;")}" autocomplete="off">
    ${searchQ ? `<button class="mc-srch-clr" data-srch-clr aria-label="Clear"><i data-lucide="x"></i></button>` : ""}
  </div>`;

  if (!filtered.length)
    return controls + `<div class="sec-empty">No merchants match.</div>`;

  const total = filtered.reduce((s, r) => s + r.total, 0);
  const summary = `<div class="mc-summary">${filtered.length} merchant${filtered.length === 1 ? "" : "s"} · ${fmtGBP(total)}${monthsBack ? ` in ${monthsBack}m` : ""}</div>`;

  const list = filtered.map((r) => `<button class="mc-row" data-mkey="${enc(r.key)}">
    <span class="mc-name">${r.key}</span>
    <span class="mc-cat">${r.category}</span>
    ${spark(r.byMonth, months)}
    ${deltaChip(r)}
    <span class="mc-total">${fmtGBP(r.total)}</span>
    <span class="mc-count">${r.count}×</span>
  </button>`).join("");

  return controls + summary + `<div class="mc-list">${list}</div>`;
}

function merchantDetail(key, rules) {
  const mine = (txns || []).filter((t) => txnKey(t) === key)
    .sort((a, b) => (b.dateInt || 0) - (a.dateInt || 0));
  const cat = mine.length ? effectiveCategory(mine[0], rules) : "Uncategorised";
  const payments = mine.filter((t) => t.amount < 0).length;

  // monthly outflow bars across every month this merchant appears
  const byMonth = new Map();
  for (const t of mine) {
    if (t.amount >= 0 || !t.dateInt) continue;
    const o = Math.floor(t.dateInt / 10000) * 12 + (Math.floor((t.dateInt % 10000) / 100) - 1);
    byMonth.set(o, (byMonth.get(o) || 0) + -t.amount);
  }
  const ords = [...byMonth.keys()].sort((a, b) => a - b);
  const max = Math.max(1, ...byMonth.values());
  const bars = ords.map((o) => {
    const v = byMonth.get(o);
    return `<div class="mc-bar" title="${ordLabel(o)} · ${fmtGBP(v)}"><div class="mc-bar-fill" style="height:${Math.max(3, (v / max) * 100)}%"></div>
      <span class="mc-bar-lbl">${MON[o % 12]}</span></div>`;
  }).join("");
  const totalOut = [...byMonth.values()].reduce((s, v) => s + v, 0);

  const rows = mine.map((t) => {
    const inflow = t.amount > 0;
    return `<button class="mc-tx" data-key="${enc(key)}" data-cat="${enc(cat)}">
      <span class="mc-tx-date">${t.date || ""}</span>
      <span class="mc-tx-cat">${effectiveCategory(t, rules)}</span>
      <span class="mc-tx-amt ${inflow ? "in" : ""}">${inflow ? "+" : ""}${fmtGBP(Math.abs(t.amount))}</span>
    </button>`;
  }).join("");

  return `<button class="mc-back" data-back><i data-lucide="arrow-left"></i>All merchants</button>
    <div class="mc-dhead">
      <div><h2 class="mc-dname">${key}</h2>
        <p class="sec-sub">${cat} · ${fmtGBP(totalOut)} out · ${payments} payment${payments === 1 ? "" : "s"}</p></div>
      <button class="mc-refile" data-key="${enc(key)}" data-cat="${enc(cat)}"><i data-lucide="tag"></i>Re-file</button>
    </div>
    ${ords.length ? `<div class="mc-bars glass">${bars}</div>` : ""}
    <div class="mc-txlist">${rows}</div>`;
}

// ---- transactions view -----------------------------------------------------
function transactionsBody() {
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);
  const q = searchQ.trim().toLowerCase();

  let list = (txns || []).map((t) => ({ t, name: txnKey(t), cat: effectiveCategory(t, rules) }));
  if (catFilter) list = list.filter((x) => x.cat.toLowerCase() === catFilter.toLowerCase());
  if (q) list = list.filter((x) => {
    const hay = `${x.name} ${x.cat} ${x.t.date || ""} ${Math.abs(x.t.amount).toFixed(2)}`.toLowerCase();
    return hay.includes(q);
  });
  list.sort((a, b) =>
    sortTx === "amount" ? Math.abs(b.t.amount) - Math.abs(a.t.amount)
    : sortTx === "name" ? a.name.localeCompare(b.name)
    : (b.t.dateInt || 0) - (a.t.dateInt || 0));

  const catOptions = categoryNames(state.categories, txns || [], rules)
    .map((n) => `<option value="${n}" ${catFilter === n ? "selected" : ""}>${excluded.has(n) ? `${n} · off` : n}</option>`).join("");

  const controls = `<div class="mc-controls">
    <div class="mc-seg" data-seg="sort">
      ${[["date", "Date"], ["amount", "Amount"], ["name", "Name"]].map(([v, l]) =>
        `<button data-sort="${v}" class="${sortTx === v ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <select class="field mc-catsel" id="mc-cat"><option value="">All categories</option>${catOptions}</select>
  </div>
  <div class="mc-search"><i data-lucide="search"></i>
    <input id="mc-search" type="text" placeholder="Search all transactions — merchant, category, amount…" value="${searchQ.replace(/"/g, "&quot;")}" autocomplete="off">
    ${searchQ ? `<button class="mc-srch-clr" data-srch-clr aria-label="Clear"><i data-lucide="x"></i></button>` : ""}
  </div>`;

  const CAP = 150;
  const shown = list.slice(0, CAP);
  if (!list.length) return controls + `<div class="sec-empty">No transactions match.</div>`;
  const rows = shown.map(({ t, name, cat }) => {
    const off = excluded.has(cat);
    const inflow = t.amount > 0;
    return `<button class="mc-tx wide" data-key="${enc(name)}" data-cat="${enc(cat)}">
      <span class="mc-tx-name">${name}</span>
      <span class="mc-tx-cat ${off ? "off" : ""}">${cat}${off ? " · off" : ""}</span>
      <span class="mc-tx-date">${t.date || ""}</span>
      <span class="mc-tx-amt ${inflow ? "in" : ""}">${inflow ? "+" : ""}${fmtGBP(Math.abs(t.amount))}</span>
      <i data-lucide="tag"></i>
    </button>`;
  }).join("");
  const meta = `<div class="mc-summary">${list.length} transaction${list.length === 1 ? "" : "s"}${list.length > CAP ? ` · showing ${CAP}` : ""} · tap to re-file</div>`;
  return controls + meta + `<div class="mc-txlist">${rows}</div>`;
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("merchants-root");
  if (!root) return;

  const head = `<div class="mc-top">
    <div><div class="eyebrow">Merchants</div>
      <p class="sec-sub">Who you pay, and how much.</p></div>
    <button class="sec-sync" data-refresh ${loading ? "disabled" : ""}>
      <i data-lucide="refresh-cw"></i>${loading ? "Loading…" : "Refresh"}</button>
  </div>`;

  const tabs = (txns != null && !selMerchant) ? `<div class="mc-viewseg" data-seg="view">
    <button data-view="merchants" class="${view === "merchants" ? "on" : ""}">Merchants</button>
    <button data-view="transactions" class="${view === "transactions" ? "on" : ""}">All transactions</button>
  </div>` : "";

  let body;
  if (loadErr) body = `<div class="sec-empty">Couldn't load Emma: ${loadErr}<br><button class="sp-load" data-refresh>Try again</button></div>`;
  else if (txns == null) body = `<div class="sec-empty">${loading ? "Loading merchants…" : `<button class="sp-load" data-refresh>Load from Emma</button>`}</div>`;
  else body = view === "transactions" ? transactionsBody() : merchantsBody();

  root.innerHTML = head + tabs + body;

  // wiring
  root.querySelectorAll("[data-refresh]").forEach((b) => b.onclick = () => load(true));
  root.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => {
    view = b.dataset.view; selMerchant = null; searchQ = ""; render();
  });
  root.querySelectorAll("[data-period]").forEach((b) => b.onclick = () => {
    monthsBack = b.dataset.period === "" ? null : +b.dataset.period; render();
  });
  root.querySelectorAll("[data-sort]").forEach((b) => b.onclick = () => { sortTx = b.dataset.sort; render(); });
  root.querySelectorAll(".mc-row").forEach((b) => b.onclick = () => { selMerchant = decodeURIComponent(b.dataset.mkey); render(); });
  root.querySelectorAll("[data-back]").forEach((b) => b.onclick = () => { selMerchant = null; render(); });

  const catSel = root.querySelector("#mc-cat");
  if (catSel) catSel.onchange = () => { catFilter = catSel.value; render(); };

  const srch = root.querySelector("#mc-search");
  if (srch) srch.oninput = () => {
    searchQ = srch.value;
    const caret = srch.selectionStart;
    render();
    const again = document.getElementById("mc-search");
    if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch {} }
  };
  root.querySelectorAll("[data-srch-clr]").forEach((b) => b.onclick = () => {
    searchQ = ""; render(); const el = document.getElementById("mc-search"); if (el) el.focus();
  });

  // re-file → the shared Spending categorise sheet (pass the memoised feed so it
  // works even if Spending was never opened; re-render this tab on done)
  const refile = (b) => categorise(decodeURIComponent(b.dataset.key), decodeURIComponent(b.dataset.cat), cachedEmmaTxns(), render);
  root.querySelectorAll(".mc-tx, .mc-refile").forEach((b) => b.onclick = () => refile(b));

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountMerchants() {
  subscribe(render);   // re-render when category_rules (or anything) changes
  render();
  load();              // lazy first fetch, non-blocking
}
