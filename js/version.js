// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.11.0";  // 1.11.0 = This-month Projects group in Forecast reconcile; chart-dot hover tooltip; Spending transaction search (all txns, incl. non-counting); +665-merchant category-rule import (live DB)
export const BUILD_DATE  = "2026-07-08";
