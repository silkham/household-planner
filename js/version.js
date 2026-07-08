// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.11.5";  // 1.11.5 = Spending month breakdown shows non-counting buckets (Transfers/Excluded) below the counting ones, marked "not counted" & expandable, excluded from the "spent" total
export const BUILD_DATE  = "2026-07-08";
