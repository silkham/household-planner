// ============================================================================
//  store.js — Supabase client, household resolution, state cache + CRUD.
//  All planner data lives in the `house_project` schema — use the HP handle.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    inserts.push(HP.from("life_events").insert([
      { ...H, name: "Christine mat leave 2", event_type: "income_change",  duration_months: 9, monthly_impact: 0, notes: "TBC" },
      { ...H, name: "Nursery starts",        event_type: "expense_change", monthly_impact: 0, notes: "TBC" },
      { ...H, name: "PCP ends on 2nd car",   event_type: "decision_point", resolved: false, notes: "TBC — options: keep + buy out / new PCP / lease / drop to one car" },
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

  if (inserts.length) {
    const results = await Promise.all(inserts);
    results.forEach((r) => { if (r.error) console.error("seed:", r.error.message); });
    await loadAll();
  }
}
