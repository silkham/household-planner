// ============================================================================
//  emma.js — Emma integration (phase 1a): hybrid anchor balances.
//  Emma's Google-Sheet export is a transaction feed with NO current balances
//  (live-synced accounts only carry ~12 months of history). So each mapped
//  account's live balance is derived:
//      balance = anchor_balance + SUM(transactions dated AFTER anchor_date)
//  Reads happen through the emma-sheet Edge Function (the service-account key
//  stays server-side). The engine + Finances keep reading accounts.balance.
// ============================================================================
import { supa, HP, state, loadAll } from "./store.js";

// "M/D/YYYY" -> yyyymmdd int (comparable), or null
function usDateInt(s) {
  const p = String(s || "").split("/");
  if (p.length !== 3) return null;
  const mm = +p[0], dd = +p[1], yy = +p[2];
  if (!yy || !mm || !dd) return null;
  return yy * 10000 + mm * 100 + dd;
}
// "YYYY-MM-DD" -> yyyymmdd int, or null
function isoDateInt(s) {
  const p = String(s || "").split("-");
  if (p.length !== 3) return null;
  const y = +p[0], m = +p[1], d = +p[2];
  if (!y) return null;
  return y * 10000 + m * 100 + d;
}

// Fetch + parse the configured Emma tab into transaction objects.
// Returns { header, txns }. Cheap enough to call on demand.
export async function fetchEmma() {
  const s = state.settings || {};
  const sheetId = s.emma_sheet_id;
  const tab = s.emma_tab || "Mclean Household";
  if (!sheetId) throw new Error("No Emma sheet configured — set it in Settings.");

  const { data, error } = await supa.functions.invoke("emma-sheet", {
    body: { sheetId, tab },
  });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);

  const rows = (data && data.values) || [];
  if (!rows.length) return { header: [], txns: [] };
  const header = rows[0];
  const ix = {};
  header.forEach((h, i) => { ix[h] = i; });
  const get = (r, name) => (ix[name] != null && ix[name] < r.length ? r[ix[name]] : "");

  const txns = rows.slice(1).map((r) => ({
    date: get(r, "Date"),
    dateInt: usDateInt(get(r, "Date")),
    amount: parseFloat(String(get(r, "Amount") || "0").replace(/,/g, "")) || 0,
    account: get(r, "Account"),
    bank: get(r, "Bank"),
    category: get(r, "Category"),
    customName: get(r, "Custom Name"),
    merchant: get(r, "Merchant"),
    counterparty: get(r, "Counterparty"),
    type: get(r, "Type"),
  }));
  return { header, txns };
}

// Recompute balance for every Emma-mapped account and write it back.
// balance = anchor_balance + SUM(amount for that account, dated after anchor).
// Returns { updated, txnCount }.
export async function syncBalancesFromEmma() {
  const { txns } = await fetchEmma();
  const mapped = state.accounts.filter((a) => a.emma_account && a.anchor_balance != null);

  const writes = mapped.map((a) => {
    const anchorInt = isoDateInt(a.anchor_date);
    let delta = 0;
    for (const t of txns) {
      if (t.account !== a.emma_account) continue;
      // strictly after the anchor date — the anchor already includes that day
      if (anchorInt != null && (t.dateInt == null || t.dateInt <= anchorInt)) continue;
      delta += t.amount;
    }
    const balance = Math.round((Number(a.anchor_balance) + delta) * 100) / 100;
    return HP.from("accounts")
      .update({ balance, balance_updated_at: new Date().toISOString() })
      .eq("id", a.id);
  });

  const results = await Promise.all(writes);
  results.forEach((r) => { if (r.error) console.error("emma sync:", r.error.message); });
  await loadAll();
  return { updated: mapped.length, txnCount: txns.length };
}
