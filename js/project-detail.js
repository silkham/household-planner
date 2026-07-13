// ============================================================================
//  project-detail.js — the routed project page (#/projects/:id). A destination,
//  not a bottom-sheet: header + stat tiles + affordability, an "across the
//  build" month track (line items placed on the month axis with planned-vs-
//  actual spend), recent linked payments, and the full line-items / budget /
//  cost-spread block (reused wholesale from projects.js via renderDetailExtra).
//  Field edits (name/status/dates…) open the slim project sheet via the pencil.
// ============================================================================
import { state, subscribe, currentForecast } from "./store.js";
import { fmtGBP, fmtMonth } from "./sheet.js";
import { projectAffordability, plannedCostInMonth, monthIndex } from "./engine.js";
import {
  itemsFor, sumEst, sumAct, projectCost, priorityOf, activeMonths,
  AFFORD, STATUS_TINT, BUDGET_TINT, badge, editProject, renderDetailExtra,
} from "./projects.js";

let currentId = null;

// "M/D/YYYY" (Emma feed / stored txn_date) → 'YYYY-MM'
function txnMonth(d) {
  if (!d) return null;
  const [m, , y] = String(d).split("/");
  return y ? `${y}-${String(m).padStart(2, "0")}` : null;
}

// A project's derived figures (line-item sums when it has items).
function figures(p) {
  const items = itemsFor(p.id);
  const est = items.length ? sumEst(items) : (Number(p.estimated_cost) || 0);
  const act = items.length ? sumAct(items) : (Number(p.actual_cost) || 0);
  return { items, est, act };
}

// ---- header ----------------------------------------------------------------
function headerHtml(p) {
  const status = badge(p.status, STATUS_TINT[p.status] || "blue");
  const dur = Math.max(1, Number(p.duration_months) || 1);
  const budget = p.budget_status && p.budget_status !== "estimate"
    ? badge(p.budget_status, BUDGET_TINT[p.budget_status]) : "";
  return `<div class="pd-top">
    <button class="pd-back" data-back title="Back to projects"><i data-lucide="arrow-left"></i></button>
    <div class="pd-title">
      <div class="eyebrow">${p.category || "Project"} · P${priorityOf(p)}</div>
      <h1 class="pd-name">${p.name || "Untitled project"}</h1>
      <div class="pd-meta">${status} ${budget}
        <span class="fc-dim">${fmtMonth(p.target_start_month)} · ${dur} mo</span></div>
    </div>
    <button class="pd-edit" data-editproj title="Edit project"><i data-lucide="pencil"></i></button>
  </div>`;
}

// ---- stat tiles ------------------------------------------------------------
function tile(lbl, val, tint) {
  const c = tint ? ` style="color:var(--${tint})"` : "";
  return `<div class="pd-tile"><div class="pd-tl">${lbl}</div><div class="pd-tv"${c}>${val}</div></div>`;
}
function tilesHtml(p, est, act, forecast) {
  const remain = est - act;
  const overTint = act > est ? "coral" : null;
  const aff = AFFORD[projectAffordability({ ...p, estimated_cost: est }, forecast)];
  return `<div class="pd-tiles">
    ${tile("Budget", fmtGBP(est))}
    ${tile("Spent", fmtGBP(act), overTint)}
    ${tile("Remaining", fmtGBP(remain), remain < 0 ? "coral" : null)}
    <div class="pd-tile pd-afftile">
      <div class="pd-tl">Affordability</div>
      <div class="pd-aff" style="color:var(--${aff.tint})">
        <i data-lucide="${aff.icon}"></i><span>${aff.label}</span></div>
    </div>
  </div>`;
}

// ---- across-the-build track (timeline + planned vs actual) -----------------
function trackHtml(p, est) {
  const items = itemsFor(p.id);
  // months in play: the planned span ∪ any month a line item is due ∪ any month
  // a linked payment landed (a deposit can land ahead of the planned window).
  const spanMonths = activeMonths({ ...p, estimated_cost: est });
  const itemIds = new Set(items.map((i) => i.id));
  const pays = state.project_item_txns.filter((l) => itemIds.has(l.item_id));

  const actualBy = {};
  for (const l of pays) {
    const m = txnMonth(l.txn_date);
    if (m) actualBy[m] = (actualBy[m] || 0) + (Number(l.amount) || 0);
  }
  const dueBy = {};
  for (const i of items) if (i.due_month) (dueBy[i.due_month] = dueBy[i.due_month] || []).push(i);

  const months = [...new Set([...spanMonths, ...Object.keys(actualBy), ...Object.keys(dueBy)])]
    .filter(Boolean).sort();
  if (!months.length)
    return `<div class="pd-sec"><div class="eyebrow">Across the build</div>
      <div class="sec-empty" style="margin:6px 0 0">Set a target start month (and line-item due months) to see the schedule.</div></div>`;

  const plannedBy = {};
  for (const m of months) {
    const idx = monthIndex(m);
    plannedBy[m] = idx == null ? 0 : plannedCostInMonth({ ...p, estimated_cost: est }, idx);
  }
  const maxVal = Math.max(1, ...months.map((m) => Math.max(plannedBy[m] || 0, actualBy[m] || 0)));

  const rows = months.map((m) => {
    const planned = plannedBy[m] || 0, actual = actualBy[m] || 0;
    const pw = (planned / maxVal * 100).toFixed(1);
    const aw = (actual / maxVal * 100).toFixed(1);
    const overM = actual > planned + 0.5;
    const chips = (dueBy[m] || [])
      .map((i) => `<span class="pd-chip">${i.name}</span>`).join("");
    const nums = [
      planned ? `<span class="pd-pl">${fmtGBP(planned)}</span>` : "",
      actual ? `<span class="pd-ac" style="color:var(--${overM ? "coral" : "mint"})">${fmtGBP(actual)}</span>` : "",
    ].filter(Boolean).join(" ");
    return `<div class="pd-mrow">
      <div class="pd-mtop"><span class="pd-mo">${fmtMonth(m)}</span><span class="pd-mnums">${nums || "—"}</span></div>
      <div class="pd-mbar">
        <span class="pd-mbar-pl" style="width:${pw}%"></span>
        <span class="pd-mbar-ac ${overM ? "over" : ""}" style="width:${aw}%"></span>
      </div>
      ${chips ? `<div class="pd-chips">${chips}</div>` : ""}
    </div>`;
  }).join("");

  return `<div class="pd-sec">
    <div class="pd-sechead"><span class="eyebrow">Across the build</span>
      <span class="pd-leg"><i class="pd-sw pl"></i>planned <i class="pd-sw ac"></i>actual</span></div>
    <div class="pd-track">${rows}</div></div>`;
}

// ---- recent linked payments ------------------------------------------------
function paymentsHtml(p) {
  const items = itemsFor(p.id);
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const itemIds = new Set(items.map((i) => i.id));
  const pays = state.project_item_txns
    .filter((l) => itemIds.has(l.item_id))
    .sort((a, b) => (txnMonth(b.txn_date) || "").localeCompare(txnMonth(a.txn_date) || ""));
  if (!pays.length) return "";
  const rows = pays.slice(0, 8).map((l) => `<div class="pd-pay">
    <div class="pd-pay-main"><span class="pd-pay-name">${l.merchant || "Transaction"}</span>
      <span class="pd-pay-item">${itemName.get(l.item_id) || ""}</span></div>
    <span class="pd-pay-date">${l.txn_date || ""}</span>
    <span class="pd-pay-amt">${fmtGBP(l.amount)}</span></div>`).join("");
  return `<div class="pd-sec">
    <div class="pd-sechead"><span class="eyebrow">Recent payments</span>
      <span class="pd-leg">${pays.length} linked · ${fmtGBP(pays.reduce((s, l) => s + (Number(l.amount) || 0), 0))}</span></div>
    <div class="pd-pays">${rows}</div></div>`;
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("project-detail-root");
  if (!root) return;
  const p = state.projects.find((x) => x.id === currentId);
  if (!p) {
    root.innerHTML = `<div class="pd-top">
      <button class="pd-back" data-back><i data-lucide="arrow-left"></i></button>
      <div class="pd-title"><h1 class="pd-name">Project not found</h1></div></div>`;
    root.querySelector("[data-back]").onclick = () => history.back();
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
    return;
  }

  const forecast = currentForecast();
  const { est, act } = figures(p);

  root.innerHTML = `
    ${headerHtml(p)}
    ${tilesHtml(p, est, act, forecast)}
    ${trackHtml(p, est)}
    ${paymentsHtml(p)}
    <div class="pd-sec"><div id="pd-items"></div></div>`;

  // reuse the projects.js line-items / budget lock / variance / cost-spread block
  renderDetailExtra(document.getElementById("pd-items"), p);

  root.querySelector("[data-back]").onclick = () => {
    if (history.length > 1) history.back(); else location.hash = "#/projects";
  };
  root.querySelector("[data-editproj]").onclick = () =>
    editProject(p, { fieldsOnly: true, onDone: render });

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

// Called by the router when the hash is #/projects/:id.
export function showProjectDetail(id) { currentId = id; render(); }

export function mountProjectDetail() {
  // Re-render on any state change, but only while this page is the active view
  // (avoids churn behind the other screens).
  subscribe(() => {
    const sec = document.querySelector('[data-screen="project-detail"]');
    if (currentId && sec && sec.classList.contains("active")) render();
  });
}
