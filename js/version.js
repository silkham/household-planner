// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.13.0";  // 1.13.0 = Recurring-flow frequencies: weekly/monthly/yearly + interval (recurring_flows.frequency/interval_n); engine spreads amounts per cadence (flowMonthFactor), reconcile respects cadence, detector infers it
export const BUILD_DATE  = "2026-07-08";
