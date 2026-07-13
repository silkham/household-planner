// ============================================================================
//  settings.js — the Settings PAGE (routed #/settings, not a pop-up sheet).
//  Cash buffer, forecast horizon, the "General Expenses" monthly budget, an
//  integrations placeholder, and About/version. Salaries live in Finances
//  (they're income recurring_flows); scenarios + Trading 212 were dropped.
// ============================================================================
import { state, subscribe, saveSettings } from "./store.js";
import { BUDGET_GROUP } from "./categories.js";
import { APP_VERSION, BUILD_DATE } from "./version.js";

const budgets = () => (state.settings && state.settings.forecast_budgets) || {};

// A labelled numeric field. `onSave(value)` gets the trimmed raw string.
function numField({ id, label, help, value, step, placeholder, prefix }) {
  const v = value != null && value !== "" ? value : "";
  return `<label class="set-field">
    <span class="set-label">${label}</span>
    <div class="set-inputwrap">
      ${prefix ? `<span class="set-prefix">${prefix}</span>` : ""}
      <input class="field" id="${id}" type="number" inputmode="decimal"
        step="${step || "1"}" value="${v}" placeholder="${placeholder || ""}" />
    </div>
    ${help ? `<span class="fld-help">${help}</span>` : ""}
  </label>`;
}

function render() {
  const root = document.getElementById("settings-root");
  if (!root) return;
  const s = state.settings || {};
  const geBudget = budgets()[BUDGET_GROUP];

  root.innerHTML = `
    <div class="mc-top">
      <div><div class="eyebrow">Settings</div>
        <p class="sec-sub">Forecast assumptions and app config.</p></div>
    </div>

    <section class="glass set-card">
      <div class="eyebrow">Forecast</div>
      ${numField({ id: "set-buffer", label: "Cash buffer £", step: "100",
        value: s.cash_buffer ?? 5000, prefix: "£",
        help: "The red line your cash shouldn't dip below — your emergency-fund target." })}
      ${numField({ id: "set-horizon", label: "Forecast horizon (months)", step: "1",
        value: s.horizon_months ?? 24,
        help: "How many months ahead the forecast projects." })}
      ${numField({ id: "set-gebudget", label: `“${BUDGET_GROUP}” monthly budget`, step: "10",
        value: geBudget, prefix: "£", placeholder: "e.g. 2500",
        help: "Your discretionary monthly budget — the one editable line on the “This month” panel." })}
    </section>

    <section class="glass set-card">
      <div class="eyebrow">Integrations</div>
      <p class="sec-sub">Emma transaction import is configured server-side. Nothing else to set up here yet.</p>
    </section>

    <section class="glass set-card">
      <div class="eyebrow">About</div>
      <p class="set-about">HouseholdOS Planner · <b>v${APP_VERSION}</b><br>built ${BUILD_DATE}</p>
    </section>`;

  // ---- wiring ----
  const buffer = root.querySelector("#set-buffer");
  buffer.onchange = () => saveNum({ cash_buffer: Number(buffer.value) || 0 });

  const horizon = root.querySelector("#set-horizon");
  horizon.onchange = () => {
    const n = Math.max(1, Math.min(60, Math.round(Number(horizon.value) || 24)));
    horizon.value = n;
    saveNum({ horizon_months: n });
  };

  const ge = root.querySelector("#set-gebudget");
  ge.onchange = () => {
    const raw = (ge.value || "").trim();
    const next = { ...budgets() };
    if (raw === "") delete next[BUDGET_GROUP];
    else next[BUDGET_GROUP] = Number(raw) || 0;
    saveNum({ forecast_budgets: next });
  };

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

async function saveNum(patch) {
  try { await saveSettings(patch); }
  catch (e) { alert("Couldn't save: " + e.message); }
}

export function mountSettings() {
  subscribe(() => {
    // Only re-render when this screen is active — avoid clobbering an input mid-edit.
    const scr = document.querySelector('.screen[data-screen="settings"]');
    if (scr && scr.classList.contains("active")) render();
  });
  render();
}
