// ============================================================================
//  merchants.js — the Merchants tab (stub).
//  Biggest spends, changes over time, and the home for all-transaction
//  browsing (filter + sort). Built out in a later V2 step; this stub keeps the
//  nav complete and navigable.
// ============================================================================
function render() {
  const root = document.getElementById("merchants-root");
  if (!root) return;
  root.innerHTML = `
    <div class="p-head">
      <div><div class="eyebrow">Merchants</div>
        <p class="sec-sub">Who you pay, and how much.</p></div>
    </div>
    <div class="glass tile">
      <h2>Your biggest spends</h2>
      <p class="muted">Every merchant ranked by spend, month-on-month changes,
        and a filterable, sortable view of all transactions will live here.</p>
      <div class="pending"><i data-lucide="store"></i>Coming in a later V2 step</div>
    </div>`;
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountMerchants() { render(); }
