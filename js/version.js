// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.14.0";  // 1.14.0 = Spending month view now mirrors the forecast month row from ACTUALS: Net position, Income lines, Out grouped by known-bill category + General Expenses (vs budget), non-counting below — same carve-out as reconcile so the General figure is verifiable
export const BUILD_DATE  = "2026-07-08";
