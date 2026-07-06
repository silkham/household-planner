// ============================================================================
//  engine.js — cashflow forecast.
//  STUB for Session 2: the real pure function (scenarios, uplifts, bonuses by
//  confidence, amortisation, life events) lands in Session 3 with Node tests.
//  Only the amortisation helper is real here — the Finances UI needs it now.
// ============================================================================

// Standard amortisation. Guards the 0% case (0% credit-card financing).
export function monthlyPayment({ principal = 0, apr = 0, term_months = 0 }) {
  const P = Number(principal) || 0;
  const n = Number(term_months) || 0;
  if (P <= 0 || n <= 0) return 0;
  const r = (Number(apr) || 0) / 12;
  if (r === 0) return P / n;
  const g = Math.pow(1 + r, n);
  return (P * (r * g)) / (g - 1);
}

// Placeholder so the sheet's live-impact slot has something to call.
// Returns an empty forecast; finances.js shows an honest "engine pending" note.
export function computeForecast(_input) {
  return { months: [], stub: true };
}
