// ============================================================================
//  projects.js — the Projects tab. Cards with an affordability tick from the
//  live forecast. The detail sheet carries line items (sum→total), the budget
//  lock, and actuals/variance. Projects have no status/priority/category/
//  duration any more — spend timing comes from each line item's due month, and
//  a project stays in the forecast for its REMAINING cost until it's fully paid
//  (actuals come only from linked transactions).
// ============================================================================
import { state, subscribe, saveRow, currentForecast, linkProjectTxn, unlinkProjectTxn } from "./store.js";
import { openSheet, fmtGBP, fmtMonth } from "./sheet.js";
import { projectAffordability } from "./engine.js";
import { fetchEmma, cachedEmmaTxns } from "./emma.js";
import { txnKey, synthKey } from "./categories.js";
import { renderTasksInto } from "./tasks.js";

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
export { AFFORD, BUDGET_TINT };

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

// ---- line-item status is DERIVED, not stored -------------------------------
// Two states only: "Paid" once linked transactions cover the item's budget,
// else "To pay". (Actuals come solely from linked txns, so there's no manual
// status field any more.)
export const itemPaid = (item) => {
  const est = Number(item.estimated_cost) || 0;
  const paid = sumLinks(item.id);
  return est > 0 ? paid >= est - 0.005 : paid > 0;
};

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
    { key: "target_start_month", label: "Target start", type: "month",
      help: "When spend begins. Line items with their own due month override this." },
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
    ? { name: "", estimated_cost: 0, target_start_month: null, budget_status: "estimate", notes: null }
    : record;
  const showExtra = !isNew && !opts.fieldsOnly;

  openSheet({
    title: isNew ? "New project" : "Project",
    table: "projects",
    fields: projectFields(p),
    record: p,
    impact: (d) => {
      const cost = itemsFor(p.id).length ? projectCost(p) : (Number(d.estimated_cost) || 0);
      return `${fmtGBP(cost)}${d.target_start_month ? " from " + fmtMonth(d.target_start_month) : ""}`;
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
      const paid = itemPaid(i);
      const links = sumLinks(i.id);
      const over = links > 0 && links > Number(i.estimated_cost);
      const actTxt = links > 0 ?
        `<span class="li-act" style="color:var(--${over ? "coral" : "mint"})">${fmtGBP(links)}</span>` : "";
      return `<div class="li" data-item="${i.id}">
        <div class="li-main"><span class="li-name">${i.name}</span>
          <span class="li-sub">${badge(paid ? "Paid" : "To pay", paid ? "mint" : "text-faint")}</span></div>
        <div class="li-nums"><span class="li-est">${fmtGBP(i.estimated_cost)}</span>${actTxt}</div>
      </div>`;
    }).join("");
    if (!items.length) itemsHtml = `<div class="sec-empty" style="margin:0">No line items. This project uses a single cost number. Add items to build the total up.</div>`;

    // --- budget lock ---
    const everyBudgeted = items.length > 0 && items.every((i) => Number(i.estimated_cost) > 0);
    const locked = ["budgeted", "tracking", "closed"].includes(p.budget_status);
    let budgetBtn = "";
    if (items.length) {
      budgetBtn = locked
        ? `<button class="pi-btn locked" data-unlock><i data-lucide="lock"></i> Budget ${p.budget_status}</button>`
        : `<button class="pi-btn" data-lock ${everyBudgeted ? "" : "disabled"}>
             <i data-lucide="lock-open"></i> Confirm budget${everyBudgeted ? "" : " (add a cost to every line first)"}</button>`;
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
      ${variance}`;

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
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
  };
  rebuild();
}

// ---- active months = when the project actually draws money -----------------
// Spend timing now comes from line items: each item's due month (falling back to
// the project's start month), else — with no items — just the start month.
// Exported for the detail page's "across the build" track.
export function activeMonths(p) {
  const months = new Set();
  for (const i of itemsFor(p.id)) {
    const m = i.due_month || p.target_start_month;
    if (m) months.add(m);
  }
  if (!months.size && p.target_start_month) months.add(p.target_start_month);
  return [...months].sort();
}

// ---- line item child sheet -------------------------------------------------
// Exported so the Tasks tab edits the very same project_items rows (one source
// of truth) and reuses syncTotals on save.
export function editItem(project, record, onDone) {
  const isNew = !record.id;
  const nextOrder = itemsFor(project.id).length;
  const rec = isNew
    ? { project_id: project.id, name: "", estimated_cost: 0, actual_cost: null,
        sort_order: nextOrder, notes: null, due_month: null }
    : record;
  // Actuals come ONLY from linked transactions (the section below) — no manual
  // actual field. The item's status ("To pay"/"Paid") is derived from whether
  // those links cover its budget, so there's no status field either.
  const fields = [
    { key: "name", label: "Name", type: "text", placeholder: "Units & worktops" },
    { key: "estimated_cost", label: "Budget £", type: "money", step: "100" },
    { key: "due_month", label: "Due month", type: "month",
      help: "When this line is planned to be paid — drives the forecast timing." },
    { key: "notes", label: "Notes", type: "textarea" },
  ];

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
let sortMode = "date";
const SORTS = [
  { id: "date", label: "Date" }, { id: "cost", label: "Cost" },
];

const spentOf = (p) => {
  const its = itemsFor(p.id);
  return its.length ? sumAct(its) : (Number(p.actual_cost) || 0);
};
// active = still has money left to spend (there's no status any more; a fully
// paid project has £0 remaining and drops out of the forecast on its own).
const isActive = (p) => (projectCost(p) - spentOf(p)) > 0.005;

// Top-of-tab dashboard: committed vs spent across active projects + whether
// the spendable cash on hand covers what's still outstanding.
function projectsDashboard() {
  const active = state.projects.filter(isActive);
  const committed = active.reduce((s, p) => s + projectCost(p), 0);
  const spent = active.reduce((s, p) => s + spentOf(p), 0);
  const remaining = Math.max(0, committed - spent);
  const cash = state.accounts
    .filter((a) => a.available_for_projects)
    .reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const covers = cash >= remaining;
  const tint = remaining === 0 ? "mint" : covers ? "mint" : cash >= remaining * 0.5 ? "amber" : "coral";
  const pct = remaining > 0 ? Math.min(100, cash / remaining * 100) : 100;
  const note = remaining === 0
    ? `Nothing outstanding across ${active.length} active project${active.length === 1 ? "" : "s"}.`
    : covers
      ? `${fmtGBP(cash)} available covers the ${fmtGBP(remaining)} still outstanding.`
      : `${fmtGBP(cash)} available — ${fmtGBP(remaining - cash)} short of the ${fmtGBP(remaining)} outstanding.`;
  return `<div class="glass pdash">
    <div class="pdash-stats">
      <div class="pdash-stat"><span class="pdash-l">Committed</span><span class="pdash-v">${fmtGBP(committed)}</span></div>
      <div class="pdash-stat"><span class="pdash-l">Spent</span><span class="pdash-v">${fmtGBP(spent)}</span></div>
      <div class="pdash-stat"><span class="pdash-l">Remaining</span><span class="pdash-v">${fmtGBP(remaining)}</span></div>
    </div>
    <div class="pdash-fund">
      <div class="pdash-bar"><i style="width:${pct.toFixed(0)}%; background:var(--${tint})"></i></div>
      <div class="pdash-note" style="color:var(--${tint === "mint" ? "text-dim" : tint})">${note}</div>
    </div>
  </div>`;
}

function projectCard(p, forecast) {
  const cost = projectCost(p);
  const aff = AFFORD[projectAffordability({ ...p, estimated_cost: cost }, forecast)];
  const itemCount = itemsFor(p.id).length;
  const budget = p.budget_status && p.budget_status !== "estimate"
    ? badge(p.budget_status, BUDGET_TINT[p.budget_status]) : "";
  const act = spentOf(p);
  const pct = cost > 0 ? Math.min(100, act / cost * 100) : 0;
  const over = act > cost;
  const progress = act > 0
    ? `<div class="pc-prog"><div class="pc-progbar"><i style="width:${pct.toFixed(0)}%; background:var(--${over ? "coral" : "mint"})"></i></div>
        <span class="pc-progtxt">${fmtGBP(act)} spent</span></div>`
    : "";
  return `<div class="fcard pcard" data-id="${p.id}">
    <div class="pc-tick" title="${aff.label}"><i data-lucide="${aff.icon}" style="color:var(--${aff.tint})"></i></div>
    <div class="fc-main">
      <div class="pc-top"><span class="fc-name">${p.name}</span></div>
      <div class="fc-sub">${budget}
        <span class="fc-dim">${fmtMonth(p.target_start_month)}</span>
        ${itemCount ? `<span class="fc-dim">· ${itemCount} item${itemCount > 1 ? "s" : ""}</span>` : ""}</div>
      ${progress}
    </div>
    <span class="fc-amt">${fmtGBP(cost)}</span>
  </div>`;
}

function sortProjects(list) {
  const arr = [...list];
  if (sortMode === "cost") arr.sort((a, b) => projectCost(b) - projectCost(a));
  else arr.sort((a, b) =>  // date
    (a.target_start_month || "9999") < (b.target_start_month || "9999") ? -1 : 1);
  return arr;
}

// Projects screen has two sub-views: the project dashboard/cards and the
// cross-project Tasks roll-up (folded in from the old Tasks tab, Session 17).
let view = "projects";
const VIEWS = [{ id: "projects", label: "Projects" }, { id: "tasks", label: "Tasks" }];

function render() {
  const root = document.getElementById("projects-root");
  if (!root) return;

  const viewCtrl = `<div class="segmented p-view">${
    VIEWS.map((v) => `<button class="seg${v.id === view ? " on" : ""}" data-view="${v.id}">${v.label}</button>`).join("")
  }</div>`;
  const sub = view === "tasks"
    ? "Every line item across your projects, in one checklist."
    : "Tap a project for its dashboard. The tick shows whether each fits the forecast.";

  const head = `<div class="p-head">
      <div><div class="eyebrow">Projects</div><p class="sec-sub">${sub}</p></div>
      <button class="sec-add" data-newproject><i data-lucide="plus"></i></button>
    </div>
    ${viewCtrl}`;

  if (view === "tasks") {
    root.innerHTML = `${head}<div id="proj-tasks"></div>`;
    renderTasksInto(root.querySelector("#proj-tasks"));
  } else {
    const forecast = currentForecast();
    const sorted = sortProjects(state.projects);
    const sortCtrl = `<div class="segmented p-sort">${
      SORTS.map((s) => `<button class="seg${s.id === sortMode ? " on" : ""}" data-sort="${s.id}">${s.label}</button>`).join("")
    }</div>`;
    const body = sorted.length
      ? sorted.map((p) => projectCard(p, forecast)).join("")
      : `<div class="sec-empty">No projects yet. Add the garage, shed, hallway floor, kitchen…</div>`;
    root.innerHTML = `${head}
      ${projectsDashboard()}
      ${sortCtrl}
      <div class="p-list">${body}</div>`;
    root.querySelectorAll("[data-sort]").forEach((b) =>
      b.onclick = () => { sortMode = b.dataset.sort; render(); });
    root.querySelectorAll(".pcard").forEach((c) =>
      c.onclick = () => { location.hash = "#/projects/" + c.dataset.id; });
  }

  root.querySelector("[data-newproject]").onclick = () => editProject({});
  root.querySelectorAll("[data-view]").forEach((b) =>
    b.onclick = () => { view = b.dataset.view; render(); });
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountProjects() {
  subscribe(render);
  render();
}
