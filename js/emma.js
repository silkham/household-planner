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
import { effectiveCategory } from "./categories.js";

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
// Returns { header, txns }. Result is memoised so the Spending tab, recurring
// detection and balance sync share ONE Edge Function call — pass force=true to
// refresh (Spending's Refresh button + syncBalancesFromEmma do).
let _feedCache = null;
export function clearEmmaCache() { _feedCache = null; }
// Synchronous peek at the already-fetched feed (empty until fetchEmma runs).
// Lets option-lists reuse the memoised txns without going async.
export function cachedEmmaTxns() { return (_feedCache && _feedCache.txns) || []; }

// Post-fetch hooks — run (fire-and-forget) after every REAL feed fetch, with
// the fresh txns. Lets other modules react to a new feed without emma.js having
// to import them (avoids a cycle). Used by projects.js to heal project links
// whose Emma id churned when a pending txn posted.
const _onLoaded = [];
export function onFeedLoaded(cb) { _onLoaded.push(cb); }
function _fireFeedLoaded(txns) {
  for (const cb of _onLoaded) { try { Promise.resolve(cb(txns)).catch(() => {}); } catch {} }
}

// Invoke the emma-sheet function, self-healing a stale/expired session.
// Supabase access tokens last ~1h and iOS PWAs suspend the background refresh,
// so a foregrounded app can send an expired token → the function's
// requireMember returns 401 ("Couldn't load Emma"). On a 401 we refresh the
// session once and retry; if it still fails, the refresh token is dead too and
// the user must sign in again.
async function invokeEmma(body) {
  const call = () => supa.functions.invoke("emma-sheet", { body });
  let { data, error } = await call();
  if (error && error.context && error.context.status === 401) {
    const { error: rErr } = await supa.auth.refreshSession();
    if (!rErr) ({ data, error } = await call());
    if (error && error.context && error.context.status === 401)
      throw new Error("Session expired — reload the app or sign in again.");
  }
  return { data, error };
}

export async function fetchEmma(force = false) {
  if (_feedCache && !force) return _feedCache;
  const s = state.settings || {};
  const sheetId = s.emma_sheet_id;
  const tab = s.emma_tab || "Mclean Household";
  if (!sheetId) throw new Error("No Emma sheet configured — set it in Settings.");

  const { data, error } = await invokeEmma({ sheetId, tab });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);

  const rows = (data && data.values) || [];
  if (!rows.length) return { header: [], txns: [] };
  const header = rows[0];
  const ix = {};
  header.forEach((h, i) => { ix[h] = i; });
  const get = (r, name) => (ix[name] != null && ix[name] < r.length ? r[ix[name]] : "");

  const txns = rows.slice(1).map((r) => ({
    id: get(r, "ID"),
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
  _feedCache = { header, txns };
  _fireFeedLoaded(txns);
  return _feedCache;
}

// Recompute balance for every Emma-mapped account and write it back.
// balance = anchor_balance + SUM(amount for that account, dated after anchor).
// Returns { updated, txnCount }.
export async function syncBalancesFromEmma() {
  const { txns } = await fetchEmma(true);  // force a fresh pull on explicit sync
  const rules = new Map(state.category_rules.map((r) => [r.match_key, r.category]));

  // Emma-fed accounts: balance = anchor + SUM(own-account txns after anchor).
  const emmaMapped = state.accounts.filter((a) => a.emma_account && a.anchor_balance != null);
  // Contribution-fed accounts (investments/savings with no feed of their own):
  // balance = anchor + SUM(−amount for txns whose effective category matches).
  // A transfer OUT of a current account is a −£ txn there, so −amount tops this
  // account up; a withdrawal (+£ in the current feed) nets back out. Multi-field
  // category matching means a single re-tag of the transfer merchant sticks.
  const contribMapped = state.accounts.filter(
    (a) => a.contrib_category && !a.emma_account && a.anchor_balance != null);

  const afterAnchor = (a, t) => {
    const anchorInt = isoDateInt(a.anchor_date);
    return anchorInt == null || (t.dateInt != null && t.dateInt > anchorInt);
  };
  const commit = (a, delta) => HP.from("accounts")
    .update({ balance: Math.round((Number(a.anchor_balance) + delta) * 100) / 100,
              balance_updated_at: new Date().toISOString() })
    .eq("id", a.id);

  const writes = [];
  for (const a of emmaMapped) {
    let delta = 0;
    for (const t of txns)
      if (t.account === a.emma_account && afterAnchor(a, t)) delta += t.amount;
    writes.push(commit(a, delta));
  }
  for (const a of contribMapped) {
    let delta = 0;
    for (const t of txns)
      if (afterAnchor(a, t) && effectiveCategory(t, rules) === a.contrib_category) delta += -t.amount;
    writes.push(commit(a, delta));
  }

  const results = await Promise.all(writes);
  results.forEach((r) => { if (r.error) console.error("emma sync:", r.error.message); });
  await loadAll();
  return { updated: emmaMapped.length + contribMapped.length, txnCount: txns.length };
}
