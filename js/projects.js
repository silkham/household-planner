// ============================================================================
//  projects.js — the Projects tab. Cards sorted by priority/date/cost/status,
//  each with an affordability tick from the live forecast. The detail sheet
//  carries line items (sum→total), the budget lock, actuals/variance and a
//  per-month cost-spread override.
// ============================================================================
import { state, subscribe, saveRow, currentForecast, linkProjectTxn, unlinkProjectTxn } from "./store.js";
import { openSheet, fmtGBP, fmtMonth } from "./sheet.js";
import { projectAffordability, monthIndex, fromIndex } from "./engine.js";
import { fetchEmma, cachedEmmaTxns } from "./emma.js";
import { txnKey, synthKey } from "./categories.js";

const opt = (arr) => arr.map((v) => ({ label: v, value: v }));
const CATEGORIES = opt(["Structural", "Cosmetic", "Repair", "Garden", "Energy", "Furniture"]);
const STATUSES = opt(["Idea", "Planned", "Quoted", "In Progress", "On Hold", "Done"]);
const ITEM_STATUS = opt(["todo", "quoted", "done"]);
const RATING = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: n }));

const STATUS_TINT = {
  Idea: "text-faint", Planned: "blue", Quoted: "amber",
  "In Progress": "mint", "On Hold": "violet", Done: "text-faint",
};
const AFFORD = {
  green: { icon: "check-circle-2", tint: "mint", label: "Fits the forecast" },
  amber: { icon: "alert-triangle", tint: "amber", label: "Pushes below buffer" },
  red:   { icon: "x-circle",       tint: "coral", label: "Drives cash negative" },
  none:  { icon: "circle-dashed",  tint: "text-faint", label: "Not in the forecast" },
};
const BUDGET_TINT = { estimate: "text-faint", budgeted: "mint", tracking: "blue", closed: "violet" };

export const badge = (text, tint) =>
  `<span class="hpill" style="background:color-mix(in srgb, var(--${tint}) 16%, transparent); color:var(--${tint})">${text}</span>`;

// Shared maps/helpers below are exported so the routed project-detail page
// (js/project-detail.js) re-presents the same data without duplicating logic.
export { AFFORD, STATUS_TINT, BUDGET_TINT };

// ---- derived totals from line items ----------------------------------------
export const itemsFor = (pid) =>
  state.project_items.filter((i) => i.project_id === pid)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
export const sumEst = (items) => items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0);
export const sumAct = (items) => items.reduce((s, i) => s + (i.actual_cost == null ? 0 : Number(i.actual_cost)), 0);
export const hasActuals = (items) => items.some((i) => i.actual_cost != null);

// ---- linked transactions (an item's actual_cost = sum of its links) --------
export const linksFor = (itemId) => state.project_item_txns.filter((l) => l.item_id === itemId);
export const sumLinks = (itemId) => linksFor(itemId).reduce((s, l) => s + (Number(l.amount) || 0), 0);

// Link a batch of Emma transactions to a line item, then re-derive its actual
// cost and roll it up to the project. Exported so the Spending tab can push a
// merchant's transactions onto a project from the categorise sheet (the
// transaction-side entry point). Idempotent — re-linking a txn just moves it.
// Recompute one line item's actual_cost from its links and roll it up.
async function recomputeItem(itemId) {
  const it = state.project_items.find((i) => i.id === itemId);
  if (!it) return;
  await saveRow("project_items", { id: itemId, actual_cost: sumLinks(itemId) });
  await syncTotals(it.project_id);
}

export async function linkTransactionsToItem(itemId, txns) {
  // A txn may already be linked to another item — the upsert MOVES it (unique on
  // emma_txn_id), so both the target AND any source items need recomputing, or
  // the source is left overstating its actual.
  const affected = new Set([itemId]);
  for (const t of txns) {
    const key = synthKey(t);
    const prev = state.project_item_txns.find((l) => l.emma_txn_id === key);
    if (prev && prev.item_id !== itemId) affected.add(prev.item_id);
    await linkProjectTxn({
      item_id: itemId, emma_txn_id: key,
      merchant: txnKey(t), txn_date: t.date, amount: Math.abs(Number(t.amount) || 0),
    });
  }
  for (const id of affected) await recomputeItem(id);
  render();
}
// the cashflow number: derived sum when line items exist, else the manual field
export const projectCost = (p) => {
  const its = itemsFor(p.id);
  return its.length ? sumEst(its) : (Number(p.estimated_cost) || 0);
};

// ---- priority: a single manually-set 1–5 field -----------------------------
// (Replaced the derived impact/urgency/effort × weights score in Session 4.)
export const priorityOf = (p) => Number(p.priority) || 3;

// keep the stored project total in sync with its line items (engine reads it)
export async function syncTotals(pid) {
  const its = itemsFor(pid);
  if (!its.length) return;
  const p = state.projects.find((x) => x.id === pid);
  const est = sumEst(its), act = sumAct(its);
  const patch = { id: pid, estimated_cost: est, actual_cost: act };
  // advance to 'tracking' once actuals start landing on a budgeted project
  if (p && p.budget_status === "budgeted" && hasActuals(its)) patch.budget_status = "tracking";
  if (p && (Number(p.estimated_cost) !== est || Number(p.actual_cost) !== act || patch.budget_status)) {
    await saveRow("projects", patch);
  }
}

// ============================================================================
//  Project detail sheet
// ============================================================================
function projectFields(p) {
  const noItems = itemsFor(p.id).length === 0;
  const f = [
    { key: "name", label: "Name", type: "text", placeholder: "Kitchen reno" },
    { key: "category", label: "Category", type: "select", options: CATEGORIES },
    { key: "status", label: "Status", type: "select", options: STATUSES },
    { key: "priority", label: "Priority (1 = low, 5 = must-do)", type: "segmented", options: RATING },
    { key: "target_start_month", label: "Target start", type: "month" },
    { key: "duration_months", label: "Duration (months)", type: "number", min: 1, step: "1" },
  ];
  // manual cost only when there are no line items (else it's the derived sum)
  if (noItems) f.push({ key: "estimated_cost", label: "Estimated cost £", type: "money", step: "100" });
  f.push({ key: "notes", label: "Notes", type: "textarea" });
  return f;
}

// `fieldsOnly` suppresses the rich line-items/budget/spread block — used by the
// routed detail page's edit pencil, since that page renders the block itself.
export function editProject(record, opts = {}) {
  const isNew = !record.id;
  const p = isNew
    ? { name: "", category: "Structural", status: "Planned", priority: 3,
        estimated_cost: 0, target_start_month: null, duration_months: 1, budget_status: "estimate", notes: null }
    : record;
  const showExtra = !isNew && !opts.fieldsOnly;

  openSheet({
    title: isNew ? "New project" : "Project",
    table: "projects",
    fields: projectFields(p),
    record: p,
    impact: (d) => {
      const cost = itemsFor(p.id).length ? projectCost(p) : (Number(d.estimated_cost) || 0);
      const dur = Math.max(1, Number(d.duration_months) || 1);
      return `${fmtGBP(cost)} over ${dur} mo (${fmtGBP(cost / dur)}/mo) from ${fmtMonth(d.target_start_month)}`;
    },
    extra: showExtra ? (box) => renderDetailExtra(box, p) : null,
    onDone: opts.onDone || render,
  });
}

// ---- the rich lower half: line items, budget lock, variance, spread --------
// Exported so the routed detail page mounts the identical block.
export function renderDetailExtra(box, p) {
  const rebuild = () => {
    const items = itemsFor(p.id);
    const est = items.length ? sumEst(items) : (Number(p.estimated_cost) || 0);
    const act = sumAct(items);
    const showActuals = hasActuals(items);

    // --- line items ---
    let itemsHtml = items.map((i) => {
      const over = i.actual_cost != null && Number(i.actual_cost) > Number(i.estimated_cost);
      const actTxt = i.actual_cost == null ? "" :
        `<span class="li-act" style="color:var(--${over ? "coral" : "mint"})">${fmtGBP(i.actual_cost)}</span>`;
      return `<div class="li" data-item="${i.id}">
        <div class="li-main"><span class="li-name">${i.name}</span>
          <span class="li-sub">${badge(i.status, i.status === "done" ? "mint" : i.status === "quoted" ? "amber" : "text-faint")}</span></div>
        <div class="li-nums"><span class="li-est">${fmtGBP(i.estimated_cost)}</span>${actTxt}</div>
      </div>`;
    }).join("");
    if (!items.length) itemsHtml = `<div class="sec-empty" style="margin:0">No line items. This project uses a single cost number. Add items to build the total up.</div>`;

    // --- budget lock ---
    const everyQuoted = items.length > 0 && items.every((i) => i.status === "quoted" || i.status === "done");
    const locked = ["budgeted", "tracking", "closed"].includes(p.budget_status);
    let budgetBtn = "";
    if (items.length) {
      budgetBtn = locked
        ? `<button class="pi-btn locked" data-unlock><i data-lucide="lock"></i> Budget ${p.budget_status}</button>`
        : `<button class="pi-btn" data-lock ${everyQuoted ? "" : "disabled"}>
             <i data-lucide="lock-open"></i> Confirm budget${everyQuoted ? "" : " (quote every line first)"}</button>`;
    }

    // --- variance ---
    let variance = "";
    if (showActuals) {
      const pct = est > 0 ? Math.min(1, act / est) : 0;
      const over = act - est;
      const overTxt = over > 0 ? `<span style="color:var(--coral)">${fmtGBP(over)} over</span>`
        : `<span style="color:var(--mint)">${fmtGBP(-over)} under</span>`;
      variance = `<div class="pi-var">
        <div class="pi-var-top"><span>${fmtGBP(act)} of ${fmtGBP(est)}</span>${overTxt}</div>
        <div class="pi-bar"><span style="transform:scaleX(${pct.toFixed(3)}); background:var(--${over > 0 ? "coral" : "mint"})"></span></div>
      </div>`;
    }

    box.innerHTML = `
      <div class="pi-head"><span class="eyebrow">Line items</span>
        <span class="pi-total">${fmtGBP(est)}${items.length ? " · summed" : ""}</span></div>
      <div class="li-list">${itemsHtml}</div>
      <button class="pi-add" data-additem><i data-lucide="plus"></i> Add line item</button>
      ${budgetBtn}
      ${variance}
      ${renderSpread(p)}`;

    // wire
    box.querySelector("[data-additem]").onclick = () => editItem(p, {}, rebuild);
    box.querySelectorAll("[data-item]").forEach((row) =>
      row.onclick = () => {
        const it = state.project_items.find((x) => x.id === row.dataset.item);
        if (it) editItem(p, it, rebuild);
      });
    const lockBtn = box.querySelector("[data-lock]");
    if (lockBtn && !lockBtn.disabled) lockBtn.onclick = async () => {
      await saveRow("projects", { id: p.id, budget_status: "budgeted" });
      p.budget_status = "budgeted"; rebuild();
    };
    const unlockBtn = box.querySelector("[data-unlock]");
    if (unlockBtn) unlockBtn.onclick = async () => {
      await saveRow("projects", { id: p.id, budget_status: "estimate" });
      p.budget_status = "estimate"; rebuild();
    };
    wireSpread(box, p, rebuild);
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
  };
  rebuild();
}

// ---- cost-spread override (per active month) -------------------------------
export function activeMonths(p) {
  const start = monthIndex(p.target_start_month);
  if (start == null) return [];
  const dur = Math.max(1, Number(p.duration_months) || 1);
  return Array.from({ length: dur }, (_, k) => fromIndex(start + k));
}
function renderSpread(p) {
  const months = activeMonths(p);
  if (!months.length) return "";
  const cost = projectCost(p);
  const even = cost / months.length;
  const spread = p.cost_spread || {};
  const rows = months.map((m) => {
    const val = m in spread ? spread[m] : even;
    return `<label class="sp-row"><span>${fmtMonth(m)}</span>
      <input class="field sp-in" type="number" inputmode="decimal" step="100" data-month="${m}" value="${Math.round(val)}"></label>`;
  }).join("");
  return `<div class="pi-head" style="margin-top:16px"><span class="eyebrow">Cost spread</span>
      <span class="pi-total">${p.cost_spread ? "custom" : "even split"}</span></div>
    <p class="fld-help" style="margin:2px 0 8px">Override how the ${fmtGBP(cost)} lands month by month. Leave as-is for an even split.</p>
    <div class="sp-list">${rows}</div>`;
}
function wireSpread(box, p, rebuild) {
  const ins = [...box.querySelectorAll(".sp-in")];
  if (!ins.length) return;
  const commit = async () => {
    const months = activeMonths(p);
    const cost = projectCost(p);
    const even = cost / months.length;
    const spread = {};
    let custom = false;
    ins.forEach((inp) => {
      const v = Number(inp.value) || 0;
      spread[inp.dataset.month] = v;
      if (Math.abs(v - even) > 0.5) custom = true;
    });
    const next = custom ? spread : null; // all-even → clear the override
    await saveRow("projects", { id: p.id, cost_spread: next });
    p.cost_spread = next; rebuild();
  };
  ins.forEach((inp) => { inp.onchange = commit; });
}

// ---- line item child sheet -------------------------------------------------
// Exported so the Tasks tab edits the very same project_items rows (one source
// of truth) and reuses syncTotals on save.
export function editItem(project, record, onDone) {
  const isNew = !record.id;
  const nextOrder = itemsFor(project.id).length;
  const rec = isNew
    ? { project_id: project.id, name: "", estimated_cost: 0, actual_cost: null,
        status: "todo", sort_order: nextOrder, notes: null }
    : record;
  // When an item has linked transactions, its actual_cost is DERIVED from them
  // (read-only, like a project's estimated_cost once it has line items). Only
  // offer the manual field when there are no links.
  const linked = isNew ? false : linksFor(rec.id).length > 0;

  const fields = [
    { key: "name", label: "Name", type: "text", placeholder: "Units & worktops" },
    { key: "estimated_cost", label: "Budget £", type: "money", step: "100" },
  ];
  if (!linked)
    fields.push({ key: "actual_cost", label: "Actual £ (blank = not spent)", type: "money", step: "50", emptyNull: true });
  fields.push(
    { key: "status", label: "Status", type: "segmented", options: ITEM_STATUS },
    { key: "due_month", label: "Due (for the timeline)", type: "month" },
    { key: "notes", label: "Notes", type: "textarea" },
  );

  openSheet({
    title: isNew ? "New line item" : "Line item",
    table: "project_items",
    fields,
    record: rec,
    // project_id + sort_order aren't shown but must persist
    derive: () => ({ project_id: project.id, sort_order: rec.sort_order }),
    // link transactions on existing items (need an id to attach to)
    extra: isNew ? null : (box) => renderLinks(box, project, rec),
    onDone: async () => { await syncTotals(project.id); onDone && onDone(); render(); },
  });
}

// ---- linked-transactions section (inside the line-item sheet) --------------
// Search the Emma feed, tap to link one or more transactions. The item's
// actual_cost is kept = SUM(links); syncTotals rolls that to the project so the
// forecast shrinks the remaining project spend by what's already been paid.
function renderLinks(box, project, item) {
  let q = "";
  let fetching = false;
  const inputId = `lx-search-${item.id}`;

  const recompute = async () => {
    await saveRow("project_items", { id: item.id, actual_cost: sumLinks(item.id) });
    await syncTotals(project.id);
    render();          // refresh the Projects list behind the sheet
  };

  const draw = (focusSearch) => {
    const links = linksFor(item.id);
    const act = sumLinks(item.id);
    // Only hide txns already on THIS item (they're in the linked list above).
    // Txns linked to OTHER items stay searchable so you can MOVE them here.
    const linkedHere = new Set(links.map((l) => l.emma_txn_id));
    const linkByKey = new Map(state.project_item_txns.map((l) => [l.emma_txn_id, l]));
    const itemLabel = (id) => {
      const it = state.project_items.find((i) => i.id === id);
      const p = it && state.projects.find((x) => x.id === it.project_id);
      return it ? `${p ? p.name + " · " : ""}${it.name}` : "another item";
    };

    const linkedHtml = links.length
      ? links.map((l) => `<div class="lx">
          <div class="lx-main"><span class="lx-name">${l.merchant || "Transaction"}</span>
            <span class="lx-date">${l.txn_date || ""}</span></div>
          <span class="lx-amt">${fmtGBP(l.amount)}</span>
          <button class="lx-del" data-unlink="${l.id}" title="Unlink"><i data-lucide="x"></i></button>
        </div>`).join("")
      : `<div class="sec-empty" style="margin:0">No linked transactions yet.</div>`;

    const feed = cachedEmmaTxns();
    let matches = [];
    if (q.trim()) {
      const ql = q.trim().toLowerCase();
      matches = feed
        .filter((t) => t.amount < 0 && !linkedHere.has(synthKey(t)))
        .filter((t) => `${t.customName || ""} ${t.merchant || ""} ${t.counterparty || ""}`.toLowerCase().includes(ql)
                    || String(Math.abs(t.amount)).includes(ql))
        .sort((a, b) => (b.dateInt || 0) - (a.dateInt || 0))
        .slice(0, 12);
    }
    const resultsHtml = !q.trim() ? "" : (matches.length
      ? matches.map((t, i) => {
          const l = linkByKey.get(synthKey(t));
          return `<button class="lx-res" data-add="${i}">
          <span class="lx-name">${txnKey(t)}</span>
          ${l ? `<span class="lx-linked">in ${itemLabel(l.item_id)}</span>` : ""}
          <span class="lx-date">${t.date}</span>
          <span class="lx-amt">${fmtGBP(Math.abs(t.amount))}</span>
        </button>`; }).join("")
      : `<div class="sec-empty" style="margin:0">${feed.length ? "No matching transactions." : (fetching ? "Loading Emma…" : "Emma not loaded — type to search once it's ready.")}</div>`);

    box.innerHTML = `
      <div class="pi-head"><span class="eyebrow">Linked transactions</span>
        <span class="pi-total">${links.length ? fmtGBP(act) + " actual" : "none"}</span></div>
      <div class="lx-list">${linkedHtml}</div>
      <input class="field lx-search" id="${inputId}" type="text" inputmode="search"
        placeholder="Search Emma to link a payment…" value="${q.replace(/"/g, "&quot;")}">
      <div class="lx-results">${resultsHtml}</div>`;

    // wire
    box.querySelectorAll("[data-unlink]").forEach((b) => b.onclick = async () => {
      await unlinkProjectTxn(b.dataset.unlink);
      await recompute();
      draw(false);
    });
    box.querySelectorAll("[data-add]").forEach((b) => b.onclick = async () => {
      const t = matches[+b.dataset.add];
      if (!t) return;
      // Routes through the shared helper so a txn linked to another item is
      // MOVED (both items recomputed), not silently double-counted.
      await linkTransactionsToItem(item.id, [t]);
      q = ""; draw(true);
    });
    const search = box.querySelector(`#${CSS.escape(inputId)}`);
    if (search) {
      search.oninput = () => { q = search.value; draw(true); };
      if (focusSearch) { search.focus(); const v = search.value; search.value = ""; search.value = v; }
    }
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
  };

  draw(false);
  // lazy-load the Emma feed so search works; redraw once it lands
  if (!cachedEmmaTxns().length) {
    fetching = true;
    fetchEmma().catch(() => {}).finally(() => { fetching = false; draw(false); });
  }
}

// ============================================================================
//  Card list
// ============================================================================
let sortMode = "priority";
const SORTS = [
  { id: "priority", label: "Priority" }, { id: "date", label: "Date" },
  { id: "cost", label: "Cost" }, { id: "status", label: "Status" },
];

function durationBar(p) {
  const dur = Math.max(1, Number(p.duration_months) || 1);
  const cells = Array.from({ length: Math.min(dur, 8) }, () => `<span></span>`).join("");
  return `<div class="dur-bar" title="${dur} month${dur > 1 ? "s" : ""}">${cells}</div>`;
}

function projectCard(p, forecast) {
  const score = priorityOf(p);
  const cost = projectCost(p);
  const aff = AFFORD[projectAffordability({ ...p, estimated_cost: cost }, forecast)];
  const itemCount = itemsFor(p.id).length;
  const budget = p.budget_status && p.budget_status !== "estimate"
    ? badge(p.budget_status, BUDGET_TINT[p.budget_status]) : "";
  return `<div class="fcard pcard" data-id="${p.id}">
    <div class="pc-tick" title="${aff.label}"><i data-lucide="${aff.icon}" style="color:var(--${aff.tint})"></i></div>
    <div class="fc-main">
      <div class="pc-top"><span class="fc-name">${p.name}</span>
        <span class="pc-score" title="Priority (1–5)">P${score}</span></div>
      <div class="fc-sub">${badge(p.status, STATUS_TINT[p.status] || "blue")}
        ${p.category ? badge(p.category, "blue") : ""} ${budget}
        <span class="fc-dim">${fmtMonth(p.target_start_month)}</span>
        ${itemCount ? `<span class="fc-dim">· ${itemCount} item${itemCount > 1 ? "s" : ""}</span>` : ""}</div>
      ${durationBar(p)}
    </div>
    <span class="fc-amt">${fmtGBP(cost)}</span>
  </div>`;
}

function sortProjects(list) {
  const arr = [...list];
  if (sortMode === "priority") arr.sort((a, b) => priorityOf(b) - priorityOf(a));
  else if (sortMode === "cost") arr.sort((a, b) => projectCost(b) - projectCost(a));
  else if (sortMode === "date") arr.sort((a, b) =>
    (a.target_start_month || "9999") < (b.target_start_month || "9999") ? -1 : 1);
  else if (sortMode === "status") arr.sort((a, b) => (a.status || "").localeCompare(b.status || ""));
  return arr;
}

function render() {
  const root = document.getElementById("projects-root");
  if (!root) return;
  const forecast = currentForecast();
  const sorted = sortProjects(state.projects);

  const sortCtrl = `<div class="segmented p-sort">${
    SORTS.map((s) => `<button class="seg${s.id === sortMode ? " on" : ""}" data-sort="${s.id}">${s.label}</button>`).join("")
  }</div>`;

  const body = sorted.length
    ? sorted.map((p) => projectCard(p, forecast)).join("")
    : `<div class="sec-empty">No projects yet. Add the garage, shed, hallway floor, kitchen…</div>`;

  root.innerHTML = `
    <div class="p-head">
      <div><div class="eyebrow">Projects</div>
        <p class="sec-sub">Sorted by ${SORTS.find((s) => s.id === sortMode).label.toLowerCase()}. The tick shows whether each fits the forecast.</p></div>
      <button class="sec-add" data-newproject><i data-lucide="plus"></i></button>
    </div>
    ${sortCtrl}
    <div class="p-list">${body}</div>`;

  root.querySelector("[data-newproject]").onclick = () => editProject({});
  root.querySelectorAll("[data-sort]").forEach((b) =>
    b.onclick = () => { sortMode = b.dataset.sort; render(); });
  root.querySelectorAll(".pcard").forEach((c) =>
    c.onclick = () => { location.hash = "#/projects/" + c.dataset.id; });
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountProjects() {
  subscribe(render);
  render();
}
