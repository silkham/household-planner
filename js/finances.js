// ============================================================================
//  finances.js — the Finances tab. Six sections, each backed by a table and
//  the shared bottom-sheet. Field schemas are data-driven; cards are per-type.
// ============================================================================
import { state, subscribe } from "./store.js";
import { openSheet, fmtGBP, fmtMonth } from "./sheet.js";
import { monthlyPayment } from "./engine.js";
import { syncBalancesFromEmma } from "./emma.js";
import { mountDetected } from "./recurring.js";

// ---- option lists ----------------------------------------------------------
const opt = (arr) => arr.map((v) => ({ label: v, value: v }));
const ACCOUNT_KINDS = opt(["current", "savings", "emergency", "investment", "other"]);
const FLOW_CATS = opt(["Salary","Housing","Childcare","Vehicle","Utilities","Groceries","Loan","Other"]);
const CONFIDENCE = opt(["confirmed", "likely", "speculative"]);
const FIN_STATUS = opt(["considering", "active", "declined", "repaid"]);
const EVENT_TYPES = [
  { label: "Income",   value: "income_change" },
  { label: "Expense",  value: "expense_change" },
  { label: "Lump sum", value: "lump_sum" },
  { label: "Decision", value: "decision_point" },
];
const KIND_SEG = [{ label: "Income", value: "income" }, { label: "Expense", value: "expense" }];

const badge = (text, tint) =>
  `<span class="hpill" style="background:color-mix(in srgb, var(--${tint}) 16%, transparent); color:var(--${tint})">${text}</span>`;
const CONF_TINT = { confirmed: "mint", likely: "blue", speculative: "amber" };
const FINST_TINT = { active: "mint", considering: "blue", declined: "text-faint", repaid: "violet" };

// months-since-update, for the staleness nudge
const daysSince = (iso) => iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null;

const incomeFlows = () =>
  state.recurring_flows.filter((f) => f.kind === "income")
    .map((f) => ({ label: f.name, value: f.id }));
const allFlows = () =>
  state.recurring_flows.map((f) => ({ label: f.name, value: f.id }));

// ============================================================================
//  Field schemas + live-impact per entity
// ============================================================================
const SCHEMAS = {
  accounts: {
    table: "accounts", title: "Account",
    blank: { name: "", kind: "current", balance: 0, available_for_projects: true, emma_account: null, notes: null },
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "Natwest current" },
      { key: "kind", label: "Kind", type: "select", options: ACCOUNT_KINDS },
      { key: "balance", label: "Balance today £", type: "money", step: "100",
        help: "Re-anchors to today. If linked to Emma, its feed keeps this current between edits." },
      { key: "available_for_projects", label: "Available for projects", type: "toggle" },
      { key: "emma_account", label: "Emma account name (optional)", type: "text", placeholder: "PREMIER SELECT",
        help: "Exact 'Account' name in the Emma sheet — links this account to the transaction feed." },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    // saving (re-)anchors the balance to today; Emma sync derives from here.
    derive: (d) => ({
      anchor_balance: d.balance,
      anchor_date: new Date().toISOString().slice(0, 10),
      balance_updated_at: new Date().toISOString(),
    }),
    impact: (d) => `${fmtGBP(d.balance)} · ${d.available_for_projects ? "counts toward projects" : "ring-fenced"}`,
  },

  recurring_flows: {
    table: "recurring_flows", title: "Recurring flow",
    blank: { name: "", kind: "expense", amount: 0, category: "Other", start_month: null,
             end_month: null, annual_uplift_pct: null, uplift_month: 4, emma_match_key: null, notes: null },
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "Mortgage" },
      { key: "kind", label: "Type", type: "segmented", options: KIND_SEG },
      { key: "amount", label: "Monthly £ (net)", type: "money", step: "10" },
      { key: "category", label: "Category", type: "select", options: FLOW_CATS },
      { key: "start_month", label: "Start month", type: "month" },
      { key: "end_month", label: "End month (optional)", type: "month" },
      { key: "annual_uplift_pct", label: "Annual uplift %", type: "percent", step: "0.5", help: "e.g. 3 for a 3% yearly rise" },
      { key: "uplift_month", label: "Uplift month (1–12)", type: "number", min: 1, max: 12,
        showIf: (d) => d.annual_uplift_pct != null && d.annual_uplift_pct !== "" },
      { key: "notes", label: "Notes", type: "textarea" },
      { key: "emma_match_key", type: "hidden" },  // links a detected flow back to its Emma merchant
    ],
    impact: (d) => `${d.kind === "income" ? "+" : "−"}${fmtGBP(d.amount)}/mo from ${fmtMonth(d.start_month)}`
      + (d.annual_uplift_pct ? ` · +${(d.annual_uplift_pct * 100).toFixed(1)}%/yr` : ""),
  },

  salary_changes: {
    table: "salary_changes", title: "Salary change",
    blank: { flow_id: null, effective_month: null, new_amount: 0, confidence: "likely", notes: null },
    fields: [
      { key: "flow_id", label: "Which salary", type: "select", options: incomeFlows, placeholder: "Select income flow…" },
      { key: "effective_month", label: "Effective month", type: "month" },
      { key: "new_amount", label: "New monthly net £", type: "money", step: "50" },
      { key: "confidence", label: "Confidence", type: "segmented", options: CONFIDENCE },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    impact: (d) => `New net ${fmtGBP(d.new_amount)}/mo from ${fmtMonth(d.effective_month)} · ${d.confidence}`,
  },

  bonuses: {
    table: "bonuses", title: "Bonus",
    blank: { name: "", expected_month: null, gross_amount: 0, net_amount: 0,
             confidence: "likely", recurs_annually: false, notes: null },
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "Annual bonus" },
      { key: "expected_month", label: "Expected month", type: "month" },
      { key: "gross_amount", label: "Gross £", type: "money", step: "100" },
      { key: "net_amount", label: "Net £ (feeds cashflow)", type: "money", step: "100" },
      { key: "confidence", label: "Confidence", type: "segmented", options: CONFIDENCE },
      { key: "recurs_annually", label: "Recurs every year", type: "toggle" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    impact: (d) => `${fmtGBP(d.net_amount)} net ${d.recurs_annually ? "every " : "in "}${fmtMonth(d.expected_month)} · ${d.confidence}`,
  },

  financing_options: {
    table: "financing_options", title: "Financing option",
    blank: { name: "", principal: 0, apr: 0, term_months: 60, start_month: null,
             linked_project_id: null, status: "considering", notes: null },
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "NatWest kitchen loan" },
      { key: "principal", label: "Principal £", type: "money", step: "500" },
      { key: "apr", label: "APR %", type: "percent", step: "0.1", help: "e.g. 6.5 — leave 0 for 0% credit" },
      { key: "term_months", label: "Term (months)", type: "number", min: 1, step: "1" },
      { key: "start_month", label: "Drawdown month", type: "month" },
      { key: "status", label: "Status", type: "segmented", options: FIN_STATUS,
        help: "Only 'active' options draw down in the forecast" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    impact: (d) => {
      const pay = monthlyPayment(d);
      return `${fmtGBP(pay)}/mo over ${d.term_months || 0} mo · draws ${fmtGBP(d.principal)}`;
    },
  },

  life_events: {
    table: "life_events", title: "Life event",
    typeField: "event_type",
    blank: { name: "", event_type: "expense_change", effective_month: null,
             duration_months: null, monthly_impact: 0, linked_flow_id: null, resolved: false, notes: null },
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "Nursery starts" },
      { key: "event_type", label: "Type", type: "segmented", options: EVENT_TYPES },
      { key: "effective_month", label: "Effective month", type: "month" },
      { key: "monthly_impact", label: "Monthly impact £ (− = worse)", type: "money", step: "50",
        showIf: (d) => d.event_type === "income_change" || d.event_type === "expense_change" },
      { key: "monthly_impact", label: "Amount £", type: "money", step: "50",
        showIf: (d) => d.event_type === "lump_sum" },
      { key: "duration_months", label: "Duration (months, blank = permanent)", type: "number", min: 1,
        showIf: (d) => d.event_type === "income_change" || d.event_type === "expense_change" },
      { key: "linked_flow_id", label: "Linked flow (optional)", type: "select", options: allFlows,
        placeholder: "None", showIf: (d) => d.event_type === "income_change" || d.event_type === "expense_change" },
      { key: "resolved", label: "Decision made", type: "toggle", showIf: (d) => d.event_type === "decision_point" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
    impact: (d) => {
      if (d.event_type === "decision_point") return d.resolved ? "Resolved" : "Decision pending";
      if (d.event_type === "lump_sum") return `One-off ${fmtGBP(d.monthly_impact)} in ${fmtMonth(d.effective_month)}`;
      const dur = d.duration_months ? `${d.duration_months} mo` : "ongoing";
      return `${fmtGBP(d.monthly_impact)}/mo from ${fmtMonth(d.effective_month)} · ${dur}`;
    },
  },
};

function edit(entity, record) {
  const s = SCHEMAS[entity];
  openSheet({
    title: record.id ? s.title : "New " + s.title.toLowerCase(),
    table: s.table, typeField: s.typeField, fields: s.fields, derive: s.derive,
    record: record.id ? record : { ...s.blank },
    impact: s.impact,
    onDone: render,
  });
}

// Open the recurring-flow sheet pre-filled from an arbitrary record (used by the
// Emma recurring detector — confirm-before-create, with the live cashflow ripple
// as the confirmation). `onDone` fires after the tab re-renders.
export function openRecurringSheet(record, onDone) {
  const s = SCHEMAS.recurring_flows;
  openSheet({
    title: record.id ? s.title : "New recurring flow",
    table: s.table, fields: s.fields,
    record: record.id ? record : { ...s.blank, ...record },
    impact: s.impact,
    onDone: () => { render(); onDone && onDone(); },
  });
}

// ============================================================================
//  Card renderers
// ============================================================================
const money = (n) => `<span class="fc-amt">${fmtGBP(n)}</span>`;

function accountCard(a) {
  const stale = daysSince(a.balance_updated_at);
  const nudge = stale != null && stale > 60
    ? `<span class="fc-nudge"><i data-lucide="alert-circle"></i>${stale}d old</span>` : "";
  const emma = a.emma_account ? badge("Emma", "violet") : "";
  return card(a, "accounts", `
    <div class="fc-main">
      <div class="fc-name">${a.name}</div>
      <div class="fc-sub">${badge(a.kind, "blue")} ${a.available_for_projects
        ? badge("available", "mint") : badge("ring-fenced", "text-faint")} ${emma} ${nudge}</div>
    </div>
    ${money(a.balance)}`);
}

function flowCard(f) {
  const tint = f.kind === "income" ? "mint" : "coral";
  const meta = [];
  if (f.end_month) meta.push(`→ ${fmtMonth(f.end_month)}`);
  if (f.annual_uplift_pct) meta.push(`+${(f.annual_uplift_pct * 100).toFixed(1)}%/yr`);
  return card(f, "recurring_flows", `
    <span class="fc-name">${f.name}</span>
    <span class="fc-catmini">${f.category || "Other"}</span>
    ${meta.length ? `<span class="fc-meta">${meta.join(" · ")}</span>` : ""}
    <span class="fc-amt" style="color:var(--${tint})">${f.kind === "income" ? "+" : "−"}${fmtGBP(f.amount)}</span>`,
    "compact");
}

function salaryChangeCard(sc) {
  const flow = state.recurring_flows.find((f) => f.id === sc.flow_id);
  return card(sc, "salary_changes", `
    <div class="fc-main">
      <div class="fc-name">${flow ? flow.name : "Salary"} → ${fmtGBP(sc.new_amount)}</div>
      <div class="fc-sub">${badge(sc.confidence, CONF_TINT[sc.confidence])}
        <span class="fc-dim">from ${fmtMonth(sc.effective_month)}</span></div>
    </div>`);
}

function bonusCard(b) {
  const rec = b.recurs_annually ? badge("annual", "violet") : "";
  return card(b, "bonuses", `
    <div class="fc-main">
      <div class="fc-name">${b.name}</div>
      <div class="fc-sub">${badge(b.confidence, CONF_TINT[b.confidence])} ${rec}
        <span class="fc-dim">${fmtMonth(b.expected_month)}</span></div>
    </div>
    ${money(b.net_amount)}`);
}

function financingCard(f) {
  const pay = monthlyPayment(f);
  const totalInterest = pay * (f.term_months || 0) - (f.principal || 0);
  return card(f, "financing_options", `
    <div class="fc-main">
      <div class="fc-name">${f.name}</div>
      <div class="fc-sub">${badge(f.status, FINST_TINT[f.status])}
        <span class="fc-dim">${fmtGBP(f.principal)} · ${fmtGBP(pay)}/mo · ${fmtGBP(totalInterest)} interest</span></div>
    </div>`);
}

function lifeEventCard(e) {
  const decision = e.event_type === "decision_point";
  const unresolved = decision && !e.resolved;
  let right = "";
  if (decision) right = unresolved
    ? `<button class="fc-cta" data-decide="${e.id}">Decide</button>`
    : badge("resolved", "mint");
  else if (e.event_type === "lump_sum") right = money(e.monthly_impact);
  else right = `<span class="fc-amt" style="color:var(--${e.monthly_impact < 0 ? "coral" : "mint"})">${
    e.monthly_impact >= 0 ? "+" : "−"}${fmtGBP(Math.abs(e.monthly_impact))}</span>`;
  const typeLabel = (EVENT_TYPES.find((t) => t.value === e.event_type) || {}).label || e.event_type;
  const dur = e.duration_months ? ` · ${e.duration_months} mo` : "";
  return card(e, "life_events", `
    <div class="fc-main">
      <div class="fc-name">${e.name}</div>
      <div class="fc-sub">${badge(typeLabel, decision ? "violet" : "blue")}
        <span class="fc-dim">${fmtMonth(e.effective_month)}${dur}</span></div>
    </div>
    ${right}`, unresolved ? "fc-alert" : "");
}

// shared card shell — clicking opens the edit sheet
function card(record, entity, inner, extraCls = "") {
  return `<div class="fcard ${extraCls}" data-entity="${entity}" data-id="${record.id}">${inner}</div>`;
}

// ============================================================================
//  Sections
// ============================================================================
function section(id, title, subtitle, bodyHtml, opts = {}) {
  const action = opts.action || "";
  const addBtn = opts.noAdd ? "" :
    `<button class="sec-add" data-add="${id}"><i data-lucide="plus"></i></button>`;
  const totals = opts.totals ? `<div class="sec-totals">${opts.totals}</div>` : "";
  return `<section class="fsection">
    <div class="sec-head">
      <div><div class="eyebrow">${title}</div>${subtitle ? `<p class="sec-sub">${subtitle}</p>` : ""}</div>
      <div class="sec-actions">${action}${addBtn}</div>
    </div>
    ${totals}
    <div class="sec-body">${bodyHtml}</div>
  </section>`;
}

const empty = (txt) => `<div class="sec-empty">${txt}</div>`;

function render() {
  const root = document.getElementById("finances-root");
  if (!root) return;

  // Accounts — split into spendable vs ring-fenced (investments) groups
  const spendable = state.accounts.filter((a) => a.available_for_projects);
  const investments = state.accounts.filter((a) => !a.available_for_projects);
  const avail = spendable.reduce((s, a) => s + (+a.balance || 0), 0);
  const ring = investments.reduce((s, a) => s + (+a.balance || 0), 0);
  const acctGroup = (label, list, total) => list.length
    ? `<div class="fc-group-label">${label}<span class="fc-group-total">${fmtGBP(total)}</span></div>`
      + list.map(accountCard).join("")
    : "";
  const accountsBody = state.accounts.length
    ? acctGroup("Spendable", spendable, avail)
      + acctGroup("Investments &amp; savings", investments, ring)
    : empty("No accounts yet.");
  const accountsTotals = state.accounts.length
    ? `${badge("available " + fmtGBP(avail), "mint")} ${badge("ring-fenced " + fmtGBP(ring), "text-faint")}` : "";
  // Emma sync button — only when a sheet is configured
  const emmaLinked = state.accounts.some((a) => a.emma_account);
  const syncAction = (state.settings && state.settings.emma_sheet_id && emmaLinked)
    ? `<button class="sec-sync" data-sync="1"><i data-lucide="refresh-cw"></i>Sync Emma</button>` : "";

  // Recurring
  const flowsBody = state.recurring_flows.length
    ? state.recurring_flows.map(flowCard).join("")
    : empty("No recurring income or expenses yet. Add your salaries, mortgage, nursery…");

  // Salary changes — needs an income flow to attach to
  let salaryBody, salaryOpts = {};
  if (incomeFlows().length === 0) {
    salaryBody = empty("Add an income flow under Recurring first, then schedule step-changes here (e.g. Christine's partnership uplift).");
    salaryOpts.noAdd = true;
  } else {
    salaryBody = state.salary_changes.length
      ? state.salary_changes.map(salaryChangeCard).join("")
      : empty("No scheduled salary changes.");
  }

  // Bonuses
  const bonusBody = state.bonuses.length ? state.bonuses.map(bonusCard).join("") : empty("No bonuses yet.");

  // Financing
  const finBody = state.financing_options.length
    ? state.financing_options.map(financingCard).join("") : empty("No financing options modelled.");

  // Life events — timeline, chronological (nulls last)
  const sorted = [...state.life_events].sort((a, b) =>
    (a.effective_month || "9999") < (b.effective_month || "9999") ? -1 : 1);
  const lifeBody = sorted.length ? sorted.map(lifeEventCard).join("")
    : empty("No life events yet. Mat leave, PCP end, nursery start live here.");

  root.innerHTML =
    section("accounts", "Accounts", "Where money sits. Emergency & investments are ring-fenced from projects.", accountsBody, { totals: accountsTotals, action: syncAction }) +
    `<div id="recurring-detect"></div>` +
    section("recurring_flows", "Recurring", "Monthly income and outgoings.", flowsBody) +
    section("salary_changes", "Salary changes", "Step-changes that aren't just annual uplifts.", salaryBody, salaryOpts) +
    section("bonuses", "Bonuses", "Lumpy annual income, weighted by confidence.", bonusBody) +
    section("financing_options", "Financing options", "Loans & credit. Only 'active' options draw down.", finBody) +
    section("life_events", "Life events", "The big rocks, on a timeline.", lifeBody);

  // wire interactions
  root.querySelectorAll("[data-add]").forEach((b) =>
    b.onclick = () => edit(b.dataset.add, {}));
  root.querySelectorAll(".fcard").forEach((c) =>
    c.onclick = (e) => {
      if (e.target.closest("[data-decide]")) return; // handled below
      const rec = state[c.dataset.entity].find((r) => r.id === c.dataset.id);
      if (rec) edit(c.dataset.entity, rec);
    });
  root.querySelectorAll("[data-decide]").forEach((b) =>
    b.onclick = (e) => {
      e.stopPropagation();
      const rec = state.life_events.find((r) => r.id === b.dataset.decide);
      if (rec) edit("life_events", rec);
    });
  const syncBtn = root.querySelector("[data-sync]");
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.innerHTML = `<i data-lucide="loader"></i>Syncing…`;
    window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
    try {
      const { updated, txnCount } = await syncBalancesFromEmma();
      // loadAll() inside sync triggers a re-render via subscribe; flash a note
      console.log(`Emma sync: ${updated} account(s) from ${txnCount} transactions`);
    } catch (err) {
      alert("Emma sync failed: " + err.message);
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<i data-lucide="refresh-cw"></i>Sync Emma`;
      window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
    }
  };
  // Emma recurring-payment detector (self-managed, lazy fetch)
  mountDetected(openRecurringSheet);

  window.lucide && lucide.createIcons({ nameAttr: "data-lucide" });
}

export function mountFinances() {
  subscribe(render);
  render();
}
