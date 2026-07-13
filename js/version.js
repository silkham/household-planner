// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.21.0";  // 1.21.0 = V2 step 1: navigation + routing rework. New Home dashboard (three equal pillars — Forecast/Spending/Projects — each taps through), regrouped nav (Home + Plan/Spend/Set up) driven by one definition, mobile bottom nav (Home·Forecast·Spending·Projects) + a "More" grouped drawer, hash-based router (back button works; sub-route slot ready for project detail). Reports + Merchants added as stub screens. Tasks temporarily lives under Plan until it folds into Projects (step 2).
export const BUILD_DATE  = "2026-07-14";
