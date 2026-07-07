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
import { state, saveRow, deleteRow, saveSettings } from "./store.js";

// Non-counting unless a managed row explicitly flips them — Emma's own
// convention (Excluded) plus internal moves (Transfers).
export const DEFAULT_EXCLUDED = ["Excluded", "Transfers"];

// Set of category names that DON'T count toward spend.
export function buildExcludedSet(categories = []) {
  const set = new Set(DEFAULT_EXCLUDED);
  for (const c of categories) {
    if (c.counts_as_spend === false) set.add(c.name);
    else set.delete(c.name);   // an explicit "counts" row overrides the default
  }
  return set;
}

// Union of category names to offer: managed rows + whatever the Emma feed and
// existing rules actually use. Keeps the dropdown complete before anything's
// been "managed". Sorted, case-insensitive de-dupe (first spelling wins).
export function categoryNames(categories = [], txns = [], ruleCats = []) {
  const seen = new Map(); // lower -> display
  const add = (n) => {
    if (!n) return;
    const k = n.toLowerCase();
    if (!seen.has(k)) seen.set(k, n);
  };
  categories.forEach((c) => add(c.name));
  txns.forEach((t) => add(t.category));
  ruleCats.forEach(add);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// find a managed row for a name (case-insensitive)
const managedFor = (name) =>
  state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());

// The reserved discretionary group that carries an editable monthly budget
// (see reconcile.js). Other groups (Housing, Salary…) take expected from flows.
export const BUDGET_GROUP = "General Expenses";

// forecast_group of a category by display name, or "" if none/unmanaged.
const groupOfName = (name) => {
  const m = managedFor(name);
  return (m && m.forecast_group) || "";
};

// Distinct forecast groups currently in use (for the datalist), plus the
// reserved budget group so it's always offerable.
const groupList = () => {
  const s = new Set([BUDGET_GROUP]);
  state.categories.forEach((c) => { if (c.forecast_group) s.add(c.forecast_group); });
  return [...s].sort((a, b) => a.localeCompare(b));
};

// Rough monthly average spend of the categories currently in General Expenses —
// a sensible starting budget. Uses the same rule override + counts logic.
function suggestedBudget(txns) {
  if (!txns || !txns.length) return null;
  const rules = new Map(state.category_rules.map((r) => [r.match_key, r.category]));
  const inGroup = new Set(
    state.categories.filter((c) => c.forecast_group === BUDGET_GROUP)
      .map((c) => c.name.toLowerCase()));
  if (!inGroup.size) return null;
  const key = (t) => t.customName || t.merchant || t.counterparty || "Unknown";
  const eff = (t) => rules.get(key(t)) || t.category || "Uncategorised";
  const byMonth = new Map();
  for (const t of txns) {
    if (t.amount >= 0 || !t.dateInt) continue;
    if (!inGroup.has(String(eff(t)).toLowerCase())) continue;
    const mk = `${Math.floor(t.dateInt / 10000)}-${Math.floor((t.dateInt % 10000) / 100)}`;
    byMonth.set(mk, (byMonth.get(mk) || 0) - t.amount);
  }
  if (!byMonth.size) return null;
  const total = [...byMonth.values()].reduce((s, v) => s + v, 0);
  return Math.round(total / byMonth.size / 10) * 10;   // nearest £10
}

const budgets = () => (state.settings && state.settings.forecast_budgets) || {};

// ---- manager section (bottom of the Spending tab) --------------------------
export function categoryManagerHtml(txns) {
  const ruleCats = state.category_rules.map((r) => r.category);
  const names = categoryNames(state.categories, txns || [], ruleCats);
  const excluded = buildExcludedSet(state.categories);

  const rows = names.map((name) => {
    const m = managedFor(name);
    const counts = !excluded.has(name);
    const tag = m
      ? (m.counts_as_spend ? "" : `<span class="cat-tag">not counted</span>`)
      : `<span class="cat-tag dim">from Emma</span>`;
    const del = m
      ? `<button class="cat-del" data-del="${m.id}" title="Delete category"><i data-lucide="trash-2"></i></button>`
      : "";
    return `<div class="cat-row">
      <span class="cat-name">${name}</span>
      ${tag}
      <input class="field cat-group" list="cat-groups" data-group="${encodeURIComponent(name)}"
        value="${groupOfName(name)}" placeholder="group" title="Forecast group (blank = own line)" />
      <button class="toggle ${counts ? "on" : ""}" data-toggle="${encodeURIComponent(name)}"
        title="${counts ? "Counts as spend" : "Excluded from spend"}"><span class="knob"></span></button>
      ${del}
    </div>`;
  }).join("");

  const opts = groupList().map((g) => `<option value="${g}"></option>`).join("");
  const geBudget = budgets()[BUDGET_GROUP];
  const suggest = suggestedBudget(txns);
  const budgetRow = `<div class="cat-budget">
    <span class="cat-blabel">“${BUDGET_GROUP}” monthly budget</span>
    <input class="field" id="ge-budget" type="number" inputmode="decimal" step="10"
      value="${geBudget != null ? geBudget : ""}"
      placeholder="${suggest != null ? suggest : "e.g. 2500"}" />
    <span class="cat-bhint">${suggest != null ? `avg ~£${suggest}/mo` : "the one editable line — food, eating out, clothes…"}</span>
  </div>`;

  return `<section class="fsection cat-section">
    <datalist id="cat-groups">${opts}</datalist>
    <div class="sec-head">
      <div><div class="eyebrow">Categories &amp; forecast groups</div>
        <p class="sec-sub">Toggle off buckets that shouldn't count as spend. Set a <b>group</b> to roll categories into one “This month” line (e.g. Housing); leave blank for its own line. Use “${BUDGET_GROUP}” for the discretionary budget pot.</p></div>
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

export function wireCategoryManager(root) {
  root.querySelectorAll("[data-toggle]").forEach((btn) => btn.onclick = async () => {
    const name = decodeURIComponent(btn.dataset.toggle);
    const m = managedFor(name);
    const nowCounts = btn.classList.contains("on");
    try {
      if (m) await saveRow("categories", { id: m.id, name: m.name, counts_as_spend: !nowCounts, sort_order: m.sort_order });
      else   await saveRow("categories", { name, counts_as_spend: !nowCounts, sort_order: 99 });
    } catch (e) { alert("Couldn't update category: " + e.message); }
  });

  // forecast_group per category — create a managed row on the fly if needed.
  root.querySelectorAll("[data-group]").forEach((inp) => inp.onchange = async () => {
    const name = decodeURIComponent(inp.dataset.group);
    const group = (inp.value || "").trim() || null;
    const m = managedFor(name);
    try {
      if (m) await saveRow("categories", { id: m.id, name: m.name, counts_as_spend: m.counts_as_spend, sort_order: m.sort_order, forecast_group: group });
      else   await saveRow("categories", { name, counts_as_spend: true, sort_order: 99, forecast_group: group });
    } catch (e) { alert("Couldn't set group: " + e.message); }
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

  root.querySelectorAll("[data-del]").forEach((btn) => btn.onclick = async () => {
    if (!confirm("Delete this category? Transactions revert to counting as spend.")) return;
    try { await deleteRow("categories", btn.dataset.del); }
    catch (e) { alert("Delete failed: " + e.message); }
  });

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
