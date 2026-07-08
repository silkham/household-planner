// ============================================================================
//  version.js — single source of truth for the app version.
//  No build step, so BUMP THESE BY HAND on each deploy (keep roughly in step
//  with the git history). Shown in Settings ▸ About and logged on boot, so you
//  can confirm which deployed build the browser actually loaded.
//    major.minor.patch — minor tracks a shipped phase, patch a fix/tweak.
// ============================================================================
export const APP_VERSION = "1.13.2";  // 1.13.2 = fix category re-tags "not sticking" — loadAll now pages past PostgREST's 1000-row cap (category_rules hit 1067 in Session 11, so newest rules were silently truncated and never loaded)
export const BUILD_DATE  = "2026-07-08";
