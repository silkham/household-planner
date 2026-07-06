// ============================================================================
//  forecast.js — the Forecast tab. THE money view.
//  Bespoke inline-SVG cashflow chart (draw-on), scenario segmented control,
//  alert strip, and an expandable monthly table with per-month breakdown.
//  All numbers come from the engine via store.currentForecast().
// ============================================================================
import { state, subscribe, saveSettings, currentForecast } from "./store.js";
import { fmtGBP, fmtMonth } from "./sheet.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const shortMonth = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return `${MON[(+m || 1) - 1]} '${y.slice(2)}`;
};
const signed = (n) => (n < 0 ? "−" : "+") + fmtGBP(Math.abs(n));

const SCENARIOS = [
  { id: "conservative", label: "Conservative" },
  { id: "realistic",    label: "Realistic" },
  { id: "optimistic",   label: "Optimistic" },
];

// ---------------------------------------------------------------------------
//  SVG chart — cash position over the horizon
// ---------------------------------------------------------------------------
function buildChart(fc) {
  const ms = fc.months;
  const n = ms.length;
  const W = 720, H = 300, padL = 46, padR = 16, padT = 18, padB = 26;
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

  // x-axis labels — thin them out so they never crowd
  const step = Math.max(1, Math.ceil(n / 6));
  const xLabels = ms.map((m, i) =>
    (i % step === 0 || i === n - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="ax-lbl">${shortMonth(m.month)}</text>`
      : "").join("");

  // points — plain, below-buffer (amber), negative (coral)
  const dots = ms.map((m, i) => {
    const neg = m.flags.includes("negative");
    const below = m.flags.includes("below_buffer");
    const tint = neg ? "coral" : below ? "amber" : "mint";
    const r = neg || below ? 3.2 : 2;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(m.cash).toFixed(1)}" r="${r}"
      fill="var(--${tint})" ${neg ? 'class="pt-danger"' : ""}/>`;
  }).join("");

  // circle the lowest point and annotate it
  let low = 0;
  ms.forEach((m, i) => { if (m.cash < ms[low].cash) low = i; });
  const lx = x(low), ly = y(ms[low].cash);
  const labelLeft = lx > W - 120;
  const low_ = `
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="none"
      stroke="var(--${ms[low].cash < fc.buffer ? "coral" : "mint"})" stroke-width="1.5" opacity=".9"/>
    <text x="${(labelLeft ? lx - 11 : lx + 11).toFixed(1)}" y="${(ly - 9).toFixed(1)}"
      text-anchor="${labelLeft ? "end" : "start"}" class="ax-lbl low">
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
    ${dots}${low_}
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

function breakdownList(title, items, sign) {
  if (!items.length) return "";
  const rows = items
    .filter((it) => Math.abs(it.amount) > 0.5)
    .map((it) => `<div class="bd-row"><span>${it.name}</span><span>${sign}${fmtGBP(Math.abs(it.amount))}</span></div>`)
    .join("");
  return rows ? `<div class="bd-grp"><div class="bd-h">${title}</div>${rows}</div>` : "";
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
      ${breakdownList("Out", m.breakdown.expenses, "−")}
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
//  Render
// ---------------------------------------------------------------------------
function render() {
  const root = document.getElementById("forecast-root");
  if (!root) return;
  const fc = currentForecast();
  const scenario = fc.scenario;

  const segs = SCENARIOS.map((s) =>
    `<button class="seg${s.id === scenario ? " on" : ""}" data-scenario="${s.id}">${s.label}</button>`).join("");

  root.innerHTML = `
    <div class="cf-top">
      <div><div class="eyebrow">Forecast</div>
        <p class="sec-sub">Cash position over ${fc.months.length} months · opening ${fmtGBP(fc.opening_cash)}. Red dashes are your buffer.</p></div>
    </div>
    <div class="segmented cf-scenario">${segs}</div>
    <div class="cf-card glass">${buildChart(fc)}</div>
    ${buildAlerts(fc)}
    <div class="cf-tablehead"><span>Month</span><span>Net</span><span>Cash</span><span></span></div>
    <div class="cf-table">${fc.months.map(monthRow).join("")}</div>`;

  // scenario switch — persists to settings.forecast_confidence (subscribers re-render)
  root.querySelectorAll("[data-scenario]").forEach((b) =>
    b.onclick = async () => {
      if (b.dataset.scenario === scenario) return;
      try { await saveSettings({ forecast_confidence: b.dataset.scenario }); }
      catch (e) { alert("Couldn't switch scenario: " + e.message); }
    });

  root.querySelectorAll("[data-toggle]").forEach((b) =>
    b.onclick = () => {
      const mo = b.dataset.toggle;
      expanded.has(mo) ? expanded.delete(mo) : expanded.add(mo);
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

export function mountForecast() {
  subscribe(render);
  render();
}
