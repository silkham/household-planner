// ============================================================================
//  spending.js — the Spending tab. Backward-looking twin of Forecast.
//  Reads the Emma transaction feed (via the emma-sheet Edge Function) and shows
//  actual outflows by month × category. Emma's own `Category` is the default;
//  a `category_rules` row (keyed on the merchant's `Custom Name`) overrides it.
//  Nothing here feeds the cashflow engine — this is the "where did it go?" view.
// ============================================================================
import { state, subscribe, saveRow } from "./store.js";
import { fetchEmma } from "./emma.js";
import { openSheet, fmtGBP, fmtMonth } from "./sheet.js";
import { buildExcludedSet, categoryNames, categoryManagerHtml, wireCategoryManager, txnKey, effectiveCategory } from "./categories.js";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const shortMonth = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return `${MON[(+m || 1) - 1]} '${y.slice(2)}`;
};

// ---- module state ----------------------------------------------------------
let txns = null;        // cached feed rows (null = not loaded yet)
let loading = false;
let loadErr = null;
let selMonth = null;    // 'YYYY-MM' currently shown
let openCats = new Set(); // expanded category names in the selected month
let searchQ = "";       // transaction search query (all txns, any category)

// ---- helpers ---------------------------------------------------------------
// Shared merchant key + rule-aware category (multi-field match, so a re-tag
// sticks across every month even when Emma's Custom Name varies).
const txKey = txnKey;
const effCategory = effectiveCategory;

function rulesMap() {
  const m = new Map();
  for (const r of state.category_rules) m.set(r.match_key, r.category);
  return m;
}

// yyyymmdd int → 'YYYY-MM'
function monthOf(dateInt) {
  if (!dateInt) return null;
  const y = Math.floor(dateInt / 10000);
  const m = Math.floor((dateInt % 10000) / 100);
  return `${y}-${String(m).padStart(2, "0")}`;
}

// A spend transaction: an outflow whose effective category still counts.
function isSpend(t, rules, excluded) {
  return t.amount < 0 && !excluded.has(effCategory(t, rules));
}

// ---- data load -------------------------------------------------------------
async function load(force = false) {
  if (loading || (txns && !force)) return;
  loading = true; loadErr = null; render();
  try {
    const res = await fetchEmma(force);
    txns = res.txns || [];
  } catch (e) {
    loadErr = e.message || String(e);
  } finally {
    loading = false;
    render();
  }
}

// ---- monthly-total bar chart -----------------------------------------------
function buildChart(months) {
  // months: [{month, total}] ascending. Show the most recent 12.
  const show = months.slice(-12);
  const n = show.length;
  if (!n) return "";
  const W = 720, H = 190, padL = 46, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bottom = padT + plotH;
  const max = Math.max(1, ...show.map((m) => m.total));
  const gap = 8;
  const bw = (plotW / n) - gap;

  const bars = show.map((m, i) => {
    const bx = padL + i * (plotW / n) + gap / 2;
    const bh = (m.total / max) * plotH;
    const by = bottom - bh;
    const on = m.month === selMonth;
    const tint = on ? "mint" : "blue";
    const lbl = (i % Math.max(1, Math.ceil(n / 6)) === 0 || i === n - 1)
      ? `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ax-lbl">${shortMonth(m.month)}</text>`
      : "";
    return `<g class="sp-bar" data-month="${m.month}" style="cursor:pointer">
      <rect x="${bx.toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" fill="transparent"/>
      <rect class="sp-barfill" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${bh.toFixed(1)}" rx="3" fill="var(--${tint})" opacity="${on ? 1 : 0.55}"
        style="transform-box:fill-box;transform-origin:bottom;--h:${bh.toFixed(1)}"/>
      ${on ? `<text x="${(bx + bw / 2).toFixed(1)}" y="${(by - 5).toFixed(1)}" text-anchor="middle" class="ax-lbl low">${fmtGBP(m.total)}</text>` : ""}
      ${lbl}</g>`;
  }).join("");

  return `<svg class="sp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Monthly spend over ${n} months">
    <line x1="${padL}" y1="${bottom}" x2="${W - padR}" y2="${bottom}" stroke="var(--hairline)" stroke-width="1"/>
    <text x="${padL - 8}" y="${padT + 4}" text-anchor="end" class="ax-lbl">${fmtGBP(max)}</text>
    ${bars}</svg>`;
}

// ---- category rows for the selected month ----------------------------------
// Takes ALL outflows for the month. Counting categories render first with
// proportion bars (their sum = the "£X spent" figure); non-counting buckets
// (Transfers / Excluded) follow under a divider, marked "not counted" and
// omitted from the proportion grand total — visible & expandable so a bill
// swept into Transfers can be spotted and re-filed, without inflating spend.
function categoryRows(monthOutflows, rules, excluded) {
  const groups = new Map();
  for (const t of monthOutflows) {
    const cat = effCategory(t, rules);
    if (!groups.has(cat)) groups.set(cat, { cat, total: 0, txns: [], counts: !excluded.has(cat) });
    const g = groups.get(cat);
    g.total += -t.amount;   // outflow magnitude
    g.txns.push(t);
  }
  const all = [...groups.values()];
  const counting = all.filter((g) => g.counts).sort((a, b) => b.total - a.total);
  const noncount = all.filter((g) => !g.counts).sort((a, b) => b.total - a.total);
  const grand = counting.reduce((s, g) => s + g.total, 0) || 1;

  const rowHtml = (g) => {
    const isOpen = openCats.has(g.cat);
    const pct = g.counts ? Math.round((g.total / grand) * 100) : 0;
    const txRows = isOpen
      ? g.txns.slice().sort((a, b) => (b.dateInt || 0) - (a.dateInt || 0)).map((t) => `
          <button class="sp-tx" data-key="${encodeURIComponent(txKey(t))}" data-cat="${encodeURIComponent(g.cat)}">
            <span class="sp-tx-name">${txKey(t)}</span>
            <span class="sp-tx-date">${t.date}</span>
            <span class="sp-tx-amt">${fmtGBP(-t.amount)}</span>
            <i data-lucide="tag"></i>
          </button>`).join("")
      : "";
    return `<div class="sp-catrow ${isOpen ? "open" : ""} ${g.counts ? "" : "notcount"}">
      <button class="sp-cathead" data-cat="${encodeURIComponent(g.cat)}">
        <span class="sp-catname">${g.cat}${g.counts ? "" : ` <span class="sp-catoff">not counted</span>`}</span>
        ${g.counts ? `<span class="sp-catbar"><span style="width:${pct}%"></span></span>` : `<span class="sp-catbar off"></span>`}
        <span class="sp-catamt">${fmtGBP(g.total)}</span>
        <i data-lucide="chevron-${isOpen ? "up" : "down"}" class="sp-chev"></i>
      </button>${txRows}</div>`;
  };

  const countHtml = counting.map(rowHtml).join("");
  const nonHtml = noncount.length
    ? `<div class="sp-notcount-div">Not counted as spend — transfers, excluded, card payments</div>`
      + noncount.map(rowHtml).join("")
    : "";
  return countHtml + nonHtml;
}

// ---- "needs a category" prompt ---------------------------------------------
// Every unmapped merchant (effective category = Uncategorised) that counts as
// spend, biggest first — one tap opens the same categorise sheet. This is the
// backstop for strict categorisation: nothing new is silently mis-bucketed.
function uncategorisedHtml(spend, rules) {
  const agg = new Map();
  for (const t of spend) {
    if (effCategory(t, rules) !== "Uncategorised") continue;
    const k = txnKey(t);
    const a = agg.get(k) || { key: k, count: 0, total: 0 };
    a.count += 1; a.total += -t.amount; agg.set(k, a);
  }
  if (!agg.size) return "";
  const list = [...agg.values()].sort((a, b) => b.total - a.total);
  const total = list.reduce((s, x) => s + x.total, 0);
  const shown = list.slice(0, 25);
  const rows = shown.map((x) => `
    <button class="sp-uncat-row" data-uncat="${encodeURIComponent(x.key)}">
      <span class="sp-uncat-name">${x.key}</span>
      <span class="sp-uncat-meta">${x.count}× · ${fmtGBP(x.total)}</span>
      <i data-lucide="chevron-right"></i>
    </button>`).join("");
  const more = list.length > shown.length
    ? `<div class="sp-uncat-more">+${list.length - shown.length} more — biggest shown first</div>` : "";
  return `<div class="sp-uncat glass">
    <div class="sp-uncat-head">
      <div>
        <div class="sp-uncat-title">${list.length} merchant${list.length === 1 ? "" : "s"} need a category</div>
        <div class="sp-uncat-sub">${fmtGBP(total)} unsorted · tap to file each one</div>
      </div>
      <span class="sp-uncat-badge">${list.length}</span>
    </div>${rows}${more}</div>`;
}

// ---- re-categorise sheet ---------------------------------------------------
function categorise(key, currentCat) {
  const existing = state.category_rules.find((r) => r.match_key === key);
  const excluded = buildExcludedSet(state.categories);
  const options = categoryNames(state.categories, txns || [], rulesMap())
    .map((n) => ({ value: n, label: excluded.has(n) ? `${n} · not counted` : n }));
  const current = existing ? existing.category
    : (currentCat === "Uncategorised" ? "" : currentCat);

  openSheet({
    title: `Categorise “${key}”`,
    table: "category_rules",   // keeps the quiet Delete → revert to Emma's category
    record: existing || { match_key: key, category: current },
    fields: [
      { key: "category", label: "Category", type: "select", options, placeholder: "Choose a category…",
        help: `Applies to every transaction from “${key}”, past & future.` },
      { key: "_newCat", label: "…or add a new one", type: "text", placeholder: "e.g. Home improvement" },
    ],
    // custom write: optionally create the new category, then upsert the rule
    save: async (clean) => {
      let cat = clean.category;
      const fresh = (clean._newCat || "").trim();
      if (fresh) {
        cat = fresh;
        if (!state.categories.some((c) => c.name.toLowerCase() === fresh.toLowerCase()))
          await saveRow("categories", { name: fresh, counts_as_spend: true, sort_order: 99 });
      }
      if (!cat) throw new Error("Pick or add a category.");
      await saveRow("category_rules", { ...(existing ? { id: existing.id } : {}), match_key: key, category: cat });
    },
    onDone: render,
  });
}

// ---- transaction search ----------------------------------------------------
// Searches ALL transactions (any category — incl. non-counting Transfers /
// Excluded — and both directions) by merchant, category, date or amount. This
// is the "show me everything" escape hatch: find a mortgage swept into
// Transfers, see it, and re-file it via the same categorise sheet.
function searchResults(rules, excluded) {
  const q = searchQ.trim().toLowerCase();
  if (!q) return "";
  const scored = [];
  for (const t of txns) {
    const name = txKey(t);
    const cat = effCategory(t, rules);
    const amtStr = Math.abs(t.amount).toFixed(2);
    const hay = `${name} ${cat} ${t.date || ""} ${amtStr}`.toLowerCase();
    if (hay.includes(q)) scored.push({ t, name, cat });
  }
  scored.sort((a, b) => (b.t.dateInt || 0) - (a.t.dateInt || 0));
  const CAP = 80;
  const shown = scored.slice(0, CAP);
  if (!scored.length)
    return `<div class="sp-srch-res"><div class="sp-srch-meta">No transactions match “${searchQ}”.</div></div>`;
  const rows = shown.map(({ t, name, cat }) => {
    const off = excluded.has(cat);
    const inflow = t.amount > 0;
    return `<button class="sp-sr" data-key="${encodeURIComponent(name)}" data-cat="${encodeURIComponent(cat)}">
      <span class="sp-sr-name">${name}</span>
      <span class="sp-sr-cat ${off ? "off" : ""}">${cat}${off ? " · off" : ""}</span>
      <span class="sp-sr-date">${t.date || ""}</span>
      <span class="sp-sr-amt ${inflow ? "in" : ""}">${inflow ? "+" : ""}${fmtGBP(Math.abs(t.amount))}</span>
      <i data-lucide="tag"></i>
    </button>`;
  }).join("");
  const meta = `${scored.length} match${scored.length === 1 ? "" : "es"}${scored.length > CAP ? ` · showing ${CAP}` : ""} · tap to re-file`;
  return `<div class="sp-srch-res"><div class="sp-srch-meta">${meta}</div>${rows}</div>`;
}

// ---- render ----------------------------------------------------------------
function render() {
  const root = document.getElementById("spending-root");
  if (!root) return;
  const rules = rulesMap();
  const excluded = buildExcludedSet(state.categories);

  const head = `<div class="sp-top">
    <div><div class="eyebrow">Spending</div>
      <p class="sec-sub">Actual outflows from Emma, by month & category. Excludes categories turned off below.</p></div>
    <button class="sec-sync" data-refresh ${loading ? "disabled" : ""}>
      <i data-lucide="refresh-cw"></i>${loading ? "Loading…" : "Refresh"}</button>
  </div>`;

  // Search box (once the feed is loaded) — searches ALL transactions.
  const searchBox = txns != null ? `<div class="sp-search">
    <i data-lucide="search"></i>
    <input id="sp-search" type="text" placeholder="Search all transactions — merchant, category, amount…"
      value="${searchQ.replace(/"/g, "&quot;")}" autocomplete="off">
    ${searchQ ? `<button class="sp-srch-clr" data-srch-clr aria-label="Clear"><i data-lucide="x"></i></button>` : ""}
  </div>` : "";

  let bodyHtml;
  if (loadErr) {
    bodyHtml = `<div class="sec-empty">Couldn't load Emma: ${loadErr}<br><button class="sp-load" data-refresh>Try again</button></div>`;
  } else if (txns == null) {
    bodyHtml = `<div class="sec-empty">${loading ? "Loading spending…" : `<button class="sp-load" data-refresh>Load spending from Emma</button>`}</div>`;
  } else if (searchQ.trim()) {
    // Search mode — show only the results (month view + prompt hidden for focus).
    bodyHtml = searchResults(rules, excluded);
  } else {
    const spend = txns.filter((t) => isSpend(t, rules, excluded));
    const promptHtml = uncategorisedHtml(spend, rules);
    // monthly totals
    const byMonth = new Map();
    for (const t of spend) {
      const mk = monthOf(t.dateInt);
      if (!mk) continue;
      byMonth.set(mk, (byMonth.get(mk) || 0) + -t.amount);
    }
    const months = [...byMonth.entries()].map(([month, total]) => ({ month, total }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));

    if (!months.length) {
      bodyHtml = promptHtml + `<div class="sec-empty">No spend transactions found in the feed.</div>`;
    } else {
      if (!selMonth || !byMonth.has(selMonth)) selMonth = months[months.length - 1].month;
      // ALL outflows for the month (counting + non-counting) — categoryRows
      // splits them; the "£X spent" figure stays counting-only (byMonth).
      const monthOutflows = txns.filter((t) => t.amount < 0 && monthOf(t.dateInt) === selMonth);
      const monthTotal = byMonth.get(selMonth) || 0;
      bodyHtml = promptHtml + `
        <div class="cf-card glass">${buildChart(months)}</div>
        <div class="sp-selhead">
          <span class="sp-selmon">${fmtMonth(selMonth)}</span>
          <span class="sp-seltot">${fmtGBP(monthTotal)} spent</span>
        </div>
        <div class="sp-cats">${categoryRows(monthOutflows, rules, excluded)}</div>`;
    }
  }

  // Category manager sits at the foot of the tab once the feed is loaded
  // (hidden while searching to keep the results view focused).
  const managerHtml = (txns != null && !searchQ.trim()) ? categoryManagerHtml(txns) : "";
  root.innerHTML = head + searchBox + bodyHtml + managerHtml;

  // wiring
  const srch = root.querySelector("#sp-search");
  if (srch) {
    // Full re-render on input would drop focus — restore it + caret to the end.
    srch.oninput = () => {
      searchQ = srch.value;
      const caret = srch.selectionStart;
      render();
      const again = document.getElementById("sp-search");
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch {} }
    };
  }
  root.querySelectorAll("[data-srch-clr]").forEach((b) => b.onclick = () => {
    searchQ = ""; render();
    const el = document.getElementById("sp-search"); if (el) el.focus();
  });
  root.querySelectorAll(".sp-sr").forEach((b) => b.onclick = () => {
    categorise(decodeURIComponent(b.dataset.key), decodeURIComponent(b.dataset.cat));
  });
  if (txns != null && !searchQ.trim()) wireCategoryManager(root, txns, render);
  root.querySelectorAll("[data-refresh]").forEach((b) => b.onclick = () => load(true));
  root.querySelectorAll(".sp-bar").forEach((g) => g.onclick = () => {
    selMonth = g.dataset.month; openCats.clear(); render();
  });
  root.querySelectorAll(".sp-cathead").forEach((b) => b.onclick = () => {
    const c = decodeURIComponent(b.dataset.cat);
    openCats.has(c) ? openCats.delete(c) : openCats.add(c);
    render();
  });
  root.querySelectorAll(".sp-tx").forEach((b) => b.onclick = () => {
    const key = decodeURIComponent(b.dataset.key);
    const cat = decodeURIComponent(b.dataset.cat);
    categorise(key, cat);
  });
  root.querySelectorAll("[data-uncat]").forEach((b) => b.onclick = () =>
    categorise(decodeURIComponent(b.dataset.uncat), "Uncategorised"));

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountSpending() {
  subscribe(render);   // re-render when category_rules (or anything) changes
  render();
  load();              // lazy first fetch, non-blocking
}
