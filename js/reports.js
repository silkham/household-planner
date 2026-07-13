// ============================================================================
//  reports.js — the Reports / Budgeting tab (stub).
//  Where we analyse spending over time to find costs to kill. Built out in a
//  later V2 step; this stub keeps the nav complete and navigable.
// ============================================================================
function render() {
  const root = document.getElementById("reports-root");
  if (!root) return;
  root.innerHTML = `
    <div class="p-head">
      <div><div class="eyebrow">Reports</div>
        <p class="sec-sub">Spending trends and where to save.</p></div>
    </div>
    <div class="glass tile">
      <h2>Find costs to kill</h2>
      <p class="muted">Category spend over months, biggest movers, and savings
        opportunities will live here — the place to sit down and analyse where
        the money goes.</p>
      <div class="pending"><i data-lucide="hammer"></i>Coming in a later V2 step</div>
    </div>`;
  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountReports() { render(); }
