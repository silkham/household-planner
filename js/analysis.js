// ============================================================================
//  analysis.js — the Analysis screen (V2 step 4, Spend group).
//  The decision workspace: sort your spend into Keep / Review / Kill, then dig
//  into the ones you're unsure about. Decisions are per-MERCHANT now (not per
//  category, not per flow) — stored on category_rules.decision, keyed on the
//  merchant's match_key. Every merchant with spend in the window is triageable;
//  tap a merchant to see its bars + transactions before deciding.
//  Reuses the shared Emma feed, category logic, rankMerchants, and the merchant
//  detail from Merchants. Nothing pure here — presentation only.
// ============================================================================
import { state, subscribe, saveMerchantDecision } from "./store.js";
import { fetchEmma, cachedEmmaTxns } from "./emma.js";
import { fmtGBP } from "./sheet.js";
import { buildExcludedSet } from "./categories.js";
import { rankMerchants, merchantDetailHtml } from "./merchants.js";
import { categorise } from "./spending.js";

// ---- module state ----------------------------------------------------------
let txns = null;          // memoised feed (null = not loaded)
let loading = false;
let loadErr = null;
let monthsBack = 6;       // window for merchant spend (null = all)
let selMerchant = null;   // drill into one merchant (bars + txns)
let showKept = false;     // reveal the "Keep" pile (off the triage list by default)

const UNDECIDED_CAP = 40; // triage list stays a shortlist, not the whole feed
const PERIODS = [[3, "3m"], [6, "6m"], [12, "12m"], [null, "All"]];
const DEC = [["keep", "Keep"], ["review", "Review"], ["kill", "Kill"]];

const rulesMap = () => new Map(state.category_rules.map((r) => [r.match_key, r.category]));
// merchant → decision (keyed on the same match_key rankMerchants uses as its key)
const decisionMap = () => {
  const m = new Map();
  for (const r of state.category_rules) if (r.decision) m.set(r.match_key, r.decision);
  return m;
};
const feedEndInt = () => (txns || []).reduce((m, t) => (t.dateInt && t.dateInt > m ? t.dateInt : m), 0) || null;
const enc = (s) => encodeURIComponent(s);

async function load(force = false) {
  if (loading || (txns && !force)) return;
  loading = true; loadErr = null; render();
  try { txns = (await fetchEmma(force)).txns || []; }
  catch (e) { loadErr = e.message || String(e); }
  finally { loading = false; render(); }
}

// ---- build the merchant list ----------------------------------------------
// Every merchant with spend in the window, carrying its current decision and a
// per-month figure (avg/mo → annualised) so the Kill pile can total "save £X/yr".
function buildItems() {
  const rules = rulesMap();
  const decs = decisionMap();
  const excluded = buildExcludedSet(state.categories);
  const { rows } = rankMerchants(txns || [], { rules, excluded, monthsBack, endInt: feedEndInt() });
  const perMo = (total) => (monthsBack ? total / monthsBack : 0);   // no /mo figure for "All"
  return rows.map((r) => ({
    key: r.key, name: r.key, cat: r.category, total: r.total,
    monthly: perMo(r.total), annual: perMo(r.total) * 12,
    decision: decs.get(r.key) || null,
  }));
}

// ---- rows ------------------------------------------------------------------
function decButtons(item) {
  return `<div class="an-dec" data-mkey="${enc(item.key)}" data-cat="${enc(item.cat)}">
    ${DEC.map(([v, l]) => `<button data-set="${v}" class="an-decb d-${v}${item.decision === v ? " on" : ""}">${l}</button>`).join("")}
  </div>`;
}

function itemRow(item) {
  const figure = monthsBack
    ? `${fmtGBP(item.total)}<small>${fmtGBP(item.monthly)}/mo</small>`
    : `${fmtGBP(item.total)}<small>all time</small>`;
  return `<div class="an-row">
    <button class="an-name drill" data-drillm="${enc(item.key)}">${item.name}<i data-lucide="chevron-right"></i></button>
    <span class="an-chip cat">${item.cat}</span>
    <span class="an-yr">${figure}</span>
    ${decButtons(item)}
  </div>`;
}

function section(title, list, { sub = "", muted = false } = {}) {
  if (!list.length) return "";
  return `<div class="an-sec${muted ? " muted" : ""}">
    <div class="an-sec-head"><h2>${title}</h2>
      ${sub ? `<span class="an-sec-tot">${sub}</span>` : ""}</div>
    <div class="an-list">${list.map(itemRow).join("")}</div>
  </div>`;
}

// ---- main body -------------------------------------------------------------
function body() {
  const rules = rulesMap();
  if (selMerchant) return merchantDetailHtml(txns, selMerchant, rules, { backLabel: "Analysis" });

  const items = buildItems();
  const by = (d) => items.filter((i) => i.decision === d).sort((a, b) => b.total - a.total);
  const kill = by("kill"), review = by("review"), keep = by("keep");
  const undecidedAll = items.filter((i) => !i.decision).sort((a, b) => b.total - a.total);
  const undecided = undecidedAll.slice(0, UNDECIDED_CAP);

  const controls = `<div class="mc-controls">
    <div class="mc-seg" data-seg="period">
      ${PERIODS.map(([v, l]) => `<button data-period="${v == null ? "" : v}" class="${monthsBack === v ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <span class="an-hint">Spend by merchant over the window · decide Keep / Review / Kill.</span>
  </div>`;

  if (!items.length)
    return controls + `<div class="sec-empty">No spending in this window to analyse.</div>`;

  const killYr = kill.reduce((s, i) => s + i.annual, 0);
  const undecidedTail = undecidedAll.length > UNDECIDED_CAP
    ? `<p class="muted an-more">+ ${undecidedAll.length - UNDECIDED_CAP} smaller merchants — narrow the window or decide the big ones first.</p>`
    : "";

  // Keep pile is OFF the triage list — collapsed to a toggle by default.
  const keptYr = keep.reduce((s, i) => s + i.annual, 0);
  const keptBlock = keep.length
    ? `<div class="an-sec muted">
        <button class="an-kept-toggle" data-togglekept>
          <i data-lucide="${showKept ? "chevron-down" : "chevron-right"}"></i>
          Keep — off your list (${keep.length}${monthsBack ? ` · ${fmtGBP(keptYr)}/yr` : ""})</button>
        ${showKept ? `<div class="an-list">${keep.map(itemRow).join("")}</div>` : ""}
      </div>`
    : "";

  return controls
    + section("Kill", kill, { sub: monthsBack && killYr > 0 ? `save ${fmtGBP(killYr)}/yr` : "" })
    + section("Review", review, { sub: review.length ? "dig into these" : "" })
    + (undecided.length ? `<div class="an-sec">
        <div class="an-sec-head"><h2>Undecided</h2><span class="an-sec-tot">${undecidedAll.length} to triage</span></div>
        <div class="an-list">${undecided.map(itemRow).join("")}</div>${undecidedTail}</div>` : "")
    + keptBlock;
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("analysis-root");
  if (!root) return;

  const head = `<div class="mc-top">
    <div><div class="eyebrow">Analysis</div>
      <p class="sec-sub">Keep, review or kill — merchant by merchant.</p></div>
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
  root.querySelectorAll("[data-togglekept]").forEach((b) => b.onclick = () => { showKept = !showKept; render(); });
  // drill: merchant name → merchant detail (bars + txns)
  root.querySelectorAll(".an-name.drill").forEach((b) => b.onclick = () => {
    selMerchant = decodeURIComponent(b.dataset.drillm); render();
  });
  root.querySelectorAll("[data-back]").forEach((b) => b.onclick = () => { selMerchant = null; render(); });
  // re-file from the merchant detail
  root.querySelectorAll(".mc-tx, .mc-refile").forEach((b) => b.onclick = () =>
    categorise(decodeURIComponent(b.dataset.key), decodeURIComponent(b.dataset.cat), cachedEmmaTxns(), render));
  // inline decision setter — writes category_rules.decision on the merchant
  root.querySelectorAll(".an-dec").forEach((grp) => grp.querySelectorAll("[data-set]").forEach((b) => b.onclick = async () => {
    const value = b.classList.contains("on") ? null : b.dataset.set;   // tap the active one to clear
    const mkey = decodeURIComponent(grp.dataset.mkey), cat = decodeURIComponent(grp.dataset.cat);
    try { await saveMerchantDecision(mkey, cat, value); }
    catch (e) { alert("Couldn't save decision: " + e.message); }
  }));

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountAnalysis() {
  subscribe(render);
  render();
  load();
}
