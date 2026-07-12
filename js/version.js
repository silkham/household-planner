// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.18.0";  // 1.18.0 = Forecast "This month" card gains an "Other income" group (genuine non-salary, non-refund inflows) to match the Spending panel — so the card's income total tracks actuals, not just known flows + bonuses
export const BUILD_DATE  = "2026-07-09";
