// ============================================================================
//  settings.js — the gear sheet. Cash buffer, horizon, default scenario, the
//  Salaries editor (net income flows), and integration config (T212 / Emma).
//  Salaries are ordinary recurring_flows(kind=income) — this is just a focused
//  place to set them; life events can then link to a salary to model mat leave.
//  No priority-weight sliders (priority is a single manual field now).
// ============================================================================
import { state, saveSettings } from "./store.js";
import { openSheet, fmtGBP, fmtMonth } from "./sheet.js";

const SCEN = [
  { label: "Conservative", value: "conservative" },
  { label: "Realistic",    value: "realistic" },
  { label: "Optimistic",   value: "optimistic" },
];

const incomeFlows = () => state.recurring_flows.filter((f) => f.kind === "income");

// ---- salary child sheet (writes a recurring_flows income row) --------------
function editSalary(record, onDone) {
  const isNew = !record.id;
  const rec = isNew
    ? { name: "", amount: 0, start_month: null, end_month: null,
        annual_uplift_pct: null, uplift_month: 4, notes: null }
    : record;
  openSheet({
    title: isNew ? "New salary" : "Salary",
    table: "recurring_flows",
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "Lachlan salary (net)" },
      { key: "amount", label: "Net monthly £ (after tax/pension)", type: "money", step: "10" },
      { key: "start_month", label: "Start month", type: "month" },
      { key: "end_month", label: "End month (optional)", type: "month" },
      { key: "annual_uplift_pct", label: "Annual uplift %", type: "percent", step: "0.5", help: "e.g. 3 for a 3% yearly rise" },
      { key: "uplift_month", label: "Uplift month (1–12)", type: "number", min: 1, max: 12,
        showIf: (d) => d.annual_uplift_pct != null && d.annual_uplift_pct !== "" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    record: rec,
    derive: () => ({ kind: "income", category: "Salary" }),
    impact: (d) => `${fmtGBP(d.amount)}/mo net from ${fmtMonth(d.start_month)}`
      + (d.annual_uplift_pct ? ` · +${(d.annual_uplift_pct * 100).toFixed(1)}%/yr` : ""),
    onDone,
  });
}

// ---- the lower half of the settings sheet: salaries + integrations ---------
function renderExtra(box) {
  const rebuild = () => {
    const flows = incomeFlows();
    const total = flows.reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const rows = flows.length
      ? flows.map((f) => `<div class="li" data-flow="${f.id}">
          <div class="li-main"><span class="li-name">${f.name}</span></div>
          <div class="li-nums"><span class="li-est" style="color:var(--mint)">${fmtGBP(f.amount)}/mo</span></div>
        </div>`).join("")
      : `<div class="sec-empty" style="margin:0">No salaries yet. Add Lachlan &amp; Christine's net (after-tax) pay — that's the cash coming in.</div>`;

    box.innerHTML = `
      <div class="pi-head"><span class="eyebrow">Salaries (net)</span>
        <span class="pi-total">${flows.length ? fmtGBP(total) + "/mo" : ""}</span></div>
      <div class="li-list">${rows}</div>
      <button class="pi-add" data-addsalary><i data-lucide="plus"></i> Add salary</button>
      <p class="fld-help" style="margin-top:8px">To model mat leave or a pay drop, add a life event under Finances and link it to a salary — it will lower that salary for the period.</p>

      <div class="pi-head" style="margin-top:20px"><span class="eyebrow">Integrations</span></div>
      <p class="fld-help" style="margin:2px 0 8px">Read-only imports. Not live yet — config is saved for when they land.</p>`;

    box.querySelector("[data-addsalary]").onclick = () => editSalary({}, rebuild);
    box.querySelectorAll("[data-flow]").forEach((r) =>
      r.onclick = () => {
        const f = state.recurring_flows.find((x) => x.id === r.dataset.flow);
        if (f) editSalary(f, rebuild);
      });
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
  };
  rebuild();
}

export function openSettings() {
  const s = state.settings || {};
  openSheet({
    title: "Settings",
    table: "settings",
    saveLabel: "Save",
    fields: [
      { key: "cash_buffer", label: "Cash buffer £", type: "money", step: "100",
        help: "The red line your cash shouldn't dip below — your emergency-fund target." },
      { key: "horizon_months", label: "Forecast horizon (months)", type: "number", min: 1, max: 60, step: "1" },
      { key: "forecast_confidence", label: "Default scenario", type: "segmented", options: SCEN },
      { key: "t212_enabled", label: "Trading 212 sync", type: "toggle" },
      { key: "emma_sheet_url", label: "Emma CSV URL", type: "text", placeholder: "https://docs.google.com/…/pub?output=csv" },
    ],
    record: {
      cash_buffer: s.cash_buffer ?? 5000,
      horizon_months: s.horizon_months ?? 24,
      forecast_confidence: s.forecast_confidence ?? "realistic",
      t212_enabled: !!s.t212_enabled,
      emma_sheet_url: s.emma_sheet_url ?? null,
    },
    save: (clean) => saveSettings(clean),  // settings is keyed on household_id
    extra: (box) => renderExtra(box),
  });
}
