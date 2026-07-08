// ============================================================================
//  spending.js — the Spending tab. Backward-looking twin of Forecast.
//  Reads the Emma transaction feed (via the emma-sheet Edge Function) and shows
//  actual outflows by month × category. Emma's own `Category` is the default;
//  a `category_rules` row (keyed on the merchant's `Custom Name`) overrides it.
//  Nothing here feeds the cashflow engine — this is the "where did it go?" view.
// ============================================================================
import { state, subscribe, saveRow, saveCategoryRule } from "./store.js";
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

// ---- month "position" panel (actuals, laid out like the forecast month row) -
// Groups the selected month's real Emma transactions the SAME way the forecast
// does: known recurring bills sit under their flow's category, and every other
// counting outflow collates into "General Expenses" (shown against its budget so
// you can sanity-check that figure). Income = actual inflows. Net = in − out.
// The known-bill carve-out mirrors reconcile.js (match on any identity field).
const enc = encodeURIComponent;
const GENERAL = "General Expenses";

function buildMonthActuals(month, monthTxns, rules, excluded) {
  // flows active in this month → their merchant keys, split by direction
  const flows = state.recurring_flows.filter((f) =>
    (!f.start_month || f.start_month <= month) && (!f.end_month || f.end_month >= month));
  const expKey = new Map();   // emma_match_key → expense flow category
  const incKey = new Map();   // emma_match_key → income flow name
  for (const f of flows) {
    if (!f.emma_match_key) continue;
    if (f.kind === "income") incKey.set(f.emma_match_key, f.name);
    else expKey.set(f.emma_match_key, f.category || "Other");
  }
  const matchAny = (map, t) =>
    map.get(t.customName) || map.get(t.merchant) || map.get(t.counterparty) || null;

  const income = new Map(), expense = new Map(), noncount = new Map();
  const bump = (map, key, amt, t) => {
    let g = map.get(key);
    if (!g) { g = { name: key, amount: 0, txns: [], sub: new Map() }; map.set(key, g); }
    g.amount += amt; g.txns.push(t);
    return g;
  };

  for (const t of monthTxns) {
    const cat = effCategory(t, rules);
    if (excluded.has(cat)) { if (t.amount < 0) bump(noncount, cat, -t.amount, t); continue; }
    if (t.amount > 0) { bump(income, matchAny(incKey, t) || "Other income", t.amount, t); }
    else if (t.amount < 0) {
      const g = bump(expense, matchAny(expKey, t) || GENERAL, -t.amount, t);
      // sub-breakdown by effective category — only surfaced for General Expenses
      let s = g.sub.get(cat); if (!s) { s = { name: cat, amount: 0, txns: [] }; g.sub.set(cat, s); }
      s.amount += -t.amount; s.txns.push(t);
    }
  }

  const byAmt = (a, b) => b.amount - a.amount;
  const byDate = (a, b) => (b.dateInt || 0) - (a.dateInt || 0);
  const fin = (arr) => arr.sort(byAmt).map((g) => {
    g.txns.sort(byDate);
    g.subArr = [...g.sub.values()].sort(byAmt);
    g.subArr.forEach((s) => s.txns.sort(byDate));
    return g;
  });
  const incomeArr = fin([...income.values()]);
  const expenseArr = fin([...expense.values()]);
  const nonArr = fin([...noncount.values()]);
  const totIn = incomeArr.reduce((s, g) => s + g.amount, 0);
  const totOut = expenseArr.reduce((s, g) => s + g.amount, 0);
  return { incomeArr, expenseArr, nonArr, totIn, totOut, net: totIn - totOut };
}

function spTx(t, cat) {
  return `<button class="sp-tx" data-key="${enc(txKey(t))}" data-cat="${enc(cat)}">
    <span class="sp-tx-name">${txKey(t)}</span>
    <span class="sp-tx-date">${t.date}</span>
    <span class="sp-tx-amt">${fmtGBP(Math.abs(t.amount))}</span>
    <i data-lucide="tag"></i></button>`;
}

// One expandable "Out"/"Not counted" category group. General Expenses expands to
// its sub-categories (each → transactions); everything else expands to txns.
function outGroup(g, { general = false, notcount = false } = {}) {
  const key = `${notcount ? "n" : "e"}:${g.name}`;
  const open = openCats.has(key);
  const budget = ((state.settings && state.settings.forecast_budgets) || {})[GENERAL];
  const badge = general && budget != null
    ? `<span class="sp-budget ${g.amount > budget + 0.005 ? "over" : ""}">/ ${fmtGBP(budget)} budget</span>` : "";
  const off = notcount ? ` <span class="sp-catoff">not counted</span>` : "";
  let body = "";
  if (open) {
    if (general) {
      body = g.subArr.map((s) => {
        const sk = `s:${s.name}`;
        const sopen = openCats.has(sk);
        const stx = sopen ? `<div class="bd-lines">${s.txns.map((t) => spTx(t, s.name)).join("")}</div>` : "";
        return `<div class="bd-cat ${sopen ? "open" : ""}">
          <button class="bd-cathead" data-gkey="${enc(sk)}">
            <i data-lucide="chevron-${sopen ? "down" : "right"}" class="bd-chev"></i>
            <span class="bd-catname">${s.name}</span>
            <span class="bd-catamt">−${fmtGBP(s.amount)}</span>
          </button>${stx}</div>`;
      }).join("");
    } else {
      body = `<div class="bd-lines">${g.txns.map((t) => spTx(t, g.name)).join("")}</div>`;
    }
  }
  return `<div class="bd-cat ${open ? "open" : ""} ${notcount ? "notcount" : ""}">
    <button class="bd-cathead" data-gkey="${enc(key)}">
      <i data-lucide="chevron-${open ? "down" : "right"}" class="bd-chev"></i>
      <span class="bd-catname">${g.name}${off}${badge}</span>
      <span class="bd-catamt">−${fmtGBP(g.amount)}</span>
    </button>${body}</div>`;
}

function monthPanelHtml(month, d) {
  const net = d.net;
  const pos = `<div class="sp-pos">
    <span class="sp-pos-mon">${fmtMonth(month)}</span>
    <span class="sp-pos-net" style="color:var(--${net < 0 ? "coral" : "mint"})">${net < 0 ? "−" : "+"}${fmtGBP(Math.abs(net))} net</span>
  </div>
  <div class="mr-nums">
    <span>Income <b style="color:var(--mint)">+${fmtGBP(d.totIn)}</b></span>
    <span>Expenses <b style="color:var(--coral)">−${fmtGBP(d.totOut)}</b></span>
  </div>`;

  const incomeHtml = d.incomeArr.length
    ? `<div class="bd-grp"><div class="bd-h">Income</div>${d.incomeArr.map((g) =>
        `<div class="bd-row"><span>${g.name}</span><span>+${fmtGBP(g.amount)}</span></div>`).join("")}</div>`
    : "";
  const outHtml = d.expenseArr.length
    ? `<div class="bd-grp"><div class="bd-h">Out</div>${d.expenseArr.map((g) =>
        outGroup(g, { general: g.name === GENERAL })).join("")}</div>`
    : "";
  const nonHtml = d.nonArr.length
    ? `<div class="bd-grp"><div class="bd-h">Not counted</div>${d.nonArr.map((g) =>
        outGroup(g, { notcount: true })).join("")}</div>`
    : "";

  return `<div class="sp-month glass">${pos}${incomeHtml}${outHtml}${nonHtml}</div>`;
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
      // Upsert on (household_id, match_key) — a rule for this merchant may
      // already exist (keyed on a different identity field / stale state), so a
      // plain insert would hit idx_hp_catrules_key. Upsert is collision-proof.
      await saveCategoryRule(key, cat);
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
      // ALL transactions for the month (both directions) — the panel splits them
      // into Income / known-bill categories / General Expenses / not-counted,
      // laid out like the forecast month row but from actuals.
      const monthAll = txns.filter((t) => monthOf(t.dateInt) === selMonth);
      const data = buildMonthActuals(selMonth, monthAll, rules, excluded);
      bodyHtml = promptHtml + `
        <div class="cf-card glass">${buildChart(months)}</div>
        ${monthPanelHtml(selMonth, data)}`;
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
  root.querySelectorAll("[data-gkey]").forEach((b) => b.onclick = () => {
    const c = decodeURIComponent(b.dataset.gkey);
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
