// ============================================================================
//  categories-page.js — the Categories screen (routed #/categories, Set up).
//  Lifts the category manager out of Spending: toggle counts-as-spend, move /
//  merge / delete buckets, add a category. Needs the Emma feed to enumerate the
//  categories that appear in transactions and to power the move tool.
// ============================================================================
import { subscribe } from "./store.js";
import { fetchEmma } from "./emma.js";
import { categoryManagerHtml, wireCategoryManager } from "./categories.js";

let txns = null, loadErr = null, loading = false;

async function load(force = false) {
  if (loading) return;
  loading = true; render();
  try {
    const res = await fetchEmma(force);
    txns = res.txns || [];
    loadErr = null;
  } catch (e) {
    loadErr = e.message || String(e);
  } finally {
    loading = false; render();
  }
}

function render() {
  const root = document.getElementById("categories-root");
  if (!root) return;

  const head = `<div class="mc-top">
    <div><div class="eyebrow">Categories</div>
      <p class="sec-sub">How transactions are bucketed for Spending, Reports &amp; the forecast.</p></div>
    <button class="sec-sync" data-refresh ${loading ? "disabled" : ""}>
      <i data-lucide="refresh-cw"></i>${loading ? "Loading…" : "Refresh"}</button>
  </div>`;

  let body;
  if (txns == null) {
    body = loadErr
      ? `<div class="sec-empty">Couldn't load Emma: ${loadErr}<br><button class="sp-load" data-refresh>Try again</button></div>`
      : `<div class="sec-empty">${loading ? "Loading categories…" : "Tap Refresh to load categories."}</div>`;
  } else {
    body = categoryManagerHtml(txns);
  }

  root.innerHTML = head + body;
  root.querySelectorAll("[data-refresh]").forEach((b) => b.onclick = () => load(true));
  if (txns != null) wireCategoryManager(root, txns, render);
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountCategoriesPage() {
  subscribe(() => {
    const scr = document.querySelector('.screen[data-screen="categories"]');
    if (scr && scr.classList.contains("active")) render();
  });
  render();
  load();
}
