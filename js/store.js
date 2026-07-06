// ============================================================================
//  store.js — Supabase client, household resolution, state cache + CRUD.
//  All planner data lives in the `house_project` schema — use the HP handle.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeForecast } from "./engine.js";

const SUPABASE_URL  = "https://dgbbyijhabjozqrkokrq.supabase.co";
// anon key is a public client key — RLS is the real gate.
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnYmJ5aWpoYWJqb3pxcmtva3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMTA2ODgsImV4cCI6MjA5NDU4NjY4OH0.0VnZVRXNexVQBoYFrVXtGo9Ep-Gdv_04jGcX9NQLcE0";

export const supa = createClient(SUPABASE_URL, SUPABASE_ANON);
// Every planner read/write goes through this — supa.from() would hit `public`.
export const HP = supa.schema("house_project");
window.__supa = supa; window.__HP = HP;  // handy in the console during dev

// Known household from Session 1 ("Our household") — fallback only.
const FALLBACK_HOUSEHOLD = "13b5e642-3f21-403c-8336-56976f177269";

// ---- household id resolution ----------------------------------------------
let householdId = null;
export function getHousehold() { return householdId; }

export async function resolveHousehold() {
  if (householdId) return householdId;
  // Primary: the SECURITY DEFINER helper that RLS itself uses.
  const { data, error } = await HP.rpc("my_household_ids");
  if (!error && Array.isArray(data) && data.length) {
    householdId = data[0];
  } else {
    householdId = FALLBACK_HOUSEHOLD;
  }
  return householdId;
}

// ---- in-memory state cache -------------------------------------------------
const TABLES = [
  "accounts", "recurring_flows", "salary_changes", "bonuses",
  "financing_options", "life_events", "projects", "project_items",
];

export const state = {
  accounts: [], recurring_flows: [], salary_changes: [], bonuses: [],
  financing_options: [], life_events: [], projects: [], project_items: [],
  settings: null,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit() { subs.forEach((fn) => fn(state)); }

export async function loadAll() {
  const results = await Promise.all(TABLES.map((t) => HP.from(t).select("*")));
  TABLES.forEach((t, i) => {
    if (results[i].error) console.error(`load ${t}:`, results[i].error.message);
    state[t] = results[i].data || [];
  });
  const s = await HP.from("settings").select("*").maybeSingle();
  state.settings = s.data || null;
  emit();
  return state;
}

// ---- generic CRUD ----------------------------------------------------------
// `row` carries only schema fields (+ id for edits); household_id is added here.
export async function saveRow(table, row) {
  const hid = await resolveHousehold();
  const { id, ...rest } = row;
  const payload = { ...rest, household_id: hid };
  const q = id
    ? HP.from(table).update(payload).eq("id", id).select()
    : HP.from(table).insert(payload).select();
  const { data, error } = await q;
  if (error) throw error;
  await loadAll();
  return data && data[0];
}

export async function deleteRow(table, id) {
  const { error } = await HP.from(table).delete().eq("id", id);
  if (error) throw error;
  await loadAll();
}

// settings is a singleton keyed on household_id (no `id`), so it needs its own
// save path — upsert on the PK rather than the generic id-based saveRow.
export async function saveSettings(patch) {
  const hid = await resolveHousehold();
  const payload = { ...patch, household_id: hid };
  const { error } = state.settings
    ? await HP.from("settings").update(payload).eq("household_id", hid)
    : await HP.from("settings").insert(payload);
  if (error) throw error;
  await loadAll();
}

// ---- shared live forecast --------------------------------------------------
// Feeds the engine derived project costs (sum of line items when present) so the
// forecast is correct even if a stored estimated_cost has drifted. Used by the
// Forecast tab and the Projects affordability ticks — one source of truth.
export function currentForecast() {
  const projects = state.projects.map((p) => {
    const items = state.project_items.filter((i) => i.project_id === p.id);
    if (!items.length) return p;
    const est = items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0);
    const act = items.reduce((s, i) => s + (i.actual_cost == null ? 0 : Number(i.actual_cost)), 0);
    return { ...p, estimated_cost: est, actual_cost: act };
  });
  return computeForecast({
    accounts: state.accounts, recurring_flows: state.recurring_flows,
    salary_changes: state.salary_changes, life_events: state.life_events,
    bonuses: state.bonuses, projects, financing_options: state.financing_options,
    settings: state.settings || {},
    scenario: (state.settings && state.settings.forecast_confidence) || "realistic",
  });
}

// ---- idempotent placeholder seed (per spec — client-side, first open) ------
export async function seedIfEmpty() {
  const hid = await resolveHousehold();
  if (!hid) return;
  const H = { household_id: hid };
  const inserts = [];

  if (!state.settings) inserts.push(HP.from("settings").insert({ ...H }));

  if (state.accounts.length === 0) {
    inserts.push(HP.from("accounts").insert([
      { ...H, name: "Joint current",     kind: "current",    available_for_projects: true,  notes: "TBC" },
      { ...H, name: "Emergency fund",     kind: "emergency",  available_for_projects: false, notes: "TBC — buffer protects this" },
      { ...H, name: "Trading 212 ISA",    kind: "investment", available_for_projects: false, notes: "TBC — ring-fenced" },
      { ...H, name: "Cash ISA",           kind: "savings",    available_for_projects: true,  notes: "TBC" },
    ]));
  }

  if (state.bonuses.length === 0) {
    inserts.push(HP.from("bonuses").insert([
      { ...H, name: "Lachlan annual bonus",  expected_month: null, net_amount: 0, confidence: "likely", recurs_annually: true, notes: "TBC — expected March" },
      { ...H, name: "Christine annual bonus", expected_month: null, net_amount: 0, confidence: "likely", recurs_annually: true, notes: "TBC — expected March" },
    ]));
  }

  if (state.life_events.length === 0) {
    // NOTE: PostgREST bulk insert uses the UNION of keys across rows — any row
    // missing a key is sent NULL (not the column default). `resolved` is NOT
    // NULL, so every row must carry it explicitly or the whole batch fails.
    inserts.push(HP.from("life_events").insert([
      { ...H, name: "Christine mat leave 2", event_type: "income_change",  duration_months: 9, monthly_impact: 0, resolved: false, notes: "TBC" },
      { ...H, name: "Nursery starts",        event_type: "expense_change", duration_months: null, monthly_impact: 0, resolved: false, notes: "TBC" },
      { ...H, name: "PCP ends on 2nd car",   event_type: "decision_point", duration_months: null, monthly_impact: 0, resolved: false, notes: "TBC — options: keep + buy out / new PCP / lease / drop to one car" },
    ]));
  }

  if (state.financing_options.length === 0) {
    inserts.push(HP.from("financing_options").insert([
      { ...H, name: "NatWest kitchen loan", principal: 0, apr: 0, term_months: 120, status: "considering", notes: "TBC — £50k over 10y explored; links to Kitchen once it exists" },
    ]));
  }

  // Note: the "Christine → Partner uplift" salary_change can't be seeded —
  // salary_changes.flow_id is NOT NULL and we intentionally don't seed a fake
  // salary flow. The Salary changes section shows a hint to add it manually.

  let didSeed = inserts.length > 0;
  if (inserts.length) {
    const results = await Promise.all(inserts);
    results.forEach((r) => { if (r.error) console.error("seed:", r.error.message); });
  }

  // Projects need id resolution (kitchen line items FK the kitchen row), so
  // they seed sequentially rather than in the parallel batch above.
  if (state.projects.length === 0) {
    didSeed = true;
    const { data: projRows, error: pErr } = await HP.from("projects").insert([
      { ...H, name: "Garage finish (utility + storage)", category: "Structural", status: "In Progress",
        estimated_cost: 1500, target_start_month: "2026-07", duration_months: 2,
        priority: 4, budget_status: "estimate", notes: "TBC — placeholder" },
      { ...H, name: "Shed + concrete base", category: "Garden", status: "Planned",
        estimated_cost: 5500, target_start_month: "2026-08", duration_months: 2,
        priority: 3, budget_status: "estimate", notes: "TBC — placeholder" },
      { ...H, name: "Hallway flooring", category: "Cosmetic", status: "Planned",
        estimated_cost: 2000, target_start_month: "2026-09", duration_months: 1,
        priority: 2, budget_status: "estimate", notes: "TBC — placeholder" },
      { ...H, name: "Full kitchen reno", category: "Structural", status: "Quoted",
        estimated_cost: 45000, target_start_month: "2027-02", duration_months: 4,
        priority: 5, budget_status: "estimate", notes: "TBC — cost from NatWest loan work" },
    ]).select();
    if (pErr) console.error("seed projects:", pErr.message);

    const kitchen = (projRows || []).find((p) => p.name === "Full kitchen reno");
    if (kitchen) {
      // seed the kitchen with line items so sum→total behaviour shows on first open
      const items = [
        ["Units & worktops", 18000], ["Appliances", 6000], ["Install labour", 9000],
        ["Electrics & plumbing", 7000], ["Flooring & tiling", 5000],
      ].map(([name, cost], i) => ({
        ...H, project_id: kitchen.id, name, estimated_cost: cost,
        actual_cost: null, status: "quoted", sort_order: i, notes: "TBC",
      }));
      const { error: iErr } = await HP.from("project_items").insert(items);
      if (iErr) console.error("seed kitchen items:", iErr.message);
    }
  }

  if (didSeed) await loadAll();
}
