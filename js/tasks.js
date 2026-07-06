// ============================================================================
//  tasks.js — the Tasks tab. Every project_items row across all projects rolled
//  up into one checklist, grouped by project. Filters: To do · Quoted · Over
//  budget. Editing here writes the same project_items rows the project detail
//  sheet shows (one source of truth) via projects.js's editItem/syncTotals.
// ============================================================================
import { state, subscribe, saveRow } from "./store.js";
import { fmtGBP } from "./sheet.js";
import { editItem, syncTotals } from "./projects.js";

const badge = (text, tint) =>
  `<span class="hpill" style="background:color-mix(in srgb, var(--${tint}) 16%, transparent); color:var(--${tint})">${text}</span>`;
const ITEM_TINT = { todo: "text-faint", quoted: "amber", done: "mint" };

const FILTERS = [
  { id: "all",    label: "All",         test: () => true },
  { id: "todo",   label: "To do",       test: (i) => i.status === "todo" },
  { id: "quoted", label: "Quoted",      test: (i) => i.status === "quoted" },
  { id: "over",   label: "Over budget", test: (i) => i.actual_cost != null && Number(i.actual_cost) > Number(i.estimated_cost) },
];
let filter = "all";

const itemsFor = (pid) =>
  state.project_items.filter((i) => i.project_id === pid)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

// quick inline updates — write the row, then resync the parent project total
async function patchItem(id, patch, pid) {
  await saveRow("project_items", { id, ...patch });
  await syncTotals(pid);
}

function itemRow(i) {
  const done = i.status === "done";
  const over = i.actual_cost != null && Number(i.actual_cost) > Number(i.estimated_cost);
  const actTxt = i.actual_cost == null ? "" :
    `<span class="tk-act" style="color:var(--${over ? "coral" : "mint"})">${fmtGBP(i.actual_cost)}${over ? " · over" : ""}</span>`;
  return `<div class="tk-row ${done ? "done" : ""}" data-item="${i.id}">
    <button class="tk-tick ${done ? "on" : ""}" data-tick="${i.id}" title="Mark done">
      <i data-lucide="${done ? "check-circle-2" : "circle"}"></i></button>
    <div class="tk-main" data-edit="${i.id}">
      <span class="tk-name">${i.name}</span>
      <span class="tk-sub">${badge(i.status, ITEM_TINT[i.status] || "text-faint")}${actTxt}</span>
    </div>
    <div class="tk-nums">
      <span class="tk-est">${fmtGBP(i.estimated_cost)}</span>
      <input class="field tk-actin" type="number" inputmode="decimal" step="50"
        placeholder="actual" data-actual="${i.id}" value="${i.actual_cost == null ? "" : i.actual_cost}">
    </div>
  </div>`;
}

function render() {
  const root = document.getElementById("tasks-root");
  if (!root) return;
  const test = (FILTERS.find((f) => f.id === filter) || FILTERS[0]).test;

  // group by project, in the project list's own order
  const groups = state.projects.map((p) => ({ p, items: itemsFor(p.id).filter(test) }))
    .filter((g) => g.items.length);

  const filterCtrl = `<div class="segmented tk-filter">${
    FILTERS.map((f) => `<button class="seg${f.id === filter ? " on" : ""}" data-filter="${f.id}">${f.label}</button>`).join("")
  }</div>`;

  const body = groups.length
    ? groups.map((g) => {
        const est = g.items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0);
        return `<section class="tk-group">
          <div class="tk-ghead"><span class="tk-gname">${g.p.name}</span>
            <span class="tk-gtot">${fmtGBP(est)}</span></div>
          <div class="tk-list">${g.items.map(itemRow).join("")}</div>
        </section>`;
      }).join("")
    : `<div class="sec-empty">${filter === "all"
        ? "No line items yet. Add items to a project (e.g. the kitchen) and they'll roll up here."
        : "Nothing matches this filter."}</div>`;

  root.innerHTML = `
    <div class="p-head">
      <div><div class="eyebrow">Tasks</div>
        <p class="sec-sub">Every project line item in one list. Tick to mark done, or type an actual to log spend.</p></div>
    </div>
    ${filterCtrl}
    ${body}`;

  root.querySelectorAll("[data-filter]").forEach((b) =>
    b.onclick = () => { filter = b.dataset.filter; render(); });

  root.querySelectorAll("[data-tick]").forEach((b) =>
    b.onclick = async (e) => {
      e.stopPropagation();
      const it = state.project_items.find((x) => x.id === b.dataset.tick);
      if (!it) return;
      await patchItem(it.id, { status: it.status === "done" ? "todo" : "done" }, it.project_id);
    });

  root.querySelectorAll("[data-edit]").forEach((m) =>
    m.onclick = () => {
      const it = state.project_items.find((x) => x.id === m.dataset.edit);
      const p = it && state.projects.find((x) => x.id === it.project_id);
      if (it && p) editItem(p, it);
    });

  root.querySelectorAll("[data-actual]").forEach((inp) => {
    inp.onclick = (e) => e.stopPropagation();
    inp.onchange = async () => {
      const it = state.project_items.find((x) => x.id === inp.dataset.actual);
      if (!it) return;
      const val = inp.value === "" ? null : Number(inp.value);
      await patchItem(it.id, { actual_cost: val }, it.project_id);
    };
  });

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountTasks() {
  subscribe(render);
  render();
}
