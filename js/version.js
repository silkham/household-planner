// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.11.2";  // 1.11.2 = forecast month breakdown "Out" list now grouped by category into collapsible dropdowns (engine breakdown items carry category)
export const BUILD_DATE  = "2026-07-08";
