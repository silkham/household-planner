// ============================================================================
//  categories.js — managed spend categories (Emma phase 1d).
//  "Counts as spend" is a per-category flag the household controls, replacing
//  the old hardcoded {Excluded, Transfers} skip. Emma's own categories still
//  flow through the feed; this layers flags + custom buckets on top. A category
//  counts as spend unless a managed row (or the safety default) says otherwise.
//
//  The pure helpers (buildExcludedSet / categoryNames) are shared by spending.js
//  and recurring detection so both agree on what counts.
// ============================================================================
import { state, saveRow, saveSettings, bulkReassignRules } from "./store.js";
import { openSheet, fmtGBP } from "./sheet.js";

// Non-counting unless a managed row explicitly flips them — Emma's own
// convention (Excluded) plus internal moves (Transfers).
export const DEFAULT_EXCLUDED = ["Excluded", "Transfers"];

// ---- shared transaction ↔ category matching (used everywhere) --------------
// Display/rule key for a transaction: Emma's cleaned merchant name preferred.
export const txnKey = (t) => t.customName || t.merchant || t.counterparty || "Unknown";

// A category_rules override for a transaction. Emma's Custom Name varies month
// to month for some merchants (Amazon, refunds…), so we match a rule against
// ANY of the transaction's identity fields — that's what makes a single re-tag
// stick across every month. `rules` is a Map<match_key, category>.
export function ruleCategory(t, rules) {
  return (t.customName && rules.get(t.customName))
      || (t.merchant && rules.get(t.merchant))
      || (t.counterparty && rules.get(t.counterparty))
      || null;
}
// Emma's internal-money signals are the ONLY categories we still trust from the
// raw feed when a merchant has no rule — normalised to our managed non-counting
// names (Emma writes "Transfer" singular). Everything else unmapped resolves to
// "Uncategorised" so Emma can't silently drop a NEW merchant into the wrong
// spend bucket — the household maps it deliberately (see the Spending prompt).
export function passThroughCategory(c) {
  const l = (c || "").toLowerCase();
  if (l === "excluded") return "Excluded";
  if (l === "transfer" || l === "transfers") return "Transfers";
  return null;
}

export const effectiveCategory = (t, rules) =>
  ruleCategory(t, rules) || passThroughCategory(t.category) || "Uncategorised";

// Set of category names that DON'T count toward spend.
export function buildExcludedSet(categories = []) {
  const set = new Set(DEFAULT_EXCLUDED);
  for (const c of categories) {
    if (c.counts_as_spend === false) set.add(c.name);
    else set.delete(c.name);   // an explicit "counts" row overrides the default
  }
  return set;
}

// Union of category names to offer: managed rows + the categories the feed
// resolves to AFTER rules + rule targets. Using the EFFECTIVE category (not the
// raw Emma one) means a category fully moved away actually disappears from the
// list. `rules` is a Map<match_key, category>. Sorted, case-insensitive de-dupe.
export function categoryNames(categories = [], txns = [], rules = new Map()) {
  const seen = new Map(); // lower -> display
  const add = (n) => {
    if (!n) return;
    const k = n.toLowerCase();
    if (!seen.has(k)) seen.set(k, n);
  };
  categories.forEach((c) => add(c.name));
  txns.forEach((t) => add(effectiveCategory(t, rules)));
  rules.forEach((v) => add(v));
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const rulesMap = () => new Map(state.category_rules.map((r) => [r.match_key, r.category]));

// find a managed row for a name (case-insensitive)
const managedFor = (name) =>
  state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());

// The reserved discretionary group that carries an editable monthly budget.
// Everything else on the "This month" panel is a known recurring flow; General
// Expenses = the counting spend that ISN'T a known bill (see reconcile.js).
export const BUDGET_GROUP = "General Expenses";

// Rough monthly average of DISCRETIONARY spend — counting outflows that aren't
// tied to a known recurring bill — a sensible starting budget for General.
function suggestedBudget(txns) {
  if (!txns || !txns.length) return null;
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);
  const known = new Set(state.recurring_flows.map((f) => f.emma_match_key).filter(Boolean));
  const isKnown = (t) => known.has(t.customName) || known.has(t.merchant) || known.has(t.counterparty);
  const byMonth = new Map();
  for (const t of txns) {
    if (t.amount >= 0 || !t.dateInt) continue;
    if (excluded.has(effectiveCategory(t, rules)) || isKnown(t)) continue;
    const mk = `${Math.floor(t.dateInt / 10000)}-${Math.floor((t.dateInt % 10000) / 100)}`;
    byMonth.set(mk, (byMonth.get(mk) || 0) - t.amount);
  }
  if (byMonth.size < 2) return null;   // need a couple of months to average
  const total = [...byMonth.values()].reduce((s, v) => s + v, 0);
  return Math.round(total / byMonth.size / 10) * 10;   // nearest £10
}

// Per-merchant aggregates for every merchant whose EFFECTIVE category is
// `sourceName` right now → [{ key, count, total }] sorted by spend desc.
function merchantAgg(sourceName, txns, rules) {
  const agg = new Map();
  const bump = (key, amt) => {
    const a = agg.get(key) || { key, count: 0, total: 0 };
    a.count += 1; a.total += Math.abs(amt || 0);
    agg.set(key, a);
  };
  for (const t of txns)
    if (effectiveCategory(t, rules).toLowerCase() === sourceName.toLowerCase())
      bump(txnKey(t), t.amount);
  // include rules pointing AT the source whose merchant has no txn in the window
  for (const r of state.category_rules)
    if (r.category.toLowerCase() === sourceName.toLowerCase() && !agg.has(r.match_key))
      agg.set(r.match_key, { key: r.match_key, count: 0, total: 0 });
  return [...agg.values()].sort((a, b) => b.total - a.total);
}

// Merge/delete sheet: tick the merchants to move, pick a target. All ticked by
// default, so leaving it untouched moves the whole category (and drops the
// source row). Move only some → the source category keeps the rest.
function openReassign(sourceName, txns, onDone) {
  const rules = rulesMap();
  const m = managedFor(sourceName);
  const merchants = merchantAgg(sourceName, txns, rules);
  const targets = categoryNames(state.categories, txns, rules)
    .filter((n) => n.toLowerCase() !== sourceName.toLowerCase());
  if (!targets.some((n) => n.toLowerCase() === "uncategorised")) targets.unshift("Uncategorised");
  const options = targets.map((n) => ({ value: n, label: n }));
  const sel = new Set(merchants.map((x) => x.key));  // all selected initially

  openSheet({
    title: `Move from “${sourceName}”`,
    record: { target: "Uncategorised", _new: "" },
    fields: [
      { key: "target", label: "Move selected to", type: "select", options },
      { key: "_new", label: "…or type a new category", type: "text", placeholder: "e.g. Subscriptions" },
    ],
    extra: (box) => {
      box.innerHTML = merchants.length
        ? `<div class="pick-head"><span class="pick-count"></span>
             <button type="button" class="pick-all"></button></div>
           <div class="pick-list"></div>`
        : `<div class="sec-empty">No transactions in this category — saving deletes the empty bucket.</div>`;
      if (!merchants.length) return;
      const list = box.querySelector(".pick-list");
      const countEl = box.querySelector(".pick-count");
      const allBtn = box.querySelector(".pick-all");
      const refresh = () => {
        countEl.textContent = `${sel.size} of ${merchants.length} selected`;
        allBtn.textContent = sel.size === merchants.length ? "Select none" : "Select all";
      };
      merchants.forEach((x) => {
        const row = document.createElement("label");
        row.className = "pick-row";
        const meta = x.count ? `${x.count} txn · ${fmtGBP(x.total)}` : "rule only";
        row.innerHTML = `<input type="checkbox" ${sel.has(x.key) ? "checked" : ""}/>
          <span class="pick-name">${x.key}</span><span class="pick-meta">${meta}</span>`;
        row.querySelector("input").onchange = (e) => {
          e.target.checked ? sel.add(x.key) : sel.delete(x.key);
          refresh();
        };
        list.appendChild(row);
      });
      allBtn.onclick = () => {
        const all = sel.size === merchants.length;
        sel.clear();
        if (!all) merchants.forEach((x) => sel.add(x.key));
        list.querySelectorAll("input").forEach((inp, i) => { inp.checked = sel.has(merchants[i].key); });
        refresh();
      };
      refresh();
    },
    saveLabel: "Move",
    save: async (clean) => {
      const keys = [...sel];
      if (!keys.length && !m) throw new Error("Select at least one merchant.");
      const target = ((clean._new || "").trim()) || clean.target;
      if (keys.length) {
        if (!target) throw new Error("Pick or name a target category.");
        if (target.toLowerCase() === sourceName.toLowerCase()) throw new Error("Pick a different category.");
      }
      const ruleRows = keys.map((k) => ({ match_key: k, category: target }));
      // drop the source managed row only when the WHOLE category moved out
      const movedAll = keys.length === merchants.length;
      await bulkReassignRules(ruleRows, (movedAll && m) ? m.id : null);
    },
    onDone,
  });
}

const budgets = () => (state.settings && state.settings.forecast_budgets) || {};

// ---- manager section (bottom of the Spending tab) --------------------------
export function categoryManagerHtml(txns) {
  const names = categoryNames(state.categories, txns || [], rulesMap());
  const excluded = buildExcludedSet(state.categories);

  const rows = names.map((name) => {
    const m = managedFor(name);
    const counts = !excluded.has(name);
    const tag = m
      ? (m.counts_as_spend ? "" : `<span class="cat-tag">not counted</span>`)
      : `<span class="cat-tag dim">from Emma</span>`;
    return `<div class="cat-row">
      <span class="cat-name">${name}</span>
      ${tag}
      <button class="toggle ${counts ? "on" : ""}" data-toggle="${encodeURIComponent(name)}"
        title="${counts ? "Counts as spend" : "Excluded from spend"}"><span class="knob"></span></button>
      <button class="cat-move" data-move="${encodeURIComponent(name)}" title="Move / merge / delete"><i data-lucide="folder-input"></i></button>
    </div>`;
  }).join("");

  const geBudget = budgets()[BUDGET_GROUP];
  const suggest = suggestedBudget(txns);
  const budgetRow = `<div class="cat-budget">
    <span class="cat-blabel">“${BUDGET_GROUP}” monthly budget</span>
    <input class="field" id="ge-budget" type="number" inputmode="decimal" step="10"
      value="${geBudget != null ? geBudget : ""}"
      placeholder="${suggest != null ? suggest : "e.g. 2500"}" />
    <span class="cat-bhint">${suggest != null ? `avg ~£${suggest}/mo` : "your discretionary budget — the one editable “This month” line"}</span>
  </div>`;

  return `<section class="fsection cat-section">
    <div class="sec-head">
      <div><div class="eyebrow">Categories</div>
        <p class="sec-sub">Toggle off any bucket that shouldn't count as spend — transfers, credit-card payments, one-offs. Set your discretionary budget below.</p></div>
    </div>
    <div class="sec-body cat-body">
      ${rows || `<div class="sec-empty">No categories yet — load Emma above.</div>`}
      ${budgetRow}
      <div class="cat-add">
        <input class="field" id="cat-new" placeholder="New category name" />
        <button class="cat-addbtn" id="cat-add-btn"><i data-lucide="plus"></i>Add</button>
      </div>
    </div>
  </section>`;
}

export function wireCategoryManager(root, txns, onDone) {
  root.querySelectorAll("[data-toggle]").forEach((btn) => btn.onclick = async () => {
    const name = decodeURIComponent(btn.dataset.toggle);
    const m = managedFor(name);
    const nowCounts = btn.classList.contains("on");
    try {
      if (m) await saveRow("categories", { id: m.id, name: m.name, counts_as_spend: !nowCounts, sort_order: m.sort_order });
      else   await saveRow("categories", { name, counts_as_spend: !nowCounts, sort_order: 99 });
    } catch (e) { alert("Couldn't update category: " + e.message); }
  });

  // General Expenses monthly budget → settings.forecast_budgets
  const budgetInp = root.querySelector("#ge-budget");
  if (budgetInp) budgetInp.onchange = async () => {
    const raw = (budgetInp.value || "").trim();
    const next = { ...budgets() };
    if (raw === "") delete next[BUDGET_GROUP];
    else next[BUDGET_GROUP] = Number(raw) || 0;
    try { await saveSettings({ forecast_budgets: next }); }
    catch (e) { alert("Couldn't save budget: " + e.message); }
  };

  // Move / merge / delete — re-bucket a whole category's merchants at once.
  root.querySelectorAll("[data-move]").forEach((btn) => btn.onclick = () =>
    openReassign(decodeURIComponent(btn.dataset.move), txns || [], onDone));

  const addBtn = root.querySelector("#cat-add-btn");
  const addInput = root.querySelector("#cat-new");
  const doAdd = async () => {
    const name = (addInput.value || "").trim();
    if (!name) return;
    if (managedFor(name)) { addInput.value = ""; return; }
    addBtn.disabled = true;
    try { await saveRow("categories", { name, counts_as_spend: true, sort_order: 99 }); }
    catch (e) { alert("Couldn't add category: " + e.message); addBtn.disabled = false; }
  };
  if (addBtn) addBtn.onclick = doAdd;
  if (addInput) addInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } };
}
