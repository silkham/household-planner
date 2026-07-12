// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.20.0";  // 1.20.0 = project linking flows through the app: (A) link a merchant's payments to a project line item straight from the Spending categorise sheet; (B) Forecast "This month" carves project-linked txns out of General (budgeted under Projects); (C) Spending month panel gains a Projects section mirroring Forecast
export const BUILD_DATE  = "2026-07-12";
