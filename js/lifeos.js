// ============================================================================
//  lifeos.js — LifeOS publish adapter.
//  Pushes a small set of "signals" into the shared `lifeos.signals` table so the
//  LifeOS hub can show this app's headline numbers + to-dos without reaching into
//  the planner's own schema. Fire-and-forget; never blocks or breaks the app.
//
//  v1: forecast-derived metrics (synchronous, always available). Enriching with
//  Emma actual-vs-forecast (the "This month" reconcile) is a later pass.
// ============================================================================
import { supa, resolveHousehold, currentForecast } from "./store.js";

const LO  = supa.schema("lifeos");
const APP = "household";
const HUB = "https://silkham.github.io/household-planner/#/forecast";  // deep link

const gbp = (n) => {
  const v = Number(n) || 0, neg = v < 0, a = Math.abs(v);
  const s = a >= 1000 ? "£" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k" : "£" + a.toFixed(0);
  return (neg ? "−" : "") + s;
};

export async function publishToLifeOS() {
  try {
    const hid = await resolveHousehold();
    if (!hid) return;
    const fc = currentForecast();
    const m = fc.months && fc.months[0];
    if (!m) return;

    const negative = m.flags.includes("negative");
    const belowBuf = m.flags.includes("below_buffer");
    const netState = negative ? "bad" : belowBuf ? "warn" : "good";

    const rows = [
      {
        household_id: hid, app: APP, key: "month-net", kind: "metric",
        title: "This month", value: Math.round(m.net), unit: "gbp",
        detail: `${gbp(m.income)} in · ${gbp(m.expenses)} out`,
        state: netState, cta_url: HUB, cta_label: "Forecast", sort_order: 30,
      },
      {
        household_id: hid, app: APP, key: "cash", kind: "metric",
        title: "Projected cash", value: Math.round(m.cash), unit: "gbp",
        detail: `buffer ${gbp(fc.buffer)}`,
        state: m.cash < fc.buffer ? "warn" : "good",
        cta_url: HUB, cta_label: "Forecast", sort_order: 31,
      },
    ];

    await LO.from("signals").upsert(rows, { onConflict: "household_id,app,key" });
  } catch (e) {
    console.warn("LifeOS publish skipped:", e?.message || e);
  }
}
