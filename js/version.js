// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.19.0";  // 1.19.0 = V1 close-out batch: (1) link project line items to real Emma transactions → item actual_cost = SUM(links) → forecast shrinks remaining project spend by what's hit; (2) one-tap best-guess category accept on the Spending "needs a category" prompt; (3) mobile viewport locked app-like (no pinch/double-tap zoom, no overscroll)
export const BUILD_DATE  = "2026-07-12";
