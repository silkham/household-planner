// ============================================================================
//  recurring.js — Emma phase 1c: recurring-payment detection → one-tap link.
//  The BACKWARD-looking Emma feed (Spending 1b) tells us where money went; this
//  turns the repeating parts of it into FORWARD-looking `recurring_flows` — the
//  only thing that actually feeds the cashflow engine.
//
//  `detectRecurring` is a pure, testable function (see tests/recurring.tests.js).
//  Everything below it is the Finances-tab section that surfaces suggestions and
//  hands a pre-filled record to the recurring-flow sheet for confirm-before-save.
// ============================================================================
import { state } from "./store.js";
import { fetchEmma } from "./emma.js";
import { fmtGBP, fmtMonth } from "./sheet.js";
import { buildExcludedSet } from "./categories.js";

// Fallback non-counting categories when the caller passes no excluded set (keeps
// detectRecurring pure + testable). Managed categories override this at runtime.
const DEFAULT_EXCLUDED = new Set(["Excluded", "Transfers"]);

// ---- detection tuning ------------------------------------------------------
const MIN_OCCURRENCES = 3;   // need this many charges to trust a pattern
const MIN_MONTHS      = 3;   // …spread across at least this many calendar months
const GAP_MIN_DAYS    = 20;  // median gap between charges must look monthly-ish
const GAP_MAX_DAYS    = 45;
const PER_MONTH_MAX   = 1.6; // occurrences ≤ months×this → ~one charge/month (drops groceries)
const STALE_DAYS      = 45;  // last charge older than this vs feed end = likely cancelled
const VARY_THRESHOLD  = 0.25;// (max−min)/median above this → flag "amount varies"

// ---- pure helpers ----------------------------------------------------------
const mkey = (t) => t.customName || t.merchant || t.counterparty || "Unknown";

function monthKey(dateInt) {
  if (!dateInt) return null;
  const y = Math.floor(dateInt / 10000);
  const m = Math.floor((dateInt % 10000) / 100);
  return `${y}-${String(m).padStart(2, "0")}`;
}
// yyyymmdd int → integer day number (for gap arithmetic)
function epochDay(dateInt) {
  const y = Math.floor(dateInt / 10000);
  const m = Math.floor((dateInt % 10000) / 100);
  const d = dateInt % 100;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- the detector (pure) ---------------------------------------------------
// txns: Emma feed rows { dateInt, amount(signed), category, customName, ... }.
// opts.rules: Map<merchantKey, category> override (same as Spending).
// opts.excluded: Set of category names that don't count (default {Excluded, Transfers}).
// opts.existingKeys / opts.dismissed: Sets of merchant keys to suppress.
// opts.maxDate: yyyymmdd int treated as "today" (defaults to the feed's newest).
// Returns suggestion objects sorted by monthly amount, largest first.
export function detectRecurring(txns, opts = {}) {
  const rules = opts.rules || new Map();
  const excluded = opts.excluded || DEFAULT_EXCLUDED;
  const existing = opts.existingKeys || new Set();
  const dismissed = opts.dismissed || new Set();
  const feedMax = opts.maxDate ||
    txns.reduce((m, t) => Math.max(m, t.dateInt || 0), 0);

  // group by merchant + direction (a merchant is usually all-in or all-out)
  const groups = new Map();
  for (const t of txns) {
    if (!t.dateInt || !t.amount) continue;
    // rule override matches any identity field (see categories.js). Unmapped →
    // "Uncategorised"; only Emma's internal-money signals pass through from raw.
    const l = (t.category || "").toLowerCase();
    const passThrough = l === "excluded" ? "Excluded"
      : (l === "transfer" || l === "transfers") ? "Transfers" : null;
    const cat = (t.customName && rules.get(t.customName))
      || (t.merchant && rules.get(t.merchant))
      || (t.counterparty && rules.get(t.counterparty))
      || passThrough || "Uncategorised";
    if (excluded.has(cat)) continue;
    const dir = t.amount < 0 ? "out" : "in";
    const gk = mkey(t) + "\u0000" + dir;
    if (!groups.has(gk)) groups.set(gk, { key: mkey(t), dir, rows: [] });
    groups.get(gk).rows.push(t);
  }

  const out = [];
  for (const g of groups.values()) {
    if (g.rows.length < MIN_OCCURRENCES) continue;
    if (existing.has(g.key) || dismissed.has(g.key)) continue;

    const rows = g.rows.slice().sort((a, b) => a.dateInt - b.dateInt);
    const months = new Set(rows.map((r) => monthKey(r.dateInt)));
    if (months.size < MIN_MONTHS) continue;
    if (rows.length > months.size * PER_MONTH_MAX) continue; // too bursty for one bill

    const days = rows.map((r) => epochDay(r.dateInt));
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
    const medGap = median(gaps);
    if (medGap < GAP_MIN_DAYS || medGap > GAP_MAX_DAYS) continue;

    const last = rows[rows.length - 1];
    if (epochDay(feedMax) - epochDay(last.dateInt) > STALE_DAYS) continue; // gone quiet

    const mags = rows.map((r) => Math.abs(r.amount));
    const amount = Math.round(median(mags) * 100) / 100;
    const spread = amount ? (Math.max(...mags) - Math.min(...mags)) / amount : 0;

    out.push({
      key: g.key,
      kind: g.dir === "out" ? "expense" : "income",
      category: rules.get(g.key) || last.category || "",
      amount,
      count: rows.length,
      months: months.size,
      firstMonth: monthKey(rows[0].dateInt),
      lastMonth: monthKey(last.dateInt),
      avgGapDays: Math.round(medGap),
      amountVaries: spread > VARY_THRESHOLD,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// ---- Emma category → our recurring-flow category (best effort) --------------
const FLOW_CATS = new Set(["Salary","Housing","Childcare","Vehicle","Utilities","Groceries","Loan","Other"]);
const EMMA_TO_FLOWCAT = {
  Salary: "Salary", Income: "Salary", Wages: "Salary",
  Bills: "Utilities", Utilities: "Utilities", "Bills & Utilities": "Utilities",
  Rent: "Housing", Mortgage: "Housing", Home: "Housing", Housing: "Housing",
  Transport: "Vehicle", Car: "Vehicle", Fuel: "Vehicle",
  Childcare: "Childcare", Kids: "Childcare", Family: "Childcare",
  Loan: "Loan", Finance: "Loan", Debt: "Loan",
  Groceries: "Groceries", Shopping: "Groceries", Supermarket: "Groceries",
};
const toFlowCat = (c) => EMMA_TO_FLOWCAT[c] || (FLOW_CATS.has(c) ? c : "Other");

// ============================================================================
//  Finances-tab section — self-managed (own feed cache + lazy fetch).
//  mountDetected() is called by finances.render() on every store emit, so it
//  recomputes against the latest recurring_flows and re-renders in place.
// ============================================================================
let feed = null;        // cached Emma feed (null = not fetched)
let loading = false;
let loadErr = null;
let suggestions = [];
let onFlow = null;      // callback: (record, onDone) => open the confirm sheet

const DISMISS_LS = "hp-recurring-dismissed";
const loadDismissed = () => {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_LS) || "[]")); }
  catch { return new Set(); }
};
const saveDismissed = (set) =>
  localStorage.setItem(DISMISS_LS, JSON.stringify([...set]));

const emmaConfigured = () => !!(state.settings && state.settings.emma_sheet_id);
const currentMonth = () => new Date().toISOString().slice(0, 7);

function computeSuggestions() {
  if (!feed) return [];
  const existingKeys = new Set(
    state.recurring_flows.map((f) => f.emma_match_key).filter(Boolean));
  const rules = new Map(state.category_rules.map((r) => [r.match_key, r.category]));
  return detectRecurring(feed.txns, {
    existingKeys, dismissed: loadDismissed(), rules,
    excluded: buildExcludedSet(state.categories),
  });
}

async function load() {
  loading = true; loadErr = null; renderInto();
  try {
    feed = await fetchEmma();
    suggestions = computeSuggestions();
  } catch (e) {
    loadErr = e.message || String(e);
  } finally {
    loading = false;
    renderInto();
  }
}

function card(s) {
  const tint = s.kind === "income" ? "mint" : "coral";
  const vary = s.amountVaries
    ? `<span class="rd-vary"><i data-lucide="wave-sine"></i>varies</span>` : "";
  return `<div class="rd-card">
    <div class="rd-main">
      <div class="rd-name">${s.key}</div>
      <div class="rd-meta">seen ${s.count}× since ${fmtMonth(s.firstMonth)} · every ~${s.avgGapDays}d ${vary}</div>
    </div>
    <div class="rd-right">
      <span class="rd-amt" style="color:var(--${tint})">${s.kind === "income" ? "+" : "−"}${fmtGBP(s.amount)}/mo</span>
      <div class="rd-actions">
        <button class="rd-add" data-add="${encodeURIComponent(s.key)}"><i data-lucide="plus"></i>Add</button>
        <button class="rd-dismiss" data-dismiss="${encodeURIComponent(s.key)}" title="Not recurring"><i data-lucide="x"></i></button>
      </div>
    </div>
  </div>`;
}

function renderInto() {
  const root = document.getElementById("recurring-detect");
  if (!root) return;

  // Hidden entirely unless Emma is configured (keeps Finances clean otherwise).
  if (!emmaConfigured()) { root.innerHTML = ""; return; }

  let body;
  if (loadErr) {
    body = `<div class="sec-empty">Couldn't scan Emma: ${loadErr}
      <br><button class="rd-load" data-retry>Try again</button></div>`;
  } else if (feed == null) {
    body = loading
      ? `<div class="sec-empty">Scanning Emma for recurring payments…</div>`
      : `<div class="sec-empty"><button class="rd-load" data-retry>Scan Emma for recurring payments</button></div>`;
  } else if (!suggestions.length) {
    // nothing new to suggest — collapse the section to nothing
    root.innerHTML = ""; return;
  } else {
    body = suggestions.map(card).join("");
  }

  root.innerHTML = `<section class="fsection">
    <div class="sec-head">
      <div><div class="eyebrow">Detected recurring</div>
        <p class="sec-sub">Repeating payments spotted in Emma. Add the ones that should shape the forecast.</p></div>
    </div>
    <div class="sec-body rd-body">${body}</div>
  </section>`;

  root.querySelectorAll("[data-retry]").forEach((b) => b.onclick = () => load());
  root.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
    const key = decodeURIComponent(b.dataset.add);
    const s = suggestions.find((x) => x.key === key);
    if (s && onFlow) onFlow(recordFrom(s), () => renderInto());
  });
  root.querySelectorAll("[data-dismiss]").forEach((b) => b.onclick = () => {
    const key = decodeURIComponent(b.dataset.dismiss);
    const d = loadDismissed(); d.add(key); saveDismissed(d);
    suggestions = suggestions.filter((x) => x.key !== key);
    renderInto();
  });
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

function recordFrom(s) {
  return {
    name: s.key,
    kind: s.kind,
    amount: s.amount,
    category: toFlowCat(s.category),
    start_month: currentMonth(),
    emma_match_key: s.key,
    notes: `Detected from Emma · seen ${s.count}× since ${fmtMonth(s.firstMonth)}`,
  };
}

// Called by finances.render() every time it rebuilds the tab.
export function mountDetected(openFlowSheet) {
  onFlow = openFlowSheet;
  if (feed) suggestions = computeSuggestions();  // reflect any new flows
  renderInto();
  if (feed == null && !loading && emmaConfigured()) load();  // lazy first scan
}
