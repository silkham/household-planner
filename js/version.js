// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.15.0";  // 1.15.0 = Spending month: recurring categories split out of General (matches forecast); investment transfers called out as "gone" (in Net); income = salary only, refunds/credits separated
export const BUILD_DATE  = "2026-07-08";
