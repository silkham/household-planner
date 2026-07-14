// ============================================================================
//  forecast.js — the Forecast tab. THE money view.
//  Bespoke inline-SVG cashflow chart (draw-on), scenario segmented control,
//  alert strip, and an expandable monthly table with per-month breakdown.
//  All numbers come from the engine via store.currentForecast().
// ============================================================================
import { state, subscribe, currentForecast } from "./store.js";
import { fmtGBP, fmtMonth } from "./sheet.js";
import { fetchEmma } from "./emma.js";
import { reconcileMonth } from "./reconcile.js";
import { buildExcludedSet } from "./categories.js";
import { openRecurringSheet } from "./finances.js";
import { plannedCostInMonth, monthIndex } from "./engine.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const shortMonth = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return `${MON[(+m || 1) - 1]} '${y.slice(2)}`;
};
const signed = (n) => (n < 0 ? "−" : "+") + fmtGBP(Math.abs(n));

// Phone breakpoint — the chart uses a narrower/taller viewBox here so it scales
// up legibly (see buildChart). Matches the app's 640px mobile breakpoint.
const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

// Selected chart point (tap-to-show position). Defaults to the current month so
// its cash/net is visible on load; touch has no hover, so this is tap-driven.
let selPoint = 0;
// Chart geometry cached so the callout can update IN PLACE on hover without a
// full re-render (which would replay the line draw-on animation every hover).
let coPts = [], coBounds = {};

function calloutMarkup(i) {
  const p = coPts[i];
  if (!p) return "";
  const { padL, padR, padT, bottom, W } = coBounds;
  const l1 = shortMonth(p.month);
  const l2 = `${fmtGBP(p.cash)} · ${signed(p.net)}`;
  const bw = Math.max(96, l2.length * 7.2 + 20), bh = 38;
  let bx = p.x - bw / 2;
  bx = Math.max(padL, Math.min(W - padR - bw, bx));
  let by = p.y - bh - 13;
  if (by < padT) by = Math.min(bottom - bh - 2, p.y + 13);
  const cxm = (bx + bw / 2).toFixed(1);
  return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="none"
      stroke="var(--violet)" stroke-width="2"/>
    <g class="cf-callout">
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="8"/>
      <text x="${cxm}" y="${(by + 15).toFixed(1)}" text-anchor="middle" class="cf-co-mon">${l1}</text>
      <text x="${cxm}" y="${(by + 30).toFixed(1)}" text-anchor="middle" class="cf-co-val">${l2}</text>
    </g>`;
}

// ---------------------------------------------------------------------------
//  SVG chart — cash position over the horizon
// ---------------------------------------------------------------------------
function buildChart(fc) {
  const ms = fc.months;
  const n = ms.length;
  // The SVG scales to the container width via a fixed viewBox, so a NARROWER
  // viewBox on mobile scales UP — a taller plot and larger (more legible) text
  // on a phone, where the 720-wide desktop viewBox rendered everything tiny.
  const mob = isMobile();
  const W = mob ? 380 : 720, H = mob ? 300 : 300;
  const padL = mob ? 40 : 46, padR = mob ? 12 : 16, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bottom = padT + plotH;

  const cashes = ms.map((m) => m.cash);
  let yMin = Math.min(fc.buffer, 0, ...cashes);
  let yMax = Math.max(fc.buffer, ...cashes);
  const span = (yMax - yMin) || 1;
  yMin -= span * 0.08; yMax += span * 0.08;
  const range = yMax - yMin;

  const x = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => padT + (1 - (v - yMin) / range) * plotH;

  const linePts = ms.map((m, i) => `${x(i).toFixed(1)},${y(m.cash).toFixed(1)}`);
  const linePath = "M" + linePts.join(" L");
  const areaPath = `${linePath} L${x(n - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;

  // buffer + zero reference lines
  const bufY = y(fc.buffer).toFixed(1);
  const zeroLine = yMin < 0 && yMax > 0
    ? `<line x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}"
         stroke="var(--hairline)" stroke-width="1"/>` : "";

  // y-axis labels: buffer + top + bottom
  const yLabel = (v, extra = "") =>
    `<text x="${padL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end"
       class="ax-lbl ${extra}">${fmtGBP(v)}</text>`;
  const yLabels = yLabel(yMax - span * 0.08) + yLabel(fc.buffer, "buf") +
    (yMin < 0 ? yLabel(0) : "");

  // x-axis labels — thin them out so they never crowd (fewer on the narrow
  // mobile viewBox where each label takes proportionally more room)
  const step = Math.max(1, Math.ceil(n / (mob ? 4 : 6)));
  const xLabels = ms.map((m, i) =>
    (i % step === 0 || i === n - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="ax-lbl">${shortMonth(m.month)}</text>`
      : "").join("");

  // points — plain, below-buffer (amber), negative (coral). Each carries a wide
  // transparent hit-circle with a native <title> so hover shows the position.
  const dots = ms.map((m, i) => {
    const neg = m.flags.includes("negative");
    const below = m.flags.includes("below_buffer");
    const tint = neg ? "coral" : below ? "amber" : "mint";
    const r = neg || below ? 3.2 : 2;
    const cx = x(i).toFixed(1), cy = y(m.cash).toFixed(1);
    const tip = `${shortMonth(m.month)} · cash ${fmtGBP(m.cash)} · net ${signed(m.net)}`;
    return `<circle cx="${cx}" cy="${cy}" r="${r}"
      fill="var(--${tint})" ${neg ? 'class="pt-danger"' : ""}/>
      <circle class="cf-hit" data-pt="${i}" cx="${cx}" cy="${cy}" r="12" fill="transparent" style="cursor:pointer">
        <title>${tip}</title></circle>`;
  }).join("");

  // Cache point geometry so hover can repaint only the callout (no re-render).
  coPts = ms.map((m, i) => ({ x: x(i), y: y(m.cash), month: m.month, cash: m.cash, net: m.net }));
  coBounds = { padL, padR, padT, bottom, W };

  // circle the lowest point and annotate it
  let low = 0;
  ms.forEach((m, i) => { if (m.cash < ms[low].cash) low = i; });
  const lx = x(low), ly = y(ms[low].cash);
  // Put the label BELOW the low point (inside the area fill, clear of the line
  // which only rises away from the minimum); flip above only if it'd hit the
  // x-axis. Centre + clamp horizontally so it never runs off the edge.
  const belowY = ly + 17;
  const lblY = belowY < bottom - 2 ? belowY : ly - 11;
  const lblX = Math.max(padL + 34, Math.min(W - padR - 34, lx));
  const low_ = `
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="none"
      stroke="var(--${ms[low].cash < fc.buffer ? "coral" : "mint"})" stroke-width="1.5" opacity=".9"/>
    <text x="${lblX.toFixed(1)}" y="${lblY.toFixed(1)}" text-anchor="middle" class="ax-lbl low">
      low ${fmtGBP(ms[low].cash)} · ${shortMonth(ms[low].month)}</text>`;

  return `<svg class="cf-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Cash position over ${n} months">
    <defs>
      <linearGradient id="cfArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--mint)" stop-opacity=".28"/>
        <stop offset="1" stop-color="var(--mint)" stop-opacity="0"/>
      </linearGradient>
      <filter id="cfGlow" x="-20%" y="-40%" width="140%" height="180%">
        <feGaussianBlur stdDeviation="3.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${zeroLine}
    <line x1="${padL}" y1="${bufY}" x2="${W - padR}" y2="${bufY}"
      stroke="var(--coral)" stroke-width="1.2" stroke-dasharray="5 5" opacity=".8"/>
    ${yLabels}${xLabels}
    <path class="spark-area" d="${areaPath}" fill="url(#cfArea)"/>
    <path class="spark-line" d="${linePath}" fill="none" stroke="var(--mint)"
      stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
      pathLength="1000" filter="url(#cfGlow)"/>
    ${dots}${low_}<g class="cf-co-slot">${selPoint != null ? calloutMarkup(selPoint) : ""}</g>
  </svg>`;
}

// ---------------------------------------------------------------------------
//  Alert strip
// ---------------------------------------------------------------------------
function buildAlerts(fc) {
  const ms = fc.months;
  const neg = ms.find((m) => m.flags.includes("negative"));
  const below = ms.find((m) => m.flags.includes("below_buffer"));
  const rows = [];
  if (neg)
    rows.push(alertRow("x-octagon", "coral", neg.month,
      `Cash goes <b>negative</b> in ${fmtMonth(neg.month)} (${fmtGBP(neg.cash)})`));
  if (below && below.month !== (neg && neg.month))
    rows.push(alertRow("alert-triangle", "amber", below.month,
      `Dips below your ${fmtGBP(fc.buffer)} buffer in ${fmtMonth(below.month)} (${fmtGBP(below.cash)})`));
  if (!rows.length) {
    let low = ms[0] || { cash: 0, month: "" };
    ms.forEach((m) => { if (m.cash < low.cash) low = m; });
    rows.push(alertRow("shield-check", "mint", low.month,
      `Stays above your ${fmtGBP(fc.buffer)} buffer. Lowest point ${fmtGBP(low.cash)} in ${fmtMonth(low.month)}.`));
  }
  return `<div class="cf-alerts">${rows.join("")}</div>`;
}
const alertRow = (icon, tint, month, html) =>
  `<button class="cf-alert" data-jump="${month}" style="--t:var(--${tint})">
    <i data-lucide="${icon}"></i><span>${html}</span><i data-lucide="chevron-right" class="chev"></i></button>`;

// ---------------------------------------------------------------------------
//  Monthly table (expandable rows)
// ---------------------------------------------------------------------------
let expanded = new Set();
let expandedCat = new Set();   // "month::category" open in a month's Out breakdown

function breakdownList(title, items, sign) {
  if (!items.length) return "";
  const rows = items
    .filter((it) => Math.abs(it.amount) > 0.5)
    .map((it) => `<div class="bd-row"><span>${it.name}</span><span>${sign}${fmtGBP(Math.abs(it.amount))}</span></div>`)
    .join("");
  return rows ? `<div class="bd-grp"><div class="bd-h">${title}</div>${rows}</div>` : "";
}

// The "Out" list grouped by category, each category a collapsible dropdown —
// the flat list got long once every recurring bill is in play.
function expenseGroups(m) {
  const items = m.breakdown.expenses.filter((it) => Math.abs(it.amount) > 0.5);
  if (!items.length) return "";
  const groups = new Map();
  for (const it of items) {
    const cat = it.category || "Other";
    if (!groups.has(cat)) groups.set(cat, { cat, total: 0, items: [] });
    const g = groups.get(cat);
    g.total += Math.abs(it.amount);
    g.items.push(it);
  }
  const rows = [...groups.values()].sort((a, b) => b.total - a.total).map((g) => {
    const key = `${m.month}::${g.cat}`;
    const open = expandedCat.has(key);
    const lines = open
      ? `<div class="bd-lines">${g.items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
          .map((it) => `<div class="bd-row"><span>${it.name}</span><span>−${fmtGBP(Math.abs(it.amount))}</span></div>`).join("")}</div>`
      : "";
    return `<div class="bd-cat ${open ? "open" : ""}">
      <button class="bd-cathead" data-catkey="${encodeURIComponent(key)}">
        <i data-lucide="chevron-${open ? "down" : "right"}" class="bd-chev"></i>
        <span class="bd-catname">${g.cat}</span>
        <span class="bd-catamt">−${fmtGBP(g.total)}</span>
      </button>${lines}</div>`;
  }).join("");
  return `<div class="bd-grp"><div class="bd-h">Out</div>${rows}</div>`;
}

function monthRow(m) {
  const isOpen = expanded.has(m.month);
  const neg = m.flags.includes("negative");
  const below = m.flags.includes("below_buffer");
  const cls = neg ? "neg" : below ? "below" : "";
  const detail = isOpen ? `<div class="mr-detail">
      <div class="mr-nums">
        <span>Income <b style="color:var(--mint)">${signed(m.income)}</b></span>
        <span>Expenses <b style="color:var(--coral)">−${fmtGBP(m.expenses)}</b></span>
        <span>Projects <b>${fmtGBP(m.project_spend)}</b></span>
      </div>
      ${breakdownList("Income", m.breakdown.income, "+")}
      ${expenseGroups(m)}
    </div>` : "";
  return `<div class="mrow ${cls} ${isOpen ? "open" : ""}" data-month="${m.month}">
    <button class="mr-head" data-toggle="${m.month}">
      <span class="mr-mon">${shortMonth(m.month)}</span>
      <span class="mr-net" style="color:var(--${m.net < 0 ? "coral" : "mint"})">${signed(m.net)}</span>
      <span class="mr-cash">${fmtGBP(m.cash)}</span>
      <i data-lucide="chevron-${isOpen ? "up" : "down"}" class="mr-chev"></i>
    </button>${detail}</div>`;
}

// ---------------------------------------------------------------------------
//  "This month" reconciliation — expected (recurring flows) vs actual (Emma).
//  Groups → categories → transactions. Lazily pulls the memoised Emma feed.
// ---------------------------------------------------------------------------
let rcFeed = null, rcLoading = false, rcErr = null;
const rcExpanded = new Set();
const thisMonth = () => new Date().toISOString().slice(0, 7);
const emmaConfigured = () => !!(state.settings && state.settings.emma_sheet_id);

async function loadReconcile() {
  if (rcLoading || rcFeed) return;
  rcLoading = true; rcErr = null;
  try { rcFeed = await fetchEmma(); }
  catch (e) { rcErr = e.message || String(e); }
  finally { rcLoading = false; render(); }
}

function txRow(t) {
  return `<div class="rc-tx"><span>${t.customName || t.merchant || t.counterparty || "Unknown"}</span>
    <span class="rc-txdate">${t.date || ""}</span>
    <span class="rc-txamt">${fmtGBP(Math.abs(t.amount))}</span></div>`;
}

// A known-figure line = one recurring flow, green (received) or red (due).
function flowLine(g, line) {
  const path = `l:${g.kind}:${g.name}:${line.id}`;
  const canExpand = line.txns.length > 0;
  const open = canExpand && rcExpanded.has(path);
  const word = line.isBonus
    ? "bonus"
    : g.kind === "income"
      ? (line.received ? "received" : "not in")
      : (line.received ? "paid" : "due");
  const tag = `<span class="rc-tag ${line.isBonus ? "amber" : line.received ? "mint" : "coral"}">${word}</span>`;
  const nums = line.received
    ? `<b style="color:var(--mint)">${fmtGBP(line.actual)}</b> <span class="rc-exp">/ ${fmtGBP(line.expected)}</span>`
    : `<b style="color:var(--coral)">${fmtGBP(line.expected)}</b>`;
  const chev = canExpand
    ? `<i data-lucide="chevron-${open ? "down" : "right"}" class="rc-chev"></i>`
    : `<span class="rc-chev"></span>`;
  const txns = open ? `<div class="rc-txs">${line.txns.map(txRow).join("")}</div>` : "";
  return `<div class="rc-cat ${open ? "open" : ""}">
    <div class="rc-crow">
      <button class="rc-chead" data-rc="${encodeURIComponent(path)}">
        ${chev}<span class="rc-cname">${line.name}</span>${tag}<span class="rc-nums">${nums}</span>
      </button>
      ${line.isBonus || line.noEdit ? "" : `<button class="rc-edit" data-flow="${line.id}" title="Edit recurring flow"><i data-lucide="pencil"></i></button>`}
    </div>${txns}</div>`;
}

// A General-Expenses category line — actual spend, expand to its transactions.
function genCatRow(g, c) {
  const path = `c:${g.name}:${c.name}`;
  const open = rcExpanded.has(path);
  const txns = open ? `<div class="rc-txs">${c.txns.map(txRow).join("")}</div>` : "";
  return `<div class="rc-cat ${open ? "open" : ""}">
    <div class="rc-crow">
      <button class="rc-chead" data-rc="${encodeURIComponent(path)}">
        <i data-lucide="chevron-${open ? "down" : "right"}" class="rc-chev"></i>
        <span class="rc-cname">${c.name}</span>
        <span class="rc-nums"><b>${fmtGBP(c.actual)}</b></span>
      </button>
    </div>${txns}</div>`;
}

function groupRow(g) {
  const path = `g:${g.kind}:${g.name}`;
  const open = rcExpanded.has(path);
  const pct = g.expected > 0 ? Math.min(100, Math.round((g.actual / g.expected) * 100)) : 0;
  const tint = g.over ? "coral" : (g.pendingExpected > 0 ? "amber" : "mint");
  const numTint = g.kind === "income"
    ? (g.pendingExpected > 0 ? "amber" : "mint")
    : (g.over ? "coral" : "mint");
  const right = `<b style="color:var(--${numTint})">${fmtGBP(g.actual)}</b>${g.expected ? ` / ${fmtGBP(g.expected)}` : ""}`;
  const note = g.over ? `<span class="rc-tag coral">over</span>`
    : g.pendingExpected > 0
      ? `<span class="rc-tag amber">${fmtGBP(g.pendingExpected)} ${g.kind === "income" ? "to come" : "due"}</span>`
    : g.type === "budget" ? `<span class="rc-tag mint">within</span>` : "";
  const bar = g.expected > 0
    ? `<div class="rc-bar"><span style="width:${pct}%;background:var(--${tint})"></span></div>` : "";
  const inner = g.type === "budget"
    ? g.categories.map((c) => genCatRow(g, c)).join("")
    : g.lines.map((l) => flowLine(g, l)).join("");
  const body = open ? `<div class="rc-cats">${inner}</div>` : "";
  return `<div class="rc-grp ${open ? "open" : ""}">
    <button class="rc-ghead" data-rc="${encodeURIComponent(path)}">
      <i data-lucide="chevron-${open ? "down" : "right"}" class="rc-chev"></i>
      <span class="rc-gname">${g.name}</span>${note}
      <span class="rc-gnums">${right}</span>
    </button>${bar}${body}</div>`;
}

// Projects this month as a SPEND group (expected vs actual, like the others):
//   expected = the month's planned project cost (engine plannedCostInMonth,
//              un-shrunk — this month's slice of the budget)
//   actual   = the project-linked transactions that have HIT this month
// Each project is a line (paid/due + expandable to the payments that landed);
// the group carries the progress bar. Rendered via groupRow so it matches the
// recurring / General groups exactly.
// Emma date "M/D/YYYY" → 'YYYY-MM'
function usMonth(s) {
  const p = String(s || "").split("/");
  if (p.length !== 3) return null;
  return `${p[2]}-${String(+p[0] || 0).padStart(2, "0")}`;
}
const projEst = (p) => {
  const its = state.project_items.filter((i) => i.project_id === p.id);
  return its.length ? its.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0)
                    : (Number(p.estimated_cost) || 0);
};
// Same item-due-month → £ spread the engine reads (see store.currentForecast).
const projSpread = (p) => {
  const its = state.project_items.filter((i) => i.project_id === p.id);
  if (!its.length) return p.cost_spread || null;
  const s = {};
  for (const it of its) {
    const m = it.due_month || p.target_start_month;
    if (m) s[m] = (s[m] || 0) + (Number(it.estimated_cost) || 0);
  }
  return Object.keys(s).length ? s : (p.cost_spread || null);
};
const round2 = (n) => Math.round(n * 100) / 100;

function projectGroup() {
  const month = thisMonth();
  const mIdx = monthIndex(month);
  // linked transactions that landed THIS month, per project
  const itemProj = new Map(state.project_items.map((i) => [i.id, i.project_id]));
  const hitByProj = new Map();   // pid → { amount, txns[] }
  for (const l of state.project_item_txns) {
    if (usMonth(l.txn_date) !== month) continue;
    const pid = itemProj.get(l.item_id);
    if (!pid) continue;
    let e = hitByProj.get(pid);
    if (!e) { e = { amount: 0, txns: [] }; hitByProj.set(pid, e); }
    e.amount += Number(l.amount) || 0;
    e.txns.push({ customName: l.merchant, date: l.txn_date, amount: -(Number(l.amount) || 0) });
  }

  const lines = [];
  for (const p of state.projects) {
    // No status filter — timing comes from line-item due months (the derived
    // spread), matching the engine; a fully-paid project just plans £0.
    const expected = plannedCostInMonth(
      { ...p, estimated_cost: projEst(p), cost_spread: projSpread(p) }, mIdx);
    const hit = hitByProj.get(p.id) || { amount: 0, txns: [] };
    if (expected < 0.5 && hit.amount < 0.5) continue;   // nothing planned or spent
    lines.push({ id: p.id, name: p.name, expected: round2(expected),
      actual: round2(hit.amount), received: hit.amount > 0.5, noEdit: true, txns: hit.txns });
  }
  if (!lines.length) return "";
  lines.sort((a, b) => b.expected - a.expected || b.actual - a.actual);

  const expected = round2(lines.reduce((s, l) => s + l.expected, 0));
  const actual = round2(lines.reduce((s, l) => s + l.actual, 0));
  const over = actual > expected + 0.005;
  return groupRow({ name: "Projects", kind: "expense", type: "flows",
    expected, actual, pendingExpected: over ? 0 : round2(Math.max(0, expected - actual)),
    over, lines });
}

function buildReconcile(fc) {
  if (!emmaConfigured()) return "";
  const month = thisMonth();
  let body;
  if (rcErr) {
    body = `<div class="sec-empty">Couldn't load Emma: ${rcErr} <button class="rc-retry" data-rcload>Retry</button></div>`;
  } else if (rcFeed == null) {
    body = `<div class="sec-empty">${rcLoading ? "Reconciling against Emma…" : `<button class="rc-retry" data-rcload>Load this month from Emma</button>`}</div>`;
  } else {
    const r = reconcileMonth({
      month, txns: rcFeed.txns,
      recurring_flows: state.recurring_flows,
      bonuses: state.bonuses,
      category_rules: state.category_rules,
      budgets: (state.settings && state.settings.forecast_budgets) || {},
      excluded: buildExcludedSet(state.categories),
      projectKeys: new Set(state.project_item_txns.map((l) => l.emma_txn_id)),
    });
    const groups = [...r.income, ...r.expense];
    const projHtml = projectGroup();
    body = (groups.length || projHtml)
      ? groups.map(groupRow).join("") + projHtml
      : `<div class="sec-empty">No recurring flows or spend matched this month yet.</div>`;
  }
  return `<section class="rc-card glass">
    <div class="rc-head">
      <div><div class="eyebrow">This month · ${fmtMonth(month)}</div>
        <p class="sec-sub">Expected vs actual, live from Emma. Green within, red over, amber still to land.</p></div>
      <button class="sec-sync" data-rcrefresh ${rcLoading ? "disabled" : ""}>
        <i data-lucide="refresh-cw"></i>${rcLoading ? "…" : "Refresh"}</button>
    </div>
    <div class="rc-body">${body}</div>
  </section>`;
}

function wireReconcile(root) {
  root.querySelectorAll("[data-rcload]").forEach((b) => b.onclick = () => loadReconcile());
  root.querySelectorAll("[data-rcrefresh]").forEach((b) => b.onclick = async () => {
    rcLoading = true; render();
    try { rcFeed = await fetchEmma(true); rcErr = null; }
    catch (e) { rcErr = e.message || String(e); }
    finally { rcLoading = false; render(); }
  });
  root.querySelectorAll("[data-rc]").forEach((b) => b.onclick = () => {
    const p = decodeURIComponent(b.dataset.rc);
    rcExpanded.has(p) ? rcExpanded.delete(p) : rcExpanded.add(p);
    render();
  });
  root.querySelectorAll("[data-flow]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const flow = state.recurring_flows.find((f) => f.id === b.dataset.flow);
    if (flow) openRecurringSheet(flow, render);
  });
}

// ---------------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------------
function render() {
  const root = document.getElementById("forecast-root");
  if (!root) return;
  const fc = currentForecast();

  root.innerHTML = `
    <div class="cf-top">
      <div><div class="eyebrow">Forecast</div>
        <p class="sec-sub">Cash position over ${fc.months.length} months · opening ${fmtGBP(fc.opening_cash)}. Red dashes are your buffer.</p></div>
    </div>
    <div class="cf-card glass">${buildChart(fc)}</div>
    ${buildAlerts(fc)}
    ${buildReconcile(fc)}
    <div class="cf-tablehead"><span>Month</span><span>Net</span><span>Cash</span><span></span></div>
    <div class="cf-table">${fc.months.map(monthRow).join("")}</div>`;

  wireReconcile(root);

  // Chart points — hover (laptop) or tap (touch) repaints ONLY the callout slot,
  // so the line never re-animates on hover.
  const slot = root.querySelector(".cf-co-slot");
  root.querySelectorAll(".cf-hit").forEach((c) => {
    const set = () => {
      const i = +c.dataset.pt;
      if (selPoint === i) return;
      selPoint = i;
      if (slot) slot.innerHTML = calloutMarkup(i);
    };
    c.addEventListener("mouseenter", set);
    c.addEventListener("click", set);
  });

  root.querySelectorAll("[data-toggle]").forEach((b) =>
    b.onclick = () => {
      const mo = b.dataset.toggle;
      expanded.has(mo) ? expanded.delete(mo) : expanded.add(mo);
      render();
    });

  root.querySelectorAll("[data-catkey]").forEach((b) =>
    b.onclick = (e) => {
      e.stopPropagation();
      const k = decodeURIComponent(b.dataset.catkey);
      expandedCat.has(k) ? expandedCat.delete(k) : expandedCat.add(k);
      render();
    });

  root.querySelectorAll("[data-jump]").forEach((b) =>
    b.onclick = () => {
      const mo = b.dataset.jump;
      expanded.add(mo); render();
      requestAnimationFrame(() => {
        const el = document.querySelector(`.mrow[data-month="${mo}"]`);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); }
      });
    });

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

let breakpointBound = false;
export function mountForecast() {
  subscribe(render);
  // Re-render when we cross the phone breakpoint so the chart's viewBox swaps
  // (rotation / window resize). Fires only on the breakpoint change, not every
  // resize tick — so no thrash and the line draw-on isn't replayed constantly.
  if (!breakpointBound) {
    breakpointBound = true;
    const mql = window.matchMedia("(max-width: 640px)");
    const onChange = () => render();
    mql.addEventListener ? mql.addEventListener("change", onChange)
                         : mql.addListener(onChange);
  }
  render();
  if (emmaConfigured()) loadReconcile();   // lazy, non-blocking
}
