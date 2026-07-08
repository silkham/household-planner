// ============================================================================
//  recurring.tests.js — unit tests for the Emma recurring-payment detector.
//  Import-free by design: run.sh concatenates js/recurring.js (imports dropped,
//  `export` stripped) ahead of this file, so detectRecurring is a global.
//  Runs under node OR osascript (JavaScriptCore) — see tests/run.sh.
// ============================================================================

let PASS = 0, FAIL = 0;
const log = (s) => (typeof console !== "undefined" ? console.log(s) : null);
function ok(cond, name) {
  if (cond) { PASS++; log("  ok   " + name); }
  else { FAIL++; log("  FAIL " + name); }
}
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- fixtures --------------------------------------------------------------
// yyyymmdd int for a given y/m/d
const di = (y, m, d) => y * 10000 + m * 100 + d;
const tx = (name, amount, dateInt, category = "Bills") =>
  ({ customName: name, amount, dateInt, category });

// n monthly charges of `amount`, one per month on `day`, starting y/m.
function monthly(name, amount, y, m, n, day = 15, category = "Bills") {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const mm = ((m - 1 + i) % 12) + 1;
    const yy = y + Math.floor((m - 1 + i) / 12);
    rows.push(tx(name, amount, di(yy, mm, day), category));
  }
  return rows;
}
const find = (list, key) => list.find((s) => s.key === key);
const MAX = di(2026, 8, 15);   // treat mid-Aug 2026 as "today" (feed's newest txn)

// ---- 1. a clean monthly expense is detected -------------------------------
{
  const txns = monthly("Mortgage", -1200, 2026, 2, 6);       // Feb–Jul 2026
  const res = detectRecurring(txns, { maxDate: MAX });
  const s = find(res, "Mortgage");
  ok(!!s, "monthly expense detected");
  if (s) {
    eq(s.kind, "expense", "expense kind");
    eq(s.amount, 1200, "median amount (magnitude)");
    eq(s.count, 6, "occurrence count");
    eq(s.months, 6, "distinct months");
    eq(s.firstMonth, "2026-02", "first month");
    eq(s.amountVaries, false, "steady amount → no varies flag");
  }
}

// ---- 2. a monthly inflow is detected as income ----------------------------
{
  const txns = monthly("Acme Payroll", 3000, 2026, 2, 6, 28, "Salary");
  const s = find(detectRecurring(txns, { maxDate: MAX }), "Acme Payroll");
  ok(!!s, "monthly income detected");
  if (s) { eq(s.kind, "income", "income kind"); eq(s.amount, 3000, "income amount"); }
}

// ---- 3. too few occurrences → not detected --------------------------------
{
  const txns = [tx("Rare", -50, di(2026, 3, 1)), tx("Rare", -50, di(2026, 4, 1))];
  eq(find(detectRecurring(txns, { maxDate: MAX }), "Rare"), undefined, "2 charges → not recurring");
}

// ---- 4. groceries (many per month) → not detected -------------------------
{
  const txns = [];
  for (let mth = 3; mth <= 6; mth++)               // 4 months
    for (let d = 1; d <= 8; d++)                    // 8 shops/month, varied amounts
      txns.push(tx("Tesco", -(20 + d * 3), di(2026, mth, d * 3), "Groceries"));
  eq(find(detectRecurring(txns, { maxDate: MAX }), "Tesco"), undefined, "bursty groceries → not recurring");
}

// ---- 5. cancelled subscription (stale) → not detected ---------------------
{
  const txns = monthly("OldSub", -9.99, 2026, 1, 4);   // Jan–Apr, last ~4mo before MAX
  eq(find(detectRecurring(txns, { maxDate: MAX }), "OldSub"), undefined, "stale/cancelled → not recurring");
}

// ---- 6. internal moves (Transfers/Excluded) are skipped -------------------
{
  const txns = monthly("CardPayment", -500, 2026, 2, 6, 15, "Transfers");
  eq(find(detectRecurring(txns, { maxDate: MAX }), "CardPayment"), undefined, "Transfers category skipped");
  const ex = monthly("Ignore", -500, 2026, 2, 6, 15, "Excluded");
  eq(find(detectRecurring(ex, { maxDate: MAX }), "Ignore"), undefined, "Excluded category skipped");
}

// ---- 7. already-linked key is suppressed ----------------------------------
{
  const txns = monthly("Mortgage", -1200, 2026, 2, 6);
  const res = detectRecurring(txns, { maxDate: MAX, existingKeys: new Set(["Mortgage"]) });
  eq(find(res, "Mortgage"), undefined, "existing emma_match_key suppressed");
}

// ---- 8. locally-dismissed key is suppressed -------------------------------
{
  const txns = monthly("Netflix", -10.99, 2026, 2, 6);
  const res = detectRecurring(txns, { maxDate: MAX, dismissed: new Set(["Netflix"]) });
  eq(find(res, "Netflix"), undefined, "dismissed suggestion suppressed");
}

// ---- 9. a variable-but-monthly bill flags amountVaries --------------------
{
  const amts = [-100, -140, -90, -130, -110, -150];
  const txns = amts.map((a, i) => tx("Energy", a, di(2026, 2 + i, 15), "Utilities"));
  const s = find(detectRecurring(txns, { maxDate: MAX }), "Energy");
  ok(!!s, "variable monthly bill still detected");
  if (s) eq(s.amountVaries, true, "spread > 25% → amountVaries flag");
}

// ---- 10. a category rule can re-bucket a merchant into a skipped category --
{
  const txns = monthly("Wise", -500, 2026, 2, 6, 15, "Bills");
  const rules = new Map([["Wise", "Transfers"]]);   // user marked it an internal move
  eq(find(detectRecurring(txns, { maxDate: MAX, rules }), "Wise"), undefined, "rule → Transfers → skipped");
}

// ---- 10b. a custom excluded set (managed categories) is honoured ----------
{
  const txns = monthly("Council Tax", -180, 2026, 2, 6, 15, "Bills");
  // household mapped this merchant to "Bills" and turned "Bills" off → not detected.
  // (Strict categorisation: exclusion works via the RULE'd category, not Emma's raw
  // one — an unmapped merchant is "Uncategorised" regardless of Emma's tag.)
  const rules = new Map([["Council Tax", "Bills"]]);
  const res = detectRecurring(txns, { maxDate: MAX, rules, excluded: new Set(["Bills"]) });
  eq(find(res, "Council Tax"), undefined, "excluded category (via rule) skips detection");
  // …unmapped, or without excluding Bills, it IS detected
  ok(!!find(detectRecurring(txns, { maxDate: MAX }), "Council Tax"), "unmapped merchant still detected");
}

// ---- 10c. strict: an unmapped internal-money txn still passes through -------
{
  // Emma tags a card payment "Transfer" (raw feed); no rule. It must stay excluded
  // by the default set even though we otherwise ignore Emma's category.
  const txns = monthly("CardPay", -400, 2026, 2, 6, 15, "Transfer");
  eq(find(detectRecurring(txns, { maxDate: MAX }), "CardPay"), undefined,
    "unmapped Emma 'Transfer' passes through → excluded");
}

// ---- 11. results sorted by monthly amount, largest first ------------------
{
  const txns = [
    ...monthly("Big", -1200, 2026, 2, 6),
    ...monthly("Small", -10, 2026, 2, 6),
    ...monthly("Mid", -300, 2026, 2, 6, 20),
  ];
  const res = detectRecurring(txns, { maxDate: MAX });
  eq(res.map((s) => s.key).join(","), "Big,Mid,Small", "sorted by amount desc");
}

// ---- 12. recurringByCategory: a merchant mapped Recurring-* is a candidate --
{
  const rules = new Map([["Netflix", "Recurring - Media"]]);
  const recurringCats = new Set(["Recurring - Media", "Recurring - Bills"]);
  const txns = monthly("Netflix", -11, 2026, 5, 3, 15, "Shopping"); // Emma miscat'd; rule wins
  const res = recurringByCategory(txns, { rules, recurringCats, maxDate: MAX });
  const s = find(res, "Netflix");
  ok(!!s, "Recurring-tagged merchant surfaced by category");
  if (s) {
    eq(s.category, "Recurring - Media", "keeps its Recurring category");
    eq(s.amount, 11, "monthly amount = median charge");
    eq(s.source, "category", "tagged source");
    eq(s.stale, false, "recent → not stale");
  }
}

// ---- 12b. a Recurring merchant gone quiet is flagged stale (not hidden) -----
{
  const rules = new Map([["OldGym", "Recurring - Bills"]]);
  const recurringCats = new Set(["Recurring - Bills"]);
  const txns = monthly("OldGym", -40, 2026, 1, 3, 15, "Bills");   // Jan–Mar, silent since
  const s = find(recurringByCategory(txns, { rules, recurringCats, maxDate: MAX }), "OldGym");
  ok(!!s, "cancelled recurring still listed for review");
  eq(s && s.stale, true, "…but flagged stale (last seen far from feed end)");
}

// ---- 12c. non-recurring category + already-added are excluded --------------
{
  const rules = new Map([["Tesco", "Groceries"], ["Spotify", "Recurring - Media"]]);
  const recurringCats = new Set(["Recurring - Media"]);
  const txns = [...monthly("Tesco", -50, 2026, 5, 3), ...monthly("Spotify", -10, 2026, 5, 3)];
  const res = recurringByCategory(txns, { rules, recurringCats, maxDate: MAX });
  eq(find(res, "Tesco"), undefined, "non-recurring category not surfaced");
  const added = recurringByCategory(txns, { rules, recurringCats, maxDate: MAX, existingKeys: new Set(["Spotify"]) });
  eq(find(added, "Spotify"), undefined, "already-added flow suppressed");
}

// ---- summary ---------------------------------------------------------------
log(`\nrecurring: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0 && typeof process !== "undefined") process.exit(1);
