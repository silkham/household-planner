// ============================================================================
//  projects.js — the Projects tab. Cards sorted by priority/date/cost/status,
//  each with an affordability tick from the live forecast. The detail sheet
//  carries line items (sum→total), the budget lock, actuals/variance and a
//  per-month cost-spread override.
// ============================================================================
import { state, subscribe, saveRow } from "./store.js";
import { openSheet, fmtGBP, fmtMonth } from "./sheet.js";
import { computeForecast, projectAffordability, monthIndex, fromIndex } from "./engine.js";

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

const badge = (text, tint) =>
  `<span class="hpill" style="background:color-mix(in srgb, var(--${tint}) 16%, transparent); color:var(--${tint})">${text}</span>`;

// ---- derived totals from line items ----------------------------------------
const itemsFor = (pid) =>
  state.project_items.filter((i) => i.project_id === pid)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
const sumEst = (items) => items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0);
const sumAct = (items) => items.reduce((s, i) => s + (i.actual_cost == null ? 0 : Number(i.actual_cost)), 0);
const hasActuals = (items) => items.some((i) => i.actual_cost != null);
// the cashflow number: derived sum when line items exist, else the manual field
const projectCost = (p) => {
  const its = itemsFor(p.id);
  return its.length ? sumEst(its) : (Number(p.estimated_cost) || 0);
};

// ---- priority score (client-side, from settings.priority_weights) ----------
const DEFAULT_WEIGHTS = { impact: 0.35, urgency: 0.30, effort: 0.15, cost: 0.20 };
function priorityScore(p, maxCost) {
  const w = (state.settings && state.settings.priority_weights) || DEFAULT_WEIGHTS;
  const cost = projectCost(p);
  const costScore = maxCost > 0 ? 1 - cost / maxCost : 1; // cheaper = better
  const raw =
    (w.impact || 0) * ((Number(p.impact) || 3) / 5) +
    (w.urgency || 0) * ((Number(p.urgency) || 3) / 5) +
    (w.effort || 0) * ((Number(p.effort) || 3) / 5) +
    (w.cost || 0) * costScore;
  return Math.round(raw * 100);
}

// ---- live forecast (one pass per render, reused for every card) ------------
function currentForecast() {
  // feed derived costs so the engine is correct even if the stored field drifts
  const projects = state.projects.map((p) => {
    const its = itemsFor(p.id);
    return its.length ? { ...p, estimated_cost: sumEst(its), actual_cost: sumAct(its) } : p;
  });
  return computeForecast({
    accounts: state.accounts, recurring_flows: state.recurring_flows,
    salary_changes: state.salary_changes, life_events: state.life_events,
    bonuses: state.bonuses, projects, financing_options: state.financing_options,
    settings: state.settings || {},
    scenario: (state.settings && state.settings.forecast_confidence) || "realistic",
  });
}

// keep the stored project total in sync with its line items (engine reads it)
async function syncTotals(pid) {
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
    { key: "impact", label: "Impact (1–5)", type: "segmented", options: RATING },
    { key: "urgency", label: "Urgency (1–5)", type: "segmented", options: RATING },
    { key: "effort", label: "Effort (1–5, higher = easier)", type: "segmented", options: RATING },
    { key: "target_start_month", label: "Target start", type: "month" },
    { key: "duration_months", label: "Duration (months)", type: "number", min: 1, step: "1" },
  ];
  // manual cost only when there are no line items (else it's the derived sum)
  if (noItems) f.push({ key: "estimated_cost", label: "Estimated cost £", type: "money", step: "100" });
  f.push({ key: "notes", label: "Notes", type: "textarea" });
  return f;
}

function editProject(record) {
  const isNew = !record.id;
  const p = isNew
    ? { name: "", category: "Structural", status: "Planned", impact: 3, urgency: 3, effort: 3,
        estimated_cost: 0, target_start_month: null, duration_months: 1, budget_status: "estimate", notes: null }
    : record;

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
    extra: isNew ? null : (box) => renderDetailExtra(box, p),
    onDone: render,
  });
}

// ---- the rich lower half: line items, budget lock, variance, spread --------
function renderDetailExtra(box, p) {
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
function activeMonths(p) {
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
function editItem(project, record, onDone) {
  const isNew = !record.id;
  const nextOrder = itemsFor(project.id).length;
  const rec = isNew
    ? { project_id: project.id, name: "", estimated_cost: 0, actual_cost: null,
        status: "todo", sort_order: nextOrder, notes: null }
    : record;
  openSheet({
    title: isNew ? "New line item" : "Line item",
    table: "project_items",
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "Units & worktops" },
      { key: "estimated_cost", label: "Budget £", type: "money", step: "100" },
      { key: "actual_cost", label: "Actual £ (blank = not spent)", type: "money", step: "50", emptyNull: true },
      { key: "status", label: "Status", type: "segmented", options: ITEM_STATUS },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    record: rec,
    // project_id + sort_order aren't shown but must persist
    derive: () => ({ project_id: project.id, sort_order: rec.sort_order }),
    onDone: async () => { await syncTotals(project.id); onDone && onDone(); render(); },
  });
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

function projectCard(p, forecast, maxCost) {
  const score = priorityScore(p, maxCost);
  const cost = projectCost(p);
  const aff = AFFORD[projectAffordability({ ...p, estimated_cost: cost }, forecast)];
  const itemCount = itemsFor(p.id).length;
  const budget = p.budget_status && p.budget_status !== "estimate"
    ? badge(p.budget_status, BUDGET_TINT[p.budget_status]) : "";
  return `<div class="fcard pcard" data-id="${p.id}">
    <div class="pc-tick" title="${aff.label}"><i data-lucide="${aff.icon}" style="color:var(--${aff.tint})"></i></div>
    <div class="fc-main">
      <div class="pc-top"><span class="fc-name">${p.name}</span>
        <span class="pc-score" title="Priority score">${score}</span></div>
      <div class="fc-sub">${badge(p.status, STATUS_TINT[p.status] || "blue")}
        ${p.category ? badge(p.category, "blue") : ""} ${budget}
        <span class="fc-dim">${fmtMonth(p.target_start_month)}</span>
        ${itemCount ? `<span class="fc-dim">· ${itemCount} item${itemCount > 1 ? "s" : ""}</span>` : ""}</div>
      ${durationBar(p)}
    </div>
    <span class="fc-amt">${fmtGBP(cost)}</span>
  </div>`;
}

function sortProjects(list, maxCost) {
  const arr = [...list];
  if (sortMode === "priority") arr.sort((a, b) => priorityScore(b, maxCost) - priorityScore(a, maxCost));
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
  const maxCost = state.projects.reduce((m, p) => Math.max(m, projectCost(p)), 0);
  const sorted = sortProjects(state.projects, maxCost);

  const sortCtrl = `<div class="segmented p-sort">${
    SORTS.map((s) => `<button class="seg${s.id === sortMode ? " on" : ""}" data-sort="${s.id}">${s.label}</button>`).join("")
  }</div>`;

  const body = sorted.length
    ? sorted.map((p) => projectCard(p, forecast, maxCost)).join("")
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
    c.onclick = () => {
      const p = state.projects.find((x) => x.id === c.dataset.id);
      if (p) editProject(p);
    });
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountProjects() {
  subscribe(render);
  render();
}
