// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.20.1";  // 1.20.1 = (1) Emma self-heals a stale/expired session: on a 401 the emma-sheet call refreshes the session once and retries (fixes "Couldn't load Emma" after the iOS PWA sits idle); (2) Forecast "This month" Projects group is now a spend group (expected = this month's planned project cost, actual = linked payments that hit, progress bar + per-project paid/due lines) instead of just the remaining figure
export const BUILD_DATE  = "2026-07-13";
