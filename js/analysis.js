// ============================================================================
//  analysis.js — the Analysis screen (V2 step 4, Spend group).
//  The decision workspace: sort your spend into Keep / Review / Kill, then dig
//  into the ones you're unsure about. Two kinds of thing carry a decision —
//    · fixed commitments  (recurring_flows.decision) — annualised via annualCost
//    · variable buckets   (categories.decision)      — actual £/mo from the feed
//  Review rows drill into the merchant detail (bars + txns) so you can see the
//  real spend pattern before deciding. Reuses the shared Emma feed, category
//  logic, reportCategories/annualCost, and the merchant detail from Merchants.
//  Nothing pure here — presentation only; no engine/schema logic.
// ============================================================================
import { state, subscribe, saveRow } from "./store.js";
import { fetchEmma, cachedEmmaTxns } from "./emma.js";
import { fmtGBP } from "./sheet.js";
import { buildExcludedSet } from "./categories.js";
import { reportCategories, annualCost } from "./reports.js";
import { rankMerchants, merchantDetailHtml } from "./merchants.js";
import { categorise } from "./spending.js";

// ---- module state ----------------------------------------------------------
let txns = null;          // memoised feed (null = not loaded)
let loading = false;
let loadErr = null;
let monthsBack = 6;       // window for category £ figures (null = all)
let selCat = null;        // drill into a category's merchants
let selMerchant = null;   // drill into one merchant (bars + txns)

const PERIODS = [[3, "3m"], [6, "6m"], [12, "12m"], [null, "All"]];
const DEC = [["keep", "Keep"], ["review", "Review"], ["kill", "Kill"]];

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

// ---- build the decision list ----------------------------------------------
// Merge fixed commitments (flows) + variable buckets (categories) into one list
// of items keyed by decision. A category is only shown if it has spend in the
// window or an explicit decision (keeps the triage list relevant).
function buildItems() {
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);
  const { rows } = reportCategories(txns || [], { rules, excluded, monthsBack, endInt: feedEndInt() });
  const spend = new Map(rows.map((r) => [r.category, r]));  // category → {avg,total,byMonth,…}

  const items = [];
  for (const f of state.recurring_flows) {
    if (f.kind !== "expense") continue;
    const yr = annualCost(f);
    if (yr <= 0) continue;
    items.push({ type: "flow", id: f.id, ref: f, name: f.name, cat: f.category || "",
                 decision: f.decision || null, annual: yr, mkey: f.emma_match_key || null });
  }
  for (const c of state.categories) {
    if (c.counts_as_spend === false) continue;          // non-counting buckets aren't spend to cut
    const r = spend.get(c.name);
    const annual = r ? r.avg * 12 : 0;
    if (annual <= 0 && !c.decision) continue;
    items.push({ type: "category", id: c.id, ref: c, name: c.name, cat: "",
                 decision: c.decision || null, annual, spendRow: r });
  }
  return items;
}

// ---- rows ------------------------------------------------------------------
function decButtons(item) {
  return `<div class="an-dec" data-id="${item.id}" data-kind="${item.type}" data-name="${enc(item.name)}">
    ${DEC.map(([v, l]) => `<button data-set="${v}" class="an-decb d-${v}${item.decision === v ? " on" : ""}">${l}</button>`).join("")}
  </div>`;
}

function itemRow(item) {
  const isCat = item.type === "category";
  const drillable = isCat || item.mkey;   // categories always drill; flows drill if Emma-linked
  const typeChip = isCat ? `<span class="an-chip cat">bucket</span>` : `<span class="an-chip flow">${item.cat || "commitment"}</span>`;
  const yr = item.annual;
  const nameCell = drillable
    ? `<button class="an-name drill" data-drillcat="${isCat ? enc(item.name) : ""}" data-drillm="${item.mkey ? enc(item.mkey) : ""}">${item.name}<i data-lucide="chevron-right"></i></button>`
    : `<span class="an-name">${item.name}</span>`;
  return `<div class="an-row">
    ${nameCell}
    ${typeChip}
    <span class="an-yr">${fmtGBP(yr)}/yr<small>${fmtGBP(yr / 12)}/mo</small></span>
    ${decButtons(item)}
  </div>`;
}

function section(title, list, { sub = "", muted = false } = {}) {
  if (!list.length) return "";
  const tot = list.reduce((s, i) => s + i.annual, 0);
  return `<div class="an-sec${muted ? " muted" : ""}">
    <div class="an-sec-head"><h2>${title}</h2>
      <span class="an-sec-tot">${fmtGBP(tot)}/yr${sub ? ` · ${sub}` : ""}</span></div>
    <div class="an-list">${list.map(itemRow).join("")}</div>
  </div>`;
}

// ---- drill-downs (reuse Merchants' views) ----------------------------------
function merchantList(cat, rules, excluded) {
  const { months, rows } = rankMerchants(txns, { rules, excluded, monthsBack, endInt: feedEndInt() });
  const mine = rows.filter((r) => r.category === cat);
  const total = mine.reduce((s, r) => s + r.total, 0);
  const list = mine.map((r) => `<button class="mc-row" data-mkey="${enc(r.key)}">
    <span class="mc-name">${r.key}</span>
    <span class="mc-total">${fmtGBP(r.total)}</span>
    <span class="mc-count">${r.count}×</span>
  </button>`).join("");
  return `<button class="mc-back" data-back><i data-lucide="arrow-left"></i>Back</button>
    <div class="mc-dhead"><div><h2 class="mc-dname">${cat}</h2>
      <p class="sec-sub">${mine.length} merchant${mine.length === 1 ? "" : "s"} · ${fmtGBP(total)}${monthsBack ? ` in ${monthsBack}m` : ""}</p></div></div>
    ${mine.length ? `<div class="mc-list">${list}</div>` : `<div class="sec-empty">No merchants in this window.</div>`}`;
}

function body() {
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);
  if (selMerchant) return merchantDetailHtml(txns, selMerchant, rules, { backLabel: selCat || "Back" });
  if (selCat) return merchantList(selCat, rules, excluded);

  const items = buildItems();
  const by = (d) => items.filter((i) => i.decision === d).sort((a, b) => b.annual - a.annual);
  const kill = by("kill"), review = by("review"), keep = by("keep");
  const undecided = items.filter((i) => !i.decision).sort((a, b) => b.annual - a.annual);

  const controls = `<div class="mc-controls">
    <div class="mc-seg" data-seg="period">
      ${PERIODS.map(([v, l]) => `<button data-period="${v == null ? "" : v}" class="${monthsBack === v ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <span class="an-hint">Buckets use £/mo over the window · commitments are annualised.</span>
  </div>`;

  if (!items.length)
    return controls + `<div class="sec-empty">Nothing to analyse yet — tag flows in Finances or categories in the Categories page, or add spend.</div>`;

  const killTot = kill.reduce((s, i) => s + i.annual, 0);
  return controls
    + section("Kill", kill, { sub: killTot > 0 ? `save ${fmtGBP(killTot)}/yr` : "" })
    + section("Review", review, { sub: "dig into these" })
    + (undecided.length ? `<div class="an-sec">
        <div class="an-sec-head"><h2>Undecided</h2><span class="an-sec-tot">${undecided.length} to triage</span></div>
        <div class="an-list">${undecided.map(itemRow).join("")}</div></div>` : "")
    + section("Keep", keep, { muted: true });
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("analysis-root");
  if (!root) return;

  const head = `<div class="mc-top">
    <div><div class="eyebrow">Analysis</div>
      <p class="sec-sub">Keep, review or kill — sort the spending, dig into the doubts.</p></div>
    <button class="sec-sync" data-refresh ${loading ? "disabled" : ""}>
      <i data-lucide="refresh-cw"></i>${loading ? "Loading…" : "Refresh"}</button>
  </div>`;

  let main;
  if (loadErr) main = `<div class="sec-empty">Couldn't load Emma: ${loadErr}<br><button class="sp-load" data-refresh>Try again</button></div>`;
  else if (txns == null) main = `<div class="sec-empty">${loading ? "Loading spending…" : `<button class="sp-load" data-refresh>Load from Emma</button>`}</div>`;
  else main = body();

  root.innerHTML = head + main;

  root.querySelectorAll("[data-refresh]").forEach((b) => b.onclick = () => load(true));
  root.querySelectorAll("[data-period]").forEach((b) => b.onclick = () => {
    monthsBack = b.dataset.period === "" ? null : +b.dataset.period; render();
  });
  // drill: category name → merchant list; Emma-linked flow → merchant detail
  root.querySelectorAll(".an-name.drill").forEach((b) => b.onclick = () => {
    const c = b.dataset.drillcat, m = b.dataset.drillm;
    if (c) selCat = decodeURIComponent(c);
    else if (m) { selMerchant = decodeURIComponent(m); }
    render();
  });
  // merchant row inside a category drill → merchant detail
  root.querySelectorAll(".mc-row[data-mkey]").forEach((b) => b.onclick = () => { selMerchant = decodeURIComponent(b.dataset.mkey); render(); });
  root.querySelectorAll("[data-back]").forEach((b) => b.onclick = () => {
    if (selMerchant) selMerchant = null; else selCat = null; render();
  });
  // re-file from the merchant detail
  root.querySelectorAll(".mc-tx, .mc-refile").forEach((b) => b.onclick = () =>
    categorise(decodeURIComponent(b.dataset.key), decodeURIComponent(b.dataset.cat), cachedEmmaTxns(), render));
  // inline decision setter
  root.querySelectorAll(".an-dec").forEach((grp) => grp.querySelectorAll("[data-set]").forEach((b) => b.onclick = async () => {
    const cur = b.classList.contains("on");
    const value = cur ? null : b.dataset.set;   // tapping the active one clears it
    const kind = grp.dataset.kind, id = grp.dataset.id, name = decodeURIComponent(grp.dataset.name);
    try {
      if (kind === "flow") await saveRow("recurring_flows", { id, decision: value });
      else await saveRow("categories", { id, name, decision: value });
    } catch (e) { alert("Couldn't save decision: " + e.message); }
  }));

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountAnalysis() {
  subscribe(render);
  render();
  load();
}
