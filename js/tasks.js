// ============================================================================
//  tasks.js — the cross-project line-item roll-up. Every project_items row
//  across all projects in one checklist, grouped by project. Status is DERIVED
//  ("To pay" until linked transactions cover the budget, then "Paid") and
//  actuals come only from links — so this view is read-only summary + a tap
//  through to the line-item sheet (where you link payments). One source of
//  truth. Rendered as the "Tasks" sub-view of the Projects screen.
// ============================================================================
import { state } from "./store.js";
import { fmtGBP } from "./sheet.js";
import { editItem, itemPaid, sumLinks } from "./projects.js";

const badge = (text, tint) =>
  `<span class="hpill" style="background:color-mix(in srgb, var(--${tint}) 16%, transparent); color:var(--${tint})">${text}</span>`;

const overBudget = (i) => sumLinks(i.id) > Number(i.estimated_cost) + 0.005;

const FILTERS = [
  { id: "all",   label: "All",         test: () => true },
  { id: "topay", label: "To pay",      test: (i) => !itemPaid(i) },
  { id: "paid",  label: "Paid",        test: (i) => itemPaid(i) },
  { id: "over",  label: "Over budget", test: overBudget },
];
let filter = "all";

const itemsFor = (pid) =>
  state.project_items.filter((i) => i.project_id === pid)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

function itemRow(i) {
  const paid = itemPaid(i);
  const links = sumLinks(i.id);
  const over = overBudget(i);
  const actTxt = links > 0 ?
    `<span class="tk-act" style="color:var(--${over ? "coral" : "mint"})">${fmtGBP(links)}${over ? " · over" : ""}</span>` : "";
  return `<div class="tk-row ${paid ? "done" : ""}" data-edit="${i.id}">
    <div class="tk-main">
      <span class="tk-name">${i.name}</span>
      <span class="tk-sub">${badge(paid ? "Paid" : "To pay", paid ? "mint" : "text-faint")}${actTxt}</span>
    </div>
    <div class="tk-nums"><span class="tk-est">${fmtGBP(i.estimated_cost)}</span></div>
  </div>`;
}

let taskRoot = null;

function render() {
  const root = taskRoot;
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
    <p class="sec-sub" style="margin:0 0 10px">Every project line item in one list. Tap one to link the payments that mark it paid.</p>
    ${filterCtrl}
    ${body}`;

  root.querySelectorAll("[data-filter]").forEach((b) =>
    b.onclick = () => { filter = b.dataset.filter; render(); });

  root.querySelectorAll("[data-edit]").forEach((m) =>
    m.onclick = () => {
      const it = state.project_items.find((x) => x.id === m.dataset.edit);
      const p = it && state.projects.find((x) => x.id === it.project_id);
      if (it && p) editItem(p, it);
    });

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

// Render the roll-up into a container owned by the Projects screen. projects.js
// re-calls this on every render (it's subscribed to state), so no own subscribe.
export function renderTasksInto(root) {
  taskRoot = root;
  render();
}
